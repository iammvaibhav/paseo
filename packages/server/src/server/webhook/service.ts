import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import type {
  CreateWebhookInput,
  StoredWebhook,
  UpdateWebhookInput,
  WebhookDelivery,
  WebhookFilter,
  WebhookSummary,
  WebhookTarget,
  WebhookTunnelProvider,
  WebhookTunnelStatus,
} from "@getpaseo/protocol/webhook/types";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { verifyWebhookHmac } from "./hmac.js";
import { MAX_WEBHOOK_DELIVERIES, WebhookStore, generateWebhookSecret } from "./store.js";
import { renderWebhookTemplate } from "./template.js";

// Cap the raw body we buffer, keep in the delivery snippet, and interpolate.
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;
const PAYLOAD_SNIPPET_LIMIT = 2_000;
// Sliding-window rate guard so a chatty source can't fork-bomb the daemon.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FIRES = 60;
// De-dupe window for provider-supplied delivery ids (retries).
const DEDUPE_WINDOW_MS = 10 * 60_000;
// Headers that commonly carry a provider idempotency key.
const DELIVERY_ID_HEADERS = ["x-github-delivery", "x-webhook-id", "x-request-id", "x-event-id"];

interface WebhookWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

type WebhookAgentManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hasInFlightRun"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
  | "runAgent"
  | "waitForAgentEvent"
>;

export interface WebhookServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: WebhookAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createLocalCheckoutWorkspace: (
    input: WebhookWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: WebhookWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  // Tunnel introspection for the webhook/config RPC + hook-URL rendering.
  getPublicBaseUrl: () => string | null;
  getTunnelProvider: () => WebhookTunnelProvider;
  getTunnelStatus: () => WebhookTunnelStatus;
  now?: () => Date;
}

export interface WebhookDeliverInput {
  webhookId: string;
  secret: string;
  rawBody: Buffer;
  headers: Record<string, string>;
  query: Record<string, string>;
  sourceIp: string | null;
  // Await the agent launch before returning (used by webhook/test).
  wait?: boolean;
}

export interface WebhookDeliverResult {
  httpStatus: number;
  delivery: WebhookDelivery | null;
  renderedPrompt: string | null;
  error: string | null;
}

export class WebhookService {
  private readonly store: WebhookStore;
  private readonly logger: Logger;
  private readonly agentManager: WebhookAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createLocalCheckoutWorkspace: (
    input: WebhookWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: WebhookWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly getPublicBaseUrl: () => string | null;
  private readonly getTunnelProvider: () => WebhookTunnelProvider;
  private readonly getTunnelStatus: () => WebhookTunnelStatus;
  private readonly now: () => Date;
  private readonly fireTimestamps = new Map<string, number[]>();

  constructor(options: WebhookServiceOptions) {
    this.store = new WebhookStore(join(options.paseoHome, "webhooks"));
    this.logger = options.logger.child({ module: "webhook-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createLocalCheckoutWorkspace = options.createLocalCheckoutWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.getPublicBaseUrl = options.getPublicBaseUrl;
    this.getTunnelProvider = options.getTunnelProvider;
    this.getTunnelStatus = options.getTunnelStatus;
    this.now = options.now ?? (() => new Date());
  }

  // ---- CRUD ----------------------------------------------------------------

  async create(input: CreateWebhookInput): Promise<WebhookSummary> {
    const now = this.now().toISOString();
    validateTarget(input.target);
    const created = await this.store.create({
      name: normalizeName(input.name),
      enabled: input.enabled ?? true,
      secret: generateWebhookSecret(),
      auth: input.auth ?? null,
      target: input.target,
      promptTemplate: normalizePromptTemplate(input.promptTemplate),
      filter: input.filter ?? null,
      createdAt: now,
      updatedAt: now,
      lastFiredAt: null,
      deliveries: [],
    });
    return toSummary(created);
  }

  async list(): Promise<WebhookSummary[]> {
    return (await this.store.list()).map(toSummary);
  }

  async inspect(id: string): Promise<StoredWebhook | null> {
    return this.store.get(id);
  }

  async update(input: UpdateWebhookInput): Promise<StoredWebhook | null> {
    if (input.target) {
      validateTarget(input.target);
    }
    return this.store.update(input.id, (webhook) => {
      const next: StoredWebhook = { ...webhook, updatedAt: this.now().toISOString() };
      if (input.name !== undefined) {
        next.name = normalizeName(input.name);
      }
      if (input.enabled !== undefined) {
        next.enabled = input.enabled;
      }
      if (input.target !== undefined) {
        next.target = input.target;
      }
      if (input.promptTemplate !== undefined) {
        next.promptTemplate = normalizePromptTemplate(input.promptTemplate);
      }
      if (input.auth !== undefined) {
        next.auth = input.auth;
      }
      if (input.filter !== undefined) {
        next.filter = input.filter;
      }
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  getTunnelConfig(): {
    provider: WebhookTunnelProvider;
    status: WebhookTunnelStatus;
    publicBaseUrl: string | null;
  } {
    return {
      provider: this.getTunnelProvider(),
      status: this.getTunnelStatus(),
      publicBaseUrl: this.getPublicBaseUrl(),
    };
  }

  publicBaseUrl(): string | null {
    return this.getPublicBaseUrl();
  }

  // ---- Delivery ------------------------------------------------------------

  async deliver(input: WebhookDeliverInput): Promise<WebhookDeliverResult> {
    const webhook = await this.store.get(input.webhookId);
    // Constant-ish behavior: an unknown id or a bad token both look like 404 so
    // scanners can't distinguish them, and neither records a delivery.
    if (!webhook || !safeTokenEqual(input.secret, webhook.secret)) {
      return { httpStatus: 404, delivery: null, renderedPrompt: null, error: "not found" };
    }
    if (!webhook.enabled) {
      return { httpStatus: 404, delivery: null, renderedPrompt: null, error: "disabled" };
    }

    // HMAC (optional) — verified over the raw body, before any parsing.
    if (webhook.auth?.hmac) {
      const verdict = verifyWebhookHmac(webhook.auth.hmac, input.rawBody, input.headers);
      if (!verdict.ok) {
        const delivery = await this.recordDelivery(webhook.id, {
          sourceIp: input.sourceIp,
          deliveryId: extractDeliveryId(input.headers),
          status: "rejected",
          matched: false,
          agentId: null,
          workspaceId: null,
          error: verdict.reason ?? "signature mismatch",
          payloadSnippet: null,
        });
        return { httpStatus: 401, delivery, renderedPrompt: null, error: "signature mismatch" };
      }
    }

    const deliveryId = extractDeliveryId(input.headers);
    if (deliveryId && this.isDuplicate(webhook, deliveryId)) {
      const delivery = await this.recordDelivery(webhook.id, {
        sourceIp: input.sourceIp,
        deliveryId,
        status: "skipped",
        matched: false,
        agentId: null,
        workspaceId: null,
        error: "duplicate delivery",
        payloadSnippet: null,
      });
      return { httpStatus: 200, delivery, renderedPrompt: null, error: null };
    }

    if (!this.checkRate(webhook.id)) {
      const delivery = await this.recordDelivery(webhook.id, {
        sourceIp: input.sourceIp,
        deliveryId,
        status: "rejected",
        matched: false,
        agentId: null,
        workspaceId: null,
        error: "rate limited",
        payloadSnippet: null,
      });
      return { httpStatus: 429, delivery, renderedPrompt: null, error: "rate limited" };
    }

    const raw = input.rawBody.toString("utf-8");
    const payload = parseJsonSafe(raw);
    const snippet = raw.length > PAYLOAD_SNIPPET_LIMIT ? raw.slice(0, PAYLOAD_SNIPPET_LIMIT) : raw;

    if (webhook.filter && !matchesFilter(webhook.filter, payload)) {
      const delivery = await this.recordDelivery(webhook.id, {
        sourceIp: input.sourceIp,
        deliveryId,
        status: "skipped",
        matched: false,
        agentId: null,
        workspaceId: null,
        error: null,
        payloadSnippet: snippet,
      });
      return { httpStatus: 202, delivery, renderedPrompt: null, error: null };
    }

    const renderedPrompt = renderWebhookTemplate(webhook.promptTemplate, {
      payload,
      headers: input.headers,
      query: input.query,
      raw,
    }).trim();

    const delivery = await this.recordDelivery(webhook.id, {
      sourceIp: input.sourceIp,
      deliveryId,
      status: "fired",
      matched: true,
      agentId: null,
      workspaceId: null,
      error: renderedPrompt ? null : "rendered prompt is empty",
      payloadSnippet: snippet,
    });

    if (!renderedPrompt) {
      await this.patchDelivery(webhook.id, delivery.id, { status: "failed" });
      return {
        httpStatus: 422,
        delivery: { ...delivery, status: "failed" },
        renderedPrompt: "",
        error: "rendered prompt is empty",
      };
    }

    const launch = this.launch(webhook, renderedPrompt, delivery.id).catch((error) => {
      this.logger.error({ err: error, webhookId: webhook.id }, "Webhook agent launch failed");
    });
    if (input.wait) {
      await launch;
      const refreshed = await this.findDelivery(webhook.id, delivery.id);
      return { httpStatus: 202, delivery: refreshed ?? delivery, renderedPrompt, error: null };
    }

    return { httpStatus: 202, delivery, renderedPrompt, error: null };
  }

  async test(webhookId: string, samplePayload: string | undefined): Promise<WebhookDeliverResult> {
    const webhook = await this.store.get(webhookId);
    if (!webhook) {
      return { httpStatus: 404, delivery: null, renderedPrompt: null, error: "not found" };
    }
    return this.deliver({
      webhookId,
      secret: webhook.secret,
      rawBody: Buffer.from(samplePayload ?? "{}", "utf-8"),
      headers: {},
      query: {},
      sourceIp: null,
      wait: true,
    });
  }

  // ---- Internals -----------------------------------------------------------

  private async launch(
    webhook: StoredWebhook,
    prompt: string,
    deliveryRecordId: string,
  ): Promise<void> {
    try {
      if (webhook.target.type === "agent") {
        const record = await this.agentStorage.get(webhook.target.agentId);
        if (!record || record.archivedAt) {
          throw new Error(`Target agent ${webhook.target.agentId} is gone`);
        }
        const agent = await ensureAgentLoaded(webhook.target.agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        });
        if (this.agentManager.hasInFlightRun(agent.id)) {
          throw new Error(`Target agent ${agent.id} already has an active run`);
        }
        await this.patchDelivery(webhook.id, deliveryRecordId, { agentId: agent.id });
        // Fire-and-forget: do not block on the run completing.
        void this.agentManager.runAgent(agent.id, prompt).catch((error) => {
          this.logger.error({ err: error, agentId: agent.id }, "Webhook agent run failed");
        });
        await this.markFired(webhook.id);
        return;
      }

      const config = webhook.target.config;
      await assertCwdDirectory(config.cwd);
      const workspace = await this.createRunWorkspace(config, prompt);
      const runConfig = { ...config, cwd: workspace.cwd };
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatProviderModel(runConfig.provider, runConfig.model),
        config: buildAgentConfig(runConfig),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        initialPrompt: prompt,
        title: resolveTitle(config.title ?? null, prompt),
        labels: {
          "paseo.webhook-id": webhook.id,
          "paseo.webhook-delivery": deliveryRecordId,
        },
        mode: config.modeId,
        thinking: config.thinkingOptionId,
        features: config.featureValues,
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
      });
      await this.patchDelivery(webhook.id, deliveryRecordId, {
        agentId: created.snapshot.id,
        workspaceId: workspace.workspaceId,
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      await this.markFired(webhook.id);
    } catch (error) {
      await this.patchDelivery(webhook.id, deliveryRecordId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async createRunWorkspace(
    config: Extract<WebhookTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createLocalCheckoutWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private isDuplicate(webhook: StoredWebhook, deliveryId: string): boolean {
    const cutoff = this.now().getTime() - DEDUPE_WINDOW_MS;
    return webhook.deliveries.some(
      (delivery) =>
        delivery.deliveryId === deliveryId &&
        delivery.status !== "rejected" &&
        new Date(delivery.receivedAt).getTime() >= cutoff,
    );
  }

  private checkRate(webhookId: string): boolean {
    const now = this.now().getTime();
    const window = (this.fireTimestamps.get(webhookId) ?? []).filter(
      (timestamp) => now - timestamp < RATE_WINDOW_MS,
    );
    if (window.length >= RATE_MAX_FIRES) {
      this.fireTimestamps.set(webhookId, window);
      return false;
    }
    window.push(now);
    this.fireTimestamps.set(webhookId, window);
    return true;
  }

  private async recordDelivery(
    webhookId: string,
    delivery: Omit<WebhookDelivery, "id" | "receivedAt">,
  ): Promise<WebhookDelivery> {
    const record: WebhookDelivery = {
      ...delivery,
      id: randomUUID(),
      receivedAt: this.now().toISOString(),
    };
    await this.store.update(webhookId, (webhook) => ({
      ...webhook,
      deliveries: [record, ...webhook.deliveries].slice(0, MAX_WEBHOOK_DELIVERIES),
    }));
    return record;
  }

  private async patchDelivery(
    webhookId: string,
    deliveryRecordId: string,
    patch: Partial<Omit<WebhookDelivery, "id" | "receivedAt">>,
  ): Promise<void> {
    await this.store.update(webhookId, (webhook) => ({
      ...webhook,
      deliveries: webhook.deliveries.map((delivery) =>
        delivery.id === deliveryRecordId ? { ...delivery, ...patch } : delivery,
      ),
    }));
  }

  private async findDelivery(
    webhookId: string,
    deliveryRecordId: string,
  ): Promise<WebhookDelivery | null> {
    const webhook = await this.store.get(webhookId);
    return webhook?.deliveries.find((delivery) => delivery.id === deliveryRecordId) ?? null;
  }

  private async markFired(webhookId: string): Promise<void> {
    await this.store.update(webhookId, (webhook) => ({
      ...webhook,
      lastFiredAt: this.now().toISOString(),
    }));
  }
}

function toSummary(webhook: StoredWebhook): WebhookSummary {
  const { deliveries: _deliveries, ...summary } = webhook;
  return summary;
}

function normalizeName(name: string | null | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePromptTemplate(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Webhook prompt template is required");
  }
  return trimmed;
}

function validateTarget(target: WebhookTarget): void {
  if (target.type === "new-agent" && !target.config.cwd.trim()) {
    throw new Error("new-agent target requires a cwd");
  }
}

function matchesFilter(filter: WebhookFilter, payload: unknown): boolean {
  return filter.rules.every((rule) => {
    const value = resolvePayloadPath(payload, rule.path);
    const asString = value === null || value === undefined ? "" : String(value);
    return asString === rule.equals;
  });
}

function resolvePayloadPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseJsonSafe(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractDeliveryId(headers: Record<string, string>): string | null {
  for (const header of DELIVERY_ID_HEADERS) {
    const value = headers[header];
    if (value) {
      return value;
    }
  }
  return null;
}

function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function assertCwdDirectory(cwd: string): Promise<void> {
  const stats = await stat(cwd);
  if (!stats.isDirectory()) {
    throw new Error(`Working directory ${cwd} is not a directory`);
  }
}

function buildAgentConfig(
  config: Extract<WebhookTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    approvalPolicy: config.approvalPolicy,
    sandboxMode: config.sandboxMode,
    networkAccess: config.networkAccess,
    webSearch: config.webSearch,
    featureValues: config.featureValues,
    extra: config.extra,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveTitle(configTitle: string | null, prompt: string): string {
  return resolveCreateAgentTitles({ configTitle, initialPrompt: prompt }).provisionalTitle ?? "";
}
