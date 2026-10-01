import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import type {
  AutomationKind,
  AutomationRunSummary,
  StoredAutomation,
} from "@getpaseo/protocol/automation/types";
import type { ScheduleService } from "../schedule/service.js";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { WebhookService } from "../webhook/service.js";
import type { StoredWebhook } from "@getpaseo/protocol/webhook/types";
import { renderWebhookTemplate } from "../webhook/template.js";
import { AutomationClaimStore } from "./claim-store.js";
import { PollAutomationStore, type StoredPollAutomation } from "./poll-store.js";
import {
  buildEventDraft,
  GITHUB_POLL_EVENTS,
  LINEAR_POLL_EVENTS,
  githubAppearedEvent,
  githubEventKey,
  linearEventKey,
  matchGithubItem,
  matchLinearItem,
  normalizeActorList,
  normalizeRepoList,
  normalizeStringList,
  type GithubPollItem,
  type LinearPollItem,
  type PollFilter,
} from "./poll-matching.js";
import {
  githubAuthenticated,
  githubCliPresent,
  listGithubIssues,
  listGithubPrs,
} from "./github-source.js";
import { linearConfigured, listLinearRecentIssues } from "./linear-source.js";
import { loadPersistedConfig } from "../persisted-config.js";

const DEFAULT_POLL_INTERVAL_SEC = 300;
const MIN_POLL_INTERVAL_SEC = 60;
const MAX_RECENT_RUNS_LIST = 5;
const MAX_RECENT_RUNS_INSPECT = 50;
const POLL_ITEM_LIMIT = 50;
const LINEAR_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export interface AutomationServiceOptions {
  paseoHome: string;
  logger: Logger;
  scheduleService: ScheduleService;
  webhookService: WebhookService | null;
  onChanged?: (input: { automationId: string; kind: string }) => void;
  now?: () => Date;
}

export interface CreateAutomationInput {
  name?: string | null;
  kind: AutomationKind;
  target: StoredAutomation["target"];
  promptTemplate: string;
  schedule?: {
    cadence: StoredAutomation["schedule"] extends never ? never : StoredSchedule["cadence"];
  };
  webhook?: { auth?: StoredWebhook["auth"]; filter?: StoredWebhook["filter"] };
  poll?: {
    repos?: string[];
    events?: string[];
    labels?: string[];
    actors?: string[];
    pollIntervalSec?: number;
    token?: string | null;
  };
}

export interface UpdateAutomationInput {
  automationId: string;
  name?: string | null;
  enabled?: boolean;
  target?: StoredAutomation["target"];
  promptTemplate?: string;
  schedule?: { cadence: StoredSchedule["cadence"] };
  webhook?: { auth?: StoredWebhook["auth"]; filter?: StoredWebhook["filter"] };
  poll?: {
    repos?: string[];
    events?: string[];
    labels?: string[];
    actors?: string[];
    pollIntervalSec?: number;
    token?: string | null;
  };
}

interface AutomationRef {
  owner: "schedule" | "webhook" | "poll";
  id: string;
}

function trimName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function normalizePromptTemplate(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Automation prompt template is required");
  return trimmed;
}

function clampPollInterval(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_SEC) {
    throw new Error(`pollIntervalSec must be an integer >= ${MIN_POLL_INTERVAL_SEC}`);
  }
  return value;
}

function validateGithubEvents(events: string[]): void {
  const allowed = new Set<string>(GITHUB_POLL_EVENTS);
  for (const event of events) {
    if (!allowed.has(event)) throw new Error(`Unknown GitHub poll event: ${event}`);
  }
}

function validateLinearEvents(events: string[]): void {
  const allowed = new Set<string>(LINEAR_POLL_EVENTS);
  for (const event of events) {
    if (!allowed.has(event)) throw new Error(`Unknown Linear poll event: ${event}`);
  }
}

function scheduleRunsToSummaries(schedule: StoredSchedule): AutomationRunSummary[] {
  return [...schedule.runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => ({
      id: run.id,
      trigger: "schedule",
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status: run.status,
      agentId: run.agentId,
      workspaceId: run.workspaceId ?? null,
      error: run.error,
    }));
}

function webhookDeliveriesToSummaries(webhook: StoredWebhook): AutomationRunSummary[] {
  return [...webhook.deliveries]
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .map((delivery) => {
      let status: AutomationRunSummary["status"];
      if (delivery.status === "fired") status = "succeeded";
      else if (delivery.status === "skipped") status = "skipped";
      else if (delivery.status === "rejected") status = "rejected";
      else status = "failed";
      return {
        id: delivery.id,
        trigger: "webhook",
        startedAt: delivery.receivedAt,
        endedAt: delivery.receivedAt,
        status,
        agentId: delivery.agentId,
        workspaceId: delivery.workspaceId,
        error: delivery.error,
      };
    });
}

export class AutomationService {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly schedules: ScheduleService;
  private readonly webhooks: WebhookService | null;
  private readonly polls: PollAutomationStore;
  private readonly claims: Promise<AutomationClaimStore>;
  private readonly onChanged: (input: { automationId: string; kind: string }) => void;
  private readonly now: () => Date;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  constructor(options: AutomationServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "automation-service" });
    this.schedules = options.scheduleService;
    this.webhooks = options.webhookService;
    this.polls = new PollAutomationStore(
      join(options.paseoHome, "automations"),
      join(options.paseoHome, "automations", "secrets"),
    );
    this.claims = AutomationClaimStore.open({
      dbPath: join(options.paseoHome, "automations", "claims.db"),
      execMkdir: (dir: string) => mkdir(dir, { recursive: true }).then(() => undefined),
      dirname,
      logger: this.logger,
    });
    this.onChanged = options.onChanged ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.pollTimer) return;
    const timer = setInterval(() => {
      void this.pollTick().catch((error) => {
        this.logger.error({ err: error }, "Automation poll tick failed");
      });
    }, MIN_POLL_INTERVAL_SEC * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pollTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---- CRUD (facade) -------------------------------------------------------

  async list(limit = MAX_RECENT_RUNS_LIST): Promise<StoredAutomation[]> {
    const [schedules, webhooks, polls] = await Promise.all([
      this.schedules.list(),
      this.webhooks ? this.webhooks.list() : Promise.resolve([]),
      this.polls.list(),
    ]);
    const out: StoredAutomation[] = [];
    for (const schedule of schedules) {
      out.push({
        id: `schedule:${schedule.id}`,
        name: schedule.name,
        kind: "schedule",
        enabled: schedule.status === "active",
        target: schedule.target,
        promptTemplate: schedule.prompt,
        schedule: {
          cadence: schedule.cadence,
          status: schedule.status,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
        },
        recentRuns: scheduleRunsToSummaries(schedule).slice(0, limit),
        createdAt: schedule.createdAt,
        updatedAt: schedule.updatedAt,
      });
    }
    if (this.webhooks) {
      const full = await Promise.all(webhooks.map((hook) => this.webhooks!.inspect(hook.id)));
      for (const webhook of full) {
        if (!webhook) continue;
        out.push({
          id: `webhook:${webhook.id}`,
          name: webhook.name,
          kind: "webhook",
          enabled: webhook.enabled,
          target: webhook.target,
          promptTemplate: webhook.promptTemplate,
          webhook: {
            secret: webhook.secret,
            auth: webhook.auth,
            filter: webhook.filter,
            lastFiredAt: webhook.lastFiredAt,
          },
          recentRuns: webhookDeliveriesToSummaries(webhook).slice(0, limit),
          createdAt: webhook.createdAt,
          updatedAt: webhook.updatedAt,
        });
      }
    }
    for (const { record, hasToken } of polls) {
      out.push(this.toStoredPoll(record, hasToken, limit));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(input: CreateAutomationInput): Promise<StoredAutomation> {
    const promptTemplate = normalizePromptTemplate(input.promptTemplate);
    if (input.kind === "schedule") {
      if (!input.schedule) throw new Error("schedule automation requires a cadence");
      const created = await this.schedules.create({
        name: input.name ?? null,
        prompt: promptTemplate,
        cadence: input.schedule.cadence,
        target: input.target,
      });
      const stored = await this.inspect(`schedule:${created.id}`, MAX_RECENT_RUNS_INSPECT);
      this.onChanged({ automationId: `schedule:${created.id}`, kind: "schedule" });
      if (!stored) throw new Error("Schedule not found after create");
      return stored;
    }
    if (input.kind === "webhook") {
      const service = this.requireWebhooks();
      const created = await service.create({
        name: input.name ?? null,
        target: input.target,
        promptTemplate,
        auth: input.webhook?.auth ?? null,
        filter: input.webhook?.filter ?? null,
      });
      const stored = await this.inspect(`webhook:${created.id}`, MAX_RECENT_RUNS_INSPECT);
      this.onChanged({ automationId: `webhook:${created.id}`, kind: "webhook" });
      if (!stored) throw new Error("Webhook not found after create");
      return stored;
    }
    return this.createPoll(input.kind, {
      name: trimName(input.name),
      target: input.target,
      promptTemplate,
      repos: normalizeRepoList(input.poll?.repos),
      events: normalizeStringList(input.poll?.events),
      labels: normalizeStringList(input.poll?.labels),
      actors: normalizeActorList(input.poll?.actors),
      pollIntervalSec: clampPollInterval(input.poll?.pollIntervalSec, this.defaultPollInterval()),
      token: input.poll?.token ?? null,
    });
  }

  async inspect(
    automationId: string,
    limit = MAX_RECENT_RUNS_INSPECT,
  ): Promise<StoredAutomation | null> {
    const ref = parseRef(automationId);
    if (!ref) return null;
    if (ref.owner === "schedule") {
      try {
        const schedule = await this.schedules.inspect(ref.id);
        return {
          id: automationId,
          name: schedule.name,
          kind: "schedule",
          enabled: schedule.status === "active",
          target: schedule.target,
          promptTemplate: schedule.prompt,
          schedule: {
            cadence: schedule.cadence,
            status: schedule.status,
            nextRunAt: schedule.nextRunAt,
            lastRunAt: schedule.lastRunAt,
          },
          recentRuns: scheduleRunsToSummaries(schedule).slice(0, limit),
          createdAt: schedule.createdAt,
          updatedAt: schedule.updatedAt,
        };
      } catch {
        return null;
      }
    }
    if (ref.owner === "webhook") {
      if (!this.webhooks) return null;
      const webhook = await this.webhooks.inspect(ref.id);
      if (!webhook) return null;
      return {
        id: automationId,
        name: webhook.name,
        kind: "webhook",
        enabled: webhook.enabled,
        target: webhook.target,
        promptTemplate: webhook.promptTemplate,
        webhook: {
          secret: webhook.secret,
          auth: webhook.auth,
          filter: webhook.filter,
          lastFiredAt: webhook.lastFiredAt,
        },
        recentRuns: webhookDeliveriesToSummaries(webhook).slice(0, limit),
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
      };
    }
    const found = await this.polls.get(ref.id);
    if (!found) return null;
    return this.toStoredPoll(found.record, found.hasToken, limit);
  }

  async update(input: UpdateAutomationInput): Promise<StoredAutomation | null> {
    const ref = parseRef(input.automationId);
    if (!ref) throw new Error(`Unknown automation: ${input.automationId}`);
    if (ref.owner === "schedule") return this.updateSchedule(input.automationId, ref.id, input);
    if (ref.owner === "webhook") return this.updateWebhook(input.automationId, ref.id, input);
    return this.updatePoll(input.automationId, ref.id, input);
  }

  private async updateSchedule(
    automationId: string,
    scheduleId: string,
    input: UpdateAutomationInput,
  ): Promise<StoredAutomation | null> {
    const current = await this.schedules.inspect(scheduleId);
    if (input.target !== undefined && input.target.type !== current.target.type) {
      throw new Error("Automation target type is immutable");
    }
    if (input.enabled !== undefined) {
      if (input.enabled) await this.schedules.resume(scheduleId);
      else await this.schedules.pause(scheduleId);
    }
    await this.schedules.update({
      id: scheduleId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.promptTemplate !== undefined ? { prompt: input.promptTemplate } : {}),
      ...(input.schedule !== undefined ? { cadence: input.schedule.cadence } : {}),
    });
    this.onChanged({ automationId, kind: "schedule" });
    return this.inspect(automationId);
  }

  private async updateWebhook(
    automationId: string,
    webhookId: string,
    input: UpdateAutomationInput,
  ): Promise<StoredAutomation | null> {
    const service = this.requireWebhooks();
    if (input.schedule !== undefined) throw new Error("schedule input does not apply to webhooks");
    const updated = await service.update({
      id: webhookId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.promptTemplate !== undefined ? { promptTemplate: input.promptTemplate } : {}),
      ...(input.webhook?.auth !== undefined ? { auth: input.webhook.auth } : {}),
      ...(input.webhook?.filter !== undefined ? { filter: input.webhook.filter } : {}),
    });
    void updated;
    this.onChanged({ automationId, kind: "webhook" });
    return this.inspect(automationId);
  }

  private async updatePoll(
    automationId: string,
    pollId: string,
    input: UpdateAutomationInput,
  ): Promise<StoredAutomation | null> {
    const found = await this.polls.get(pollId);
    if (!found) return null;
    const provider = found.record.provider;
    const updated = await this.polls.update(
      pollId,
      (record) => {
        const next: StoredPollAutomation = { ...record, updatedAt: this.now().toISOString() };
        if (input.name !== undefined) next.name = trimName(input.name);
        if (input.enabled !== undefined) next.enabled = input.enabled;
        if (input.target !== undefined) {
          if (input.target.type !== next.target.type) {
            throw new Error("Automation target type is immutable");
          }
          next.target = input.target;
        }
        if (input.promptTemplate !== undefined) {
          next.promptTemplate = normalizePromptTemplate(input.promptTemplate);
        }
        if (input.poll?.repos !== undefined) next.repos = normalizeRepoList(input.poll.repos);
        if (input.poll?.events !== undefined) {
          const events = normalizeStringList(input.poll.events);
          if (provider === "github") validateGithubEvents(events);
          else validateLinearEvents(events);
          next.events = events;
        }
        if (input.poll?.labels !== undefined) next.labels = normalizeStringList(input.poll.labels);
        if (input.poll?.actors !== undefined) next.actors = normalizeActorList(input.poll.actors);
        if (input.poll?.pollIntervalSec !== undefined) {
          next.pollIntervalSec = clampPollInterval(
            input.poll.pollIntervalSec,
            next.pollIntervalSec,
          );
        }
        return next;
      },
      input.poll && "token" in input.poll ? (input.poll.token ?? null) : undefined,
    );
    if (!updated) return null;
    if (input.enabled === true) {
      // Re-seed the baseline so enabling never backfills history.
      await this.seedBaseline(updated).catch((error) => {
        this.logger.warn({ err: error, automationId }, "Baseline re-seed failed");
      });
    }
    this.onChanged({ automationId, kind: provider });
    return this.inspect(automationId);
  }

  async delete(automationId: string): Promise<void> {
    const ref = parseRef(automationId);
    if (!ref) throw new Error(`Unknown automation: ${automationId}`);
    if (ref.owner === "schedule") {
      await this.schedules.delete(ref.id);
      this.onChanged({ automationId, kind: "schedule" });
      return;
    }
    if (ref.owner === "webhook") {
      await this.requireWebhooks().delete(ref.id);
      this.onChanged({ automationId, kind: "webhook" });
      return;
    }
    await this.polls.delete(ref.id);
    (await this.claims).dropAutomation(ref.id);
    this.onChanged({ automationId, kind: "poll" });
  }

  async run(automationId: string, samplePayload?: string): Promise<AutomationRunSummary | null> {
    const ref = parseRef(automationId);
    if (!ref) throw new Error(`Unknown automation: ${automationId}`);
    if (ref.owner === "schedule") {
      const ran = await this.schedules.runOnce(ref.id);
      const summary = scheduleRunsToSummaries(ran)[0] ?? null;
      this.onChanged({ automationId, kind: "schedule" });
      return summary;
    }
    if (ref.owner === "webhook") {
      const result = await this.requireWebhooks().test(ref.id, samplePayload);
      this.onChanged({ automationId, kind: "webhook" });
      if (!result.delivery) return null;
      return {
        id: result.delivery.id,
        trigger: "webhook",
        startedAt: result.delivery.receivedAt,
        endedAt: result.delivery.receivedAt,
        status: result.delivery.status === "fired" ? "succeeded" : "failed",
        agentId: result.delivery.agentId,
        workspaceId: result.delivery.workspaceId,
        error: result.delivery.error,
      };
    }
    const fired = await this.pollOnce(ref.id);
    this.onChanged({ automationId, kind: "poll" });
    return fired[0] ?? null;
  }

  async status(): Promise<{
    github: { cliPresent: boolean; authenticated: boolean };
    linear: { configured: boolean };
    claimsDurable: boolean;
  }> {
    const [cliPresent, linearKey] = await Promise.all([
      githubCliPresent().catch(() => false),
      Promise.resolve(this.linearApiKey()),
    ]);
    const authenticated = cliPresent
      ? await githubAuthenticated(this.paseoHome).catch(() => false)
      : false;
    return {
      github: { cliPresent, authenticated },
      linear: { configured: linearConfigured(linearKey) },
      claimsDurable: (await this.claims).durable,
    };
  }

  /** Immediate tick for one poll automation (run-now). No backfill. */
  async pollOnce(automationId: string): Promise<AutomationRunSummary[]> {
    const found = await this.polls.get(automationId);
    if (!found || !found.record.enabled) return [];
    return this.firePollAutomation(found.record);
  }

  /** Daemon tick: every enabled poll automation whose interval elapsed. */
  async pollTick(now = this.now()): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const polls = await this.polls.list();
      for (const { record } of polls) {
        if (!record.enabled) continue;
        const last = record.lastCheckedAt ? Date.parse(record.lastCheckedAt) : 0;
        if (now.getTime() - last < record.pollIntervalSec * 1000) continue;
        try {
          await this.firePollAutomation(record, now);
          await this.polls.update(record.id, (current) => ({
            ...current,
            lastCheckedAt: now.toISOString(),
            lastError: null,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn({ err: error, automationId: record.id }, "Poll automation tick failed");
          await this.polls
            .update(record.id, (current) => ({
              ...current,
              lastCheckedAt: now.toISOString(),
              lastError: message.slice(0, 500),
            }))
            .catch(() => {});
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  // ---- Poll internals ------------------------------------------------------

  private requireWebhooks(): WebhookService {
    if (!this.webhooks) throw new Error("Webhooks are not enabled on this host");
    return this.webhooks;
  }

  private defaultPollInterval(): number {
    try {
      const persisted = loadPersistedConfig(this.paseoHome);
      const value = (persisted as { automations?: { defaultPollIntervalSec?: unknown } })
        .automations?.defaultPollIntervalSec;
      if (typeof value === "number" && Number.isInteger(value) && value >= MIN_POLL_INTERVAL_SEC) {
        return value;
      }
    } catch {
      // Fall through to the default.
    }
    return DEFAULT_POLL_INTERVAL_SEC;
  }

  private linearApiKey(): string | null {
    const env = process.env.PASEO_LINEAR_API_KEY?.trim();
    if (env) return env;
    try {
      const persisted = loadPersistedConfig(this.paseoHome);
      const value = (persisted as { automations?: { linearApiKey?: unknown } }).automations
        ?.linearApiKey;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }

  private toStoredPoll(
    record: StoredPollAutomation,
    hasToken: boolean,
    limit: number,
  ): StoredAutomation {
    return {
      id: `poll:${record.id}`,
      name: record.name,
      kind: record.provider,
      enabled: record.enabled,
      target: record.target,
      promptTemplate: record.promptTemplate,
      poll: {
        provider: record.provider,
        repos: record.repos,
        events: record.events,
        labels: record.labels,
        actors: record.actors,
        pollIntervalSec: record.pollIntervalSec,
        lastCheckedAt: record.lastCheckedAt,
        lastError: record.lastError,
        hasToken,
      },
      recentRuns: record.recentRuns.slice(0, limit),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async createPoll(
    kind: AutomationKind,
    input: {
      name: string | null;
      target: StoredAutomation["target"];
      promptTemplate: string;
      repos: string[];
      events: string[];
      labels: string[];
      actors: string[];
      pollIntervalSec: number;
      token: string | null;
    },
  ): Promise<StoredAutomation> {
    const provider = kind === "github" || kind === "linear" ? kind : null;
    if (!provider) throw new Error(`Poll automation requires kind github|linear, got ${kind}`);
    if (provider === "github") validateGithubEvents(input.events);
    else validateLinearEvents(input.events);
    const now = this.now().toISOString();
    const record = await this.polls.create(
      {
        name: input.name,
        provider,
        enabled: true,
        target: input.target,
        promptTemplate: input.promptTemplate,
        repos: input.repos,
        events: input.events,
        labels: input.labels,
        actors: input.actors,
        pollIntervalSec: input.pollIntervalSec,
        lastCheckedAt: null,
        lastError: null,
        recentRuns: [],
        createdAt: now,
        updatedAt: now,
      },
      input.token,
    );
    // Seed claims for currently-matching items so `opened`/`created` never
    // backfills history that predates the automation.
    await this.seedBaseline(record).catch((error) => {
      this.logger.warn({ err: error, automationId: record.id }, "Poll baseline seed failed");
    });
    const stored = await this.inspect(`poll:${record.id}`, MAX_RECENT_RUNS_INSPECT);
    this.onChanged({ automationId: `poll:${record.id}`, kind: provider });
    if (!stored) throw new Error("Poll automation not found after create");
    return stored;
  }

  private async seedBaseline(record: StoredPollAutomation): Promise<void> {
    const claims = await this.claims;
    const nowMs = this.now().getTime();
    for (const key of await this.currentEventKeys(record)) {
      claims.claim(record.id, key, nowMs);
    }
    await this.polls.update(record.id, (current) => ({
      ...current,
      lastCheckedAt: this.now().toISOString(),
    }));
  }

  private async currentEventKeys(record: StoredPollAutomation): Promise<string[]> {
    const keys: string[] = [];
    if (record.provider === "github") {
      for (const item of await this.fetchGithubItems(record)) {
        const matched = matchGithubItem(filterOf(record), item.repo, item.item);
        if (matched) keys.push(...matched.eventKeys);
      }
      return keys;
    }
    for (const item of await this.fetchLinearItems(record)) {
      const matched = matchLinearItem(filterOf(record), item);
      if (matched) keys.push(...matched.eventKeys);
    }
    return keys;
  }

  private async fetchGithubItems(
    record: StoredPollAutomation,
  ): Promise<Array<{ repo: string; item: GithubPollItem }>> {
    const token = await this.polls.getToken(record.id);
    const repos = record.repos.length > 0 ? record.repos : await this.defaultGithubRepos();
    const out: Array<{ repo: string; item: GithubPollItem }> = [];
    for (const repo of repos) {
      const [issues, prs] = await Promise.all([
        listGithubIssues(repo, { cwd: this.paseoHome, token }, POLL_ITEM_LIMIT).catch(() => []),
        listGithubPrs(repo, { cwd: this.paseoHome, token }, POLL_ITEM_LIMIT).catch(() => []),
      ]);
      for (const issue of issues) {
        out.push({
          repo: repo.toLowerCase(),
          item: {
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
            body: issue.body,
            labels: issue.labels,
            author: issue.author,
            draft: false,
            updatedAt: issue.updatedAt,
          },
        });
      }
      for (const pr of prs) {
        out.push({
          repo: repo.toLowerCase(),
          item: {
            kind: "pr",
            number: pr.number,
            title: pr.title,
            url: pr.url,
            body: pr.body,
            labels: pr.labels,
            author: pr.author,
            draft: pr.isDraft,
            updatedAt: pr.updatedAt,
          },
        });
      }
    }
    return out;
  }

  private async defaultGithubRepos(): Promise<string[]> {
    // Without a repos filter the poller cannot scope `gh` queries; report the
    // miss as the automation's lastError instead of failing silently.
    throw new Error("GitHub poll automation requires at least one repo (owner/name)");
  }

  private async fetchLinearItems(record: StoredPollAutomation): Promise<LinearPollItem[]> {
    const token = (await this.polls.getToken(record.id)) ?? this.linearApiKey();
    if (!token) throw new Error("Linear poll automation requires an API key");
    const issues = await listLinearRecentIssues({ apiKey: token }, POLL_ITEM_LIMIT);
    const cutoff = this.now().getTime() - LINEAR_FRESHNESS_MS;
    return issues
      .filter((issue) => {
        const created = Date.parse(issue.createdAt);
        return Number.isFinite(created) && created >= cutoff;
      })
      .map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        body: issue.body,
        labels: issue.labels,
        author: issue.author,
        assignees: issue.assignees,
        teamKey: issue.teamKey,
        teamName: issue.teamName,
        updatedAt: issue.updatedAt,
      }));
  }

  private async firePollAutomation(
    record: StoredPollAutomation,
    now = this.now(),
  ): Promise<AutomationRunSummary[]> {
    const webhooks = this.requireWebhooks();
    const claims = await this.claims;
    const filter = filterOf(record);
    const fired: AutomationRunSummary[] = [];
    // Mirror the webhook rate guard so a label-storm or a busy repo can't
    // fork-bomb the daemon: 60 fires per automation per minute, then skip.
    const fireTimestamps = this.pollFireTimestamps.get(record.id) ?? [];
    const windowStart = now.getTime() - 60_000;
    const recent = fireTimestamps.filter((timestamp) => timestamp >= windowStart);
    const fire = async (input: {
      event: string;
      eventKey: string;
      payload: Record<string, unknown>;
      draft: string;
    }): Promise<void> => {
      if (!claims.claim(record.id, input.eventKey, now.getTime())) return;
      if (recent.length >= 60) {
        await this.appendRun(record.id, {
          id: randomUUID(),
          trigger: input.event,
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          status: "rejected",
          agentId: null,
          workspaceId: null,
          error: "rate limited",
          eventKey: input.eventKey,
        });
        return;
      }
      const rendered = renderWebhookTemplate(record.promptTemplate, {
        payload: input.payload,
        headers: {},
        query: {},
        raw: JSON.stringify(input.payload),
      }).trim();
      const prompt = `${rendered}\n\n${input.draft}`.trim();
      if (!prompt) {
        await this.appendRun(record.id, {
          id: randomUUID(),
          trigger: input.event,
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          status: "failed",
          agentId: null,
          workspaceId: null,
          error: "rendered prompt is empty",
          eventKey: input.eventKey,
        });
        return;
      }
      const runId = randomUUID();
      try {
        const launched = await webhooks.launchTarget({
          target: record.target,
          prompt,
          labels: {
            "paseo.automation-id": `poll:${record.id}`,
            "paseo.automation-event": input.eventKey,
          },
          onAgentId: () => Promise.resolve(),
        });
        recent.push(now.getTime());
        this.pollFireTimestamps.set(record.id, recent);
        const summary: AutomationRunSummary = {
          id: runId,
          trigger: input.event,
          startedAt: now.toISOString(),
          endedAt: null,
          status: "running",
          agentId: launched.agentId,
          workspaceId: launched.workspaceId,
          error: null,
          eventKey: input.eventKey,
        };
        await this.appendRun(record.id, summary);
        fired.push(summary);
      } catch (error) {
        const summary: AutomationRunSummary = {
          id: runId,
          trigger: input.event,
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          status: "failed",
          agentId: null,
          workspaceId: null,
          error: error instanceof Error ? error.message : String(error),
          eventKey: input.eventKey,
        };
        await this.appendRun(record.id, summary);
        fired.push(summary);
      }
    };

    if (record.provider === "github") {
      for (const { repo, item } of await this.fetchGithubItems(record)) {
        const matched = matchGithubItem(filter, repo, item);
        if (!matched) continue;
        const event = githubAppearedEvent(item);
        const payload = {
          provider: "github",
          event,
          repo,
          kind: item.kind,
          number: item.number,
          title: item.title,
          url: item.url,
          author: item.author,
          labels: item.labels,
          body: item.body,
        };
        const draft = buildEventDraft({
          provider: "github",
          title: item.title,
          url: item.url,
          author: item.author,
          labels: item.labels,
          body: item.body,
          number: item.number,
        });
        // labelled fires one claim per label; opened/draft fire the base key.
        if (matched.event === "labelled") {
          for (const key of matched.eventKeys) {
            const label = key.split(":labelled:")[1] ?? "";
            await fire({
              event: "labelled",
              eventKey: key,
              payload: { ...payload, event: "labelled", label },
              draft,
            });
          }
        } else {
          await fire({
            event: matched.event,
            eventKey: githubEventKey({ kind: item.kind, repo, number: item.number }),
            payload,
            draft,
          });
        }
      }
      return fired;
    }

    for (const item of await this.fetchLinearItems(record)) {
      const matched = matchLinearItem(filter, item);
      if (!matched) continue;
      const payload = {
        provider: "linear",
        event: matched.event,
        id: item.id,
        identifier: item.identifier,
        title: item.title,
        url: item.url,
        author: item.author,
        assignees: item.assignees,
        teamKey: item.teamKey,
        labels: item.labels,
        body: item.body,
      };
      const draft = buildEventDraft({
        provider: "linear",
        title: item.title,
        url: item.url,
        author: item.author,
        labels: item.labels,
        body: item.body,
        identifier: item.identifier,
      });
      if (matched.event === "assigned") {
        for (const key of matched.eventKeys) {
          const assignee = key.split(":assigned:")[1] ?? "";
          await fire({
            event: "assigned",
            eventKey: key,
            payload: { ...payload, assignee },
            draft,
          });
        }
      } else {
        await fire({
          event: matched.event,
          eventKey: linearEventKey({ id: item.id }),
          payload,
          draft,
        });
      }
    }
    return fired;
  }

  private readonly pollFireTimestamps = new Map<string, number[]>();

  private async appendRun(recordId: string, run: AutomationRunSummary): Promise<void> {
    await this.polls.update(recordId, (current) => ({
      ...current,
      recentRuns: [run, ...current.recentRuns].slice(0, MAX_RECENT_RUNS_INSPECT),
      updatedAt: this.now().toISOString(),
    }));
  }
}

function parseRef(automationId: string): AutomationRef | null {
  const index = automationId.indexOf(":");
  if (index <= 0) return null;
  const owner = automationId.slice(0, index);
  const id = automationId.slice(index + 1);
  if (!id) return null;
  if (owner === "schedule" || owner === "webhook" || owner === "poll") return { owner, id };
  return null;
}

function filterOf(record: StoredPollAutomation): PollFilter {
  return {
    repos: record.repos,
    events: record.events,
    labels: record.labels,
    actors: record.actors,
  };
}
