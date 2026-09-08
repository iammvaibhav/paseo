import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type {
  MissionControlEvent,
  MissionControlLifecycleAction,
  MissionControlProof,
} from "@getpaseo/protocol/mission-control/types";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  findInProgressColumn,
  ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
  ItsaplanClient,
} from "./client.js";
import {
  resolveTicketAttachments,
  rewriteMarkdownAttachmentUrls,
  stripNativeMarkdownImages,
} from "./ticket-images.js";
import type {
  ItsaplanCentralConfig,
  ItsaplanProjectMapping,
  ItsaplanProjectStore,
} from "./projects.js";

/** Agent label carrying the itsaplan issue id this agent was dispatched for. */
export const ITSAPLAN_ISSUE_LABEL_KEY = "itsaplan.issue";

/**
 * DUPLICATED verbatim in `packages/protocol/src/agent-labels.ts` (same
 * candidate keys and parsing rules). Not imported from there because this
 * package's shared checkout `node_modules/@getpaseo/protocol` symlink can
 * resolve to a different (built) checkout than this worktree's source,
 * risking a stale `dist/agent-labels.js` at runtime/test time. Keep both
 * copies in lockstep: any new candidate key or parsing rule added here MUST
 * be mirrored in agent-labels.ts, and vice versa (PASEO-38).
 */
export const ITSAPLAN_ISSUE_LABEL_CANDIDATE_KEYS = [
  ITSAPLAN_ISSUE_LABEL_KEY,
  "itsaplanIssue",
  "itsaplan_issue",
  "itsaplan-issue",
  "itsaplan.issueId",
  "itsaplan.issue_id",
  "itsaplanIssueId",
  "itsaplan_issue_id",
  "itsaplan.ticket",
  "itsaplanTicket",
  "itsaplan_ticket",
  "issueId",
  "issue_id",
  "issue",
  "ticketId",
  "ticket_id",
  "ticket",
] as const;

export function parseItsaplanIssueId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
      return String(Number(trimmed));
    }
    const match = /^(?:[A-Za-z][A-Za-z0-9_]*[-_])?#?(\d+)$/.exec(trimmed);
    if (match && match[1] && Number(match[1]) > 0) {
      return String(Number(match[1]));
    }
  }
  return null;
}

export function getItsaplanIssueIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  if (!labels || typeof labels !== "object") {
    return null;
  }
  for (const key of ITSAPLAN_ISSUE_LABEL_CANDIDATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(labels, key)) {
      const parsed = parseItsaplanIssueId(labels[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

/** Label name for auto-chaining dependent tickets when a blocker reaches Ready-to-review. */
export const ITSAPLAN_AUTO_CHAIN_LABEL_NAME = "auto-chain";

const MAX_TRACKED_EVENT_IDS = 500;

const ItsaplanWebhookIssueDataSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  sequenceNumber: z.number(),
  identifier: z.string().optional(),
  columnId: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  initiativeId: z.number().nullable().optional(),
  initiative: z
    .object({
      id: z.number(),
      title: z.string(),
      description: z.string().nullable().optional(),
      status: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const ItsaplanWebhookCommentDataSchema = z.object({
  id: z.number(),
  issueId: z.number(),
  actorUserId: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

const ItsaplanWebhookEnvelopeSchema = z.object({
  event: z.string(),
  data: z.unknown(),
});

export interface ItsaplanBridgeAgentManager {
  subscribe(
    callback: (event: AgentManagerEvent) => void,
    options?: { replayState?: boolean },
  ): () => void;
  getAgent(agentId: string): ManagedAgent | null;
  listAgents?(): ManagedAgent[];
  setLabels(agentId: string, labels: Record<string, string | null>): Promise<void>;
}

export interface ItsaplanBridgeAgentStorage {
  get(
    agentId: string,
  ): Promise<Pick<
    StoredAgentRecord,
    "labels" | "title" | "name" | "shortDescription" | "cwd" | "workspaceId" | "archivedAt"
  > | null>;
  list(): Promise<
    Pick<StoredAgentRecord, "id" | "labels" | "updatedAt" | "workspaceId" | "archivedAt">[]
  >;
}

export interface ItsaplanBridgeMissionControl {
  subscribeSelfReports(listener: (event: MissionControlEvent) => void): () => void;
  /** General feed fan-out (chat-runner uses it too); the bridge tracks the
   * latest clarification/blocked question per agent for the needs_you
   * entry comment. */
  subscribeEvents(listener: (event: MissionControlEvent) => void): () => void;
  getLifecycleBucket(agentId: string): Promise<LifecycleBucket>;
  setLifecycle(input: {
    agentId: string;
    agentIds?: string[];
    action: MissionControlLifecycleAction;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Fleet reach for the inbound (itsaplan -> Paseo) direction. Webhook ingress
 * terminates on one host, but the agent a ticket refers to usually runs on a
 * different one, so a local-only lookup silently no-ops. Absent (single-host
 * or peering unavailable) → the bridge stays local-only.
 */
export interface ItsaplanBridgeFleet {
  /** The agent carrying this issue label anywhere in the fleet. */
  findAgentByIssue(issueId: string): Promise<{ agentId: string; host: string } | null>;
  /** Set lifecycle on the host that owns the agent. */
  setLifecycle(input: {
    host: string;
    agentId: string;
    action: MissionControlLifecycleAction;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Read an agent's lifecycle bucket on the host that owns it. */
  getLifecycleBucket(input: { host: string; agentId: string }): Promise<LifecycleBucket | null>;
  /** Steer a prompt to an agent on the host that owns it. */
  steerWorkerPrompt(input: {
    host: string;
    agentId: string;
    prompt: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ItsaplanWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
}

export interface ItsaplanWebhookResponse {
  status: number;
  body: { ok: boolean; error?: string };
}

export interface ItsaplanBridgeOptions {
  logger: Logger;
  serverId: string;
  agentManager: ItsaplanBridgeAgentManager;
  agentStorage: ItsaplanBridgeAgentStorage;
  missionControl: ItsaplanBridgeMissionControl;
  /** Omit for single-host: the bridge then only resolves local agents. */
  fleet?: ItsaplanBridgeFleet;
  projectStore: ItsaplanProjectStore;
  getConfig: () => ItsaplanCentralConfig | null;
  /** Resolves the Paseo project key for an agent's workspace/cwd. */
  resolvePaseoProjectKey?: (agentId: string) => Promise<string | null>;
  /**
   * Delivers a machinery-classified prompt to the Commander agent (the same
   * dispatchLocalPromptMode primitive Mission Control's own machinery turns
   * use — see service.ts `dispatchMachineryTurn`). Returns false when no
   * Commander is resolvable. Injected rather than built from a raw
   * AgentManager/AgentStorage pair so this module stays independently
   * testable; bootstrap.ts wires the real implementation.
   */
  deliverMachineryPrompt: (
    prompt: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean>;
  /**
   * Steers the agent the user is answering mid-turn — the same path a user
   * message in Paseo takes for a blocked worker (sendPromptToAgent with
   * activeTurnBehavior "steer"). Injected rather than imported so tests can
   * fake delivery; bootstrap.ts wires sendPromptToAgent.
   */
  steerWorkerPrompt: (agentId: string, prompt: string) => Promise<void>;
}

/** `t=<unix-seconds>,v1=<hex hmac>` — itsaplan's webhook signature header. */
function verifyItsaplanSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: readonly string[],
): boolean {
  if (!header) {
    return false;
  }
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value;
    if (key === "v1") signature = value;
  }
  if (!timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) {
    return false;
  }
  const providedBuffer = Buffer.from(signature, "hex");
  // itsaplan generates one secret per registered webhook (per project); try
  // every known one plus the central-config fallback. N is tiny (one per
  // mapped project), and each check stays constant-time.
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

export function extractProjectKeyFromIdentifier(identifier: string): string | null {
  const match = /^(.*)-(\d+)$/.exec(identifier.trim());
  if (!match || !match[1]) {
    return null;
  }
  return match[1];
}

function formatProofsComment(proofs: MissionControlProof[] | undefined): string {
  if (!proofs || proofs.length === 0) {
    return "Ready for review.";
  }
  const lines = proofs.map((proof) => {
    const label = proof.label ?? proof.kind;
    const target = proof.url ?? proof.path ?? proof.excerpt ?? "";
    return target ? `- ${label}: ${target}` : `- ${label}`;
  });
  return ["Ready for review.", "", "Proofs:", ...lines].join("\n");
}

export interface BuildDispatchPromptInput {
  issueId: number;
  ticketKey: string;
  title: string;
  body: string;
  url: string;
  projectKey: string;
  initiative?: {
    title: string;
    description?: string | null;
  } | null;
  attachments?: Array<{
    filename: string;
    url: string;
  }> | null;
  nativeImageCount?: number;
}

export function buildDispatchPrompt(input: BuildDispatchPromptInput): string {
  const lines: string[] = [
    "itsaplan ticket moved to Todo with zero open blockers — ready to dispatch.",
    `Project: ${input.projectKey}`,
    `Ticket: ${input.ticketKey} — ${input.title}`,
    `URL: ${input.url}`,
  ];

  if (input.initiative) {
    lines.push(`Initiative: ${input.initiative.title}`);
    if (input.initiative.description && input.initiative.description.trim().length > 0) {
      lines.push(`Initiative description: ${input.initiative.description.trim()}`);
    }
  }

  lines.push("");
  const rawBody = rewriteMarkdownAttachmentUrls(input.body);
  const body = (
    input.nativeImageCount && input.nativeImageCount > 0
      ? stripNativeMarkdownImages(rawBody)
      : rawBody
  ).trim();
  lines.push(body.length > 0 ? body : "(no description)");

  if (input.nativeImageCount && input.nativeImageCount > 0) {
    lines.push("");
    lines.push(
      `${input.nativeImageCount} image${input.nativeImageCount === 1 ? "" : "s"} attached natively (same as composer paste).`,
      "Pass them through fleet_create_agent images when spinning the worker — do not fetch ticket image URLs.",
    );
  }

  if (input.attachments && input.attachments.length > 0) {
    lines.push("");
    lines.push("File attachments:");
    for (const attachment of input.attachments) {
      lines.push(`- ${attachment.filename}: ${attachment.url}`);
    }
  }

  lines.push("");
  lines.push(
    "<instructions>",
    `Dispatch a worker for this ticket. Label the new agent "${ITSAPLAN_ISSUE_LABEL_KEY}": "${input.issueId}" so the bridge can move the ticket and post progress as the agent's execution state changes.`,
    "</instructions>",
  );

  return lines.join("\n");
}

/**
 * ADR 0002 single-writer bridge: consumes itsaplan webhooks and Paseo agent
 * lifecycle events, writes both directions idempotently. Fully inert when
 * central config `itsaplan` is absent (every entry point checks `getConfig()`
 * first and no-ops).
 */
export class ItsaplanBridge {
  private readonly logger: Logger;
  private readonly serverId: string;
  private readonly agentManager: ItsaplanBridgeAgentManager;
  private readonly agentStorage: ItsaplanBridgeAgentStorage;
  private readonly missionControl: ItsaplanBridgeMissionControl;
  private readonly fleet?: ItsaplanBridgeFleet;
  private readonly projectStore: ItsaplanProjectStore;
  private readonly getConfig: () => ItsaplanCentralConfig | null;
  private readonly deliverMachineryPrompt: (
    prompt: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean>;
  private readonly steerWorkerPrompt: (agentId: string, prompt: string) => Promise<void>;
  private readonly resolvePaseoProjectKey?: (agentId: string) => Promise<string | null>;

  private readonly seenAgentIds = new Set<string>();
  private readonly lastBucketByAgentId = new Map<string, LifecycleBucket>();
  private readonly processedWebhookEventIds = new Set<string>();
  /** Agents whose needs_you exit was caused by a ticket comment (vs a direct
   * Paseo answer); drives the convergence-comment wording on bucket exit. */
  private readonly answeredViaTicketComment = new Set<string>();
  /** Latest clarification/blocked question text per agent, kept fresh from
   * the mission-control feed so a needs_you entry comment can quote what the
   * agent is actually asking. */
  private readonly lastQuestionByAgentId = new Map<string, string>();

  private unsubscribeAgentManager: (() => void) | null = null;
  private unsubscribeSelfReports: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(options: ItsaplanBridgeOptions) {
    this.logger = options.logger.child({ module: "itsaplan", component: "bridge" });
    this.serverId = options.serverId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.missionControl = options.missionControl;
    if (options.fleet) this.fleet = options.fleet;
    this.projectStore = options.projectStore;
    this.getConfig = options.getConfig;
    this.deliverMachineryPrompt = options.deliverMachineryPrompt;
    this.steerWorkerPrompt = options.steerWorkerPrompt;
    this.resolvePaseoProjectKey = options.resolvePaseoProjectKey;
  }

  start(): void {
    // replayState:false — the boot backfill/reconcile sweep owns catch-up
    // for agents that already existed when the bridge started; a replayed
    // agent_state for a pre-existing agent must never be mistaken for a
    // fresh creation.
    this.unsubscribeAgentManager = this.agentManager.subscribe(
      (event) => this.handleAgentManagerEvent(event),
      { replayState: false },
    );
    this.unsubscribeSelfReports = this.missionControl.subscribeSelfReports((event) =>
      this.handleSelfReport(event),
    );
    this.unsubscribeEvents = this.missionControl.subscribeEvents((event) =>
      this.rememberQuestion(event),
    );
  }

  stop(): void {
    this.unsubscribeAgentManager?.();
    this.unsubscribeAgentManager = null;
    this.unsubscribeSelfReports?.();
    this.unsubscribeSelfReports = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  /** Tracks the newest structured question so the needs_you entry comment
   * carries what the agent is actually asking (text priority (a)/(b)). */
  private rememberQuestion(event: MissionControlEvent): void {
    if (event.kind === "clarification" && event.clarification) {
      const lines = [event.clarification.question];
      if (event.clarification.options.length > 0) {
        lines.push("", "Options:", ...event.clarification.options.map((option) => `- ${option}`));
      }
      this.lastQuestionByAgentId.set(event.agentId, lines.join("\n"));
      return;
    }
    if (event.kind === "blocked") {
      this.lastQuestionByAgentId.set(
        event.agentId,
        event.detail ? `${event.headline}\n\n${event.detail}` : event.headline,
      );
    }
  }

  // ---------------------------------------------------------------------
  // (a) Webhook ingress: itsaplan -> Paseo
  // ---------------------------------------------------------------------

  async handleWebhookRequest(request: ItsaplanWebhookRequest): Promise<ItsaplanWebhookResponse> {
    const config = this.getConfig();
    if (!config) {
      return { status: 503, body: { ok: false, error: "itsaplan bridge not configured" } };
    }
    const knownSecrets = [
      ...new Set(
        this.projectStore
          .list()
          .map((mapping) => mapping.webhookSecret)
          .filter((secret): secret is string => Boolean(secret)),
      ),
      config.webhookSecret,
    ];
    if (
      !verifyItsaplanSignature(
        request.rawBody,
        request.headers["x-itsaplan-signature"],
        knownSecrets,
      )
    ) {
      return { status: 401, body: { ok: false, error: "invalid signature" } };
    }
    let envelope: z.infer<typeof ItsaplanWebhookEnvelopeSchema>;
    try {
      envelope = ItsaplanWebhookEnvelopeSchema.parse(JSON.parse(request.rawBody.toString("utf-8")));
    } catch {
      return { status: 400, body: { ok: false, error: "invalid payload" } };
    }
    const eventId = request.headers["x-itsaplan-event-id"];
    if (eventId && this.processedWebhookEventIds.has(eventId)) {
      // Already handled — itsaplan retries the same delivery id on a
      // network hiccup even though its own semantics call a 2xx final.
      return { status: 200, body: { ok: true } };
    }
    if (envelope.event === "issue.created" || envelope.event === "issue.state_changed") {
      const parsed = ItsaplanWebhookIssueDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        return { status: 400, body: { ok: false, error: "invalid issue payload" } };
      }
      try {
        await this.handleIssueStateChanged(parsed.data, config);
      } catch (error) {
        this.logger.error(
          { err: error, issueId: parsed.data.id, event: envelope.event },
          "itsaplan.bridge.issue_handling_failed",
        );
        // Non-2xx so itsaplan retries with backoff (packages/worker semantics).
        return { status: 500, body: { ok: false, error: "processing failed" } };
      }
    }
    if (envelope.event === "comment.created") {
      const parsed = ItsaplanWebhookCommentDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        return { status: 400, body: { ok: false, error: "invalid comment payload" } };
      }
      try {
        await this.handleCommentCreated(parsed.data, config);
      } catch (error) {
        this.logger.error(
          { err: error, issueId: parsed.data.issueId },
          "itsaplan.bridge.comment_created_failed",
        );
        // Non-2xx so itsaplan retries with backoff (packages/worker semantics).
        return { status: 500, body: { ok: false, error: "processing failed" } };
      }
    }
    if (eventId) {
      this.rememberProcessedEvent(eventId);
    }
    return { status: 200, body: { ok: true } };
  }

  private rememberProcessedEvent(eventId: string): void {
    this.processedWebhookEventIds.add(eventId);
    if (this.processedWebhookEventIds.size > MAX_TRACKED_EVENT_IDS) {
      const oldest = this.processedWebhookEventIds.values().next().value;
      if (oldest !== undefined) {
        this.processedWebhookEventIds.delete(oldest);
      }
    }
  }
  private async handleIssueStateChanged(
    issue: z.infer<typeof ItsaplanWebhookIssueDataSchema>,
    config: ItsaplanCentralConfig,
  ): Promise<void> {
    const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
    if (!mapping) {
      // Native, unlinked itsaplan project (ADR 0002: legal but non-dispatching).
      return;
    }
    const client = new ItsaplanClient(config);
    const columns = await client.listProjectColumns(mapping.itsaplanProjectKey);
    const column = columns.find((candidate) => candidate.id === issue.columnId);
    if (!column) {
      return;
    }

    if (column.stateType === "unstarted") {
      const links = await client.listIssueLinks(issue.id);
      let openBlockerCount = 0;
      for (const link of links) {
        if (link.kind !== "blocks" || link.targetIssueId !== issue.id) {
          continue;
        }
        const open = await this.isBlockerOpen(
          client,
          columns,
          mapping.itsaplanProjectKey,
          link.sourceIssueId,
        );
        if (open) {
          openBlockerCount += 1;
        }
      }
      if (openBlockerCount > 0) {
        return;
      }
      await this.dispatchIssue(mapping, config, issue, client);
      return;
    }
    if (column.stateType === "completed") {
      await this.projectCompletedColumnOntoAgent(issue, column);
    }

    const isReadyForReview =
      column.name === ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME && column.stateType === "started";
    const releasesDependents =
      column.stateType === "completed" ||
      column.stateType === "canceled" ||
      (isReadyForReview &&
        (await this.hasAutoChainLabel(client, mapping.itsaplanProjectKey, issue)));

    if (!releasesDependents) {
      return;
    }

    await this.releaseBlockedDependents(client, columns, mapping, config, issue.id);
  }

  private async isBlockerOpen(
    client: ItsaplanClient,
    columns: readonly { id: number; name: string; stateType: string }[],
    projectKey: string,
    blockerIssueId: number,
  ): Promise<boolean> {
    const blocker = await client.getIssue(blockerIssueId);
    const blockerColumn = columns.find((candidate) => candidate.id === blocker.columnId);
    if (blockerColumn?.stateType === "completed" || blockerColumn?.stateType === "canceled") {
      return false;
    }
    if (
      blockerColumn?.name === ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME &&
      blockerColumn?.stateType === "started"
    ) {
      const autoChain = await this.hasAutoChainLabel(client, projectKey, blocker);
      if (autoChain) {
        return false;
      }
    }
    return true;
  }

  private async hasAutoChainLabel(
    client: ItsaplanClient,
    projectKey: string,
    issue: { id: number; labelIds?: number[] },
  ): Promise<boolean> {
    const labels = await client.listProjectLabels(projectKey);
    const autoChainLabel = labels.find((l) => l.name === ITSAPLAN_AUTO_CHAIN_LABEL_NAME);
    if (!autoChainLabel) {
      return false;
    }
    let labelIds = issue.labelIds;
    if (labelIds === undefined) {
      const full = await client.getIssue(issue.id);
      labelIds = full.labelIds;
    }
    return Boolean(labelIds?.includes(autoChainLabel.id));
  }

  private async dispatchIssue(
    mapping: ItsaplanProjectMapping,
    config: ItsaplanCentralConfig,
    issue: {
      id: number;
      sequenceNumber: number;
      title: string;
      description?: string | null;
      initiative?: {
        id: number;
        title: string;
        description?: string | null;
        status?: string;
      } | null;
      initiativeId?: number | null;
    },
    client?: ItsaplanClient,
  ): Promise<void> {
    const apiClient = client ?? new ItsaplanClient(config);
    const ticketKey = `${mapping.itsaplanProjectKey}-${issue.sequenceNumber}`;
    const url = `${config.baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(mapping.itsaplanProjectKey)}/issues/${issue.sequenceNumber}`;

    const [initiative, attachments] = await Promise.all([
      this.resolveInitiativeContext(apiClient, issue),
      resolveTicketAttachments(apiClient, issue.id, config.baseUrl).catch(() => ({
        images: [],
        files: [],
      })),
    ]);

    const prompt = buildDispatchPrompt({
      issueId: issue.id,
      ticketKey,
      title: issue.title,
      body: issue.description ?? "",
      url,
      projectKey: mapping.paseoProjectKey,
      initiative,
      attachments: attachments.files.length > 0 ? attachments.files : undefined,
      nativeImageCount: attachments.images.length,
    });
    const delivered = await this.deliverMachineryPrompt(
      prompt,
      attachments.images.length > 0 ? attachments.images : undefined,
    );
    if (!delivered) {
      this.logger.warn({ issueId: issue.id }, "itsaplan.bridge.no_commander_to_dispatch_ticket");
    }
  }

  private async resolveInitiativeContext(
    apiClient: ItsaplanClient,
    issue: {
      id: number;
      initiative?: {
        id: number;
        title: string;
        description?: string | null;
        status?: string;
      } | null;
      initiativeId?: number | null;
    },
  ): Promise<{ title: string; description?: string | null } | null> {
    try {
      let initiativeId = issue.initiative?.id ?? issue.initiativeId;
      let initiativeTitle = issue.initiative?.title;
      let initiativeDescription = issue.initiative?.description;

      if (initiativeId === undefined && issue.initiative === undefined) {
        const fullIssue = await apiClient.getIssue(issue.id).catch(() => null);
        if (fullIssue) {
          initiativeId = fullIssue.initiative?.id ?? fullIssue.initiativeId;
          initiativeTitle = fullIssue.initiative?.title;
          initiativeDescription = fullIssue.initiative?.description;
        }
      }

      if (initiativeId && initiativeDescription === undefined) {
        const fetchedInitiative = await apiClient.getInitiative(initiativeId).catch(() => null);
        if (fetchedInitiative) {
          initiativeTitle = initiativeTitle ?? fetchedInitiative.title;
          initiativeDescription = fetchedInitiative.description;
        }
      }

      if (initiativeTitle) {
        return {
          title: initiativeTitle,
          description: initiativeDescription,
        };
      }
    } catch (error) {
      this.logger.warn(
        { err: error, issueId: issue.id },
        "itsaplan.bridge.initiative_resolution_failed",
      );
    }
    return null;
  }

  private async releaseBlockedDependents(
    client: ItsaplanClient,
    columns: readonly { id: number; name: string; stateType: string }[],
    mapping: ItsaplanProjectMapping,
    config: ItsaplanCentralConfig,
    sourceIssueId: number,
  ): Promise<void> {
    const links = await client.listIssueLinks(sourceIssueId);
    const dependentIds = [
      ...new Set(
        links
          .filter((link) => link.kind === "blocks" && link.sourceIssueId === sourceIssueId)
          .map((link) => link.targetIssueId),
      ),
    ];
    for (const depId of dependentIds) {
      const dependent = await client.getIssue(depId);
      const depColumn = columns.find((candidate) => candidate.id === dependent.columnId);
      if (depColumn?.stateType !== "unstarted") {
        continue;
      }
      const depLinks = await client.listIssueLinks(depId);
      let depOpenBlockers = 0;
      for (const link of depLinks) {
        if (link.kind !== "blocks" || link.targetIssueId !== depId) {
          continue;
        }
        if (link.sourceIssueId === sourceIssueId) {
          continue;
        }
        const open = await this.isBlockerOpen(
          client,
          columns,
          mapping.itsaplanProjectKey,
          link.sourceIssueId,
        );
        if (open) {
          depOpenBlockers += 1;
        }
      }
      if (depOpenBlockers === 0) {
        await this.dispatchIssue(mapping, config, dependent, client);
      }
    }
  }

  /**
   * A human comment on a needs_you ticket is the answer to the pending
   * question: it is steered straight into the waiting worker (the same path
   * a Paseo user message takes). Bot comments and other users' comments are
   * conversation, not answers; a comment arriving after the agent left
   * needs_you is a late reply the convergence comment already explains —
   * both are ignored. The assignee flip-back deliberately does NOT happen
   * here: both answer surfaces converge on the bucket-exit path.
   */
  private async handleCommentCreated(
    comment: z.infer<typeof ItsaplanWebhookCommentDataSchema>,
    config: ItsaplanCentralConfig,
  ): Promise<void> {
    if (!config.humanUserId) {
      this.logger.warn(
        { issueId: comment.issueId, reason: "human_user_id_not_configured" },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }
    if (comment.actorUserId !== config.humanUserId) {
      // Bot comments and other users' comments are conversation, not answers (expected case).
      return;
    }
    const body = comment.body?.trim() ?? "";
    if (!body) {
      this.logger.warn(
        { issueId: comment.issueId, reason: "empty_comment_body" },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    const issueId = String(comment.issueId);
    const localAgentId = await this.findAgentIdByIssueLabel(issueId);
    if (localAgentId) {
      const bucket = await this.missionControl.getLifecycleBucket(localAgentId);
      if (bucket !== "needs_you") {
        this.logger.warn(
          {
            issueId: comment.issueId,
            agentId: localAgentId,
            host: "local",
            bucket,
            reason: "agent_not_in_needs_you",
          },
          "itsaplan.bridge.comment_delivery_skipped",
        );
        return;
      }
      await this.steerWorkerPrompt(localAgentId, body);
      this.answeredViaTicketComment.add(localAgentId);
      this.logger.info(
        { issueId: comment.issueId, agentId: localAgentId, host: "local" },
        "itsaplan.bridge.comment_steered_to_agent",
      );
      return;
    }

    if (!this.fleet) {
      this.logger.warn(
        { issueId: comment.issueId, reason: "no_linked_agent" },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    let remote: { agentId: string; host: string } | null = null;
    try {
      remote = await this.fleet.findAgentByIssue(issueId);
    } catch (error) {
      this.logger.warn(
        { err: error, issueId: comment.issueId, reason: "fleet_lookup_failed" },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    if (!remote) {
      this.logger.warn(
        { issueId: comment.issueId, reason: "no_linked_agent" },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    let remoteBucket: LifecycleBucket | null = null;
    try {
      remoteBucket = await this.fleet.getLifecycleBucket({
        host: remote.host,
        agentId: remote.agentId,
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          issueId: comment.issueId,
          agentId: remote.agentId,
          host: remote.host,
          reason: "remote_bucket_lookup_failed",
        },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    if (remoteBucket !== "needs_you") {
      this.logger.warn(
        {
          issueId: comment.issueId,
          agentId: remote.agentId,
          host: remote.host,
          bucket: remoteBucket,
          reason: "agent_not_in_needs_you",
        },
        "itsaplan.bridge.comment_delivery_skipped",
      );
      return;
    }

    const steerResult = await this.fleet.steerWorkerPrompt({
      host: remote.host,
      agentId: remote.agentId,
      prompt: body,
    });

    if (!steerResult.ok) {
      this.logger.warn(
        {
          issueId: comment.issueId,
          agentId: remote.agentId,
          host: remote.host,
          error: steerResult.error,
          reason: "steer_failed",
        },
        "itsaplan.bridge.comment_delivery_failed",
      );
      throw new Error(
        `Failed to steer remote agent ${remote.agentId} on ${remote.host}: ${steerResult.error}`,
      );
    }

    this.logger.info(
      { issueId: comment.issueId, agentId: remote.agentId, host: remote.host },
      "itsaplan.bridge.comment_steered_to_agent",
    );
  }

  /** Resolves the itsaplan issue id back to the labeled agent. One ticket can
   * have N attempts (ADR 0002); the most recently updated one is current,
   * matching reconcile.ts's rule. */
  /**
   * A ticket moved into a completed column: mark the agent done in Mission
   * Control. The agent is looked up locally first, then across the fleet,
   * because webhook ingress terminates on one host while the agent it refers
   * to commonly runs on another.
   *
   * The bucket is read before writing so an inbound move cannot bounce back
   * out as an outbound projection event.
   */
  private async projectCompletedColumnOntoAgent(
    issue: { id: number },
    column: { id: number; name: string },
  ): Promise<void> {
    const issueId = String(issue.id);
    const localAgentId = await this.findAgentIdByIssueLabel(issueId);
    if (localAgentId) {
      const bucket = await this.missionControl.getLifecycleBucket(localAgentId);
      if (bucket === "done") {
        return;
      }
      const result = await this.missionControl.setLifecycle({
        agentId: localAgentId,
        action: "done",
      });
      this.logCompletedProjection(issue, column, localAgentId, "local", result);
      return;
    }

    if (!this.fleet) {
      this.logger.info(
        { issueId: issue.id, columnId: column.id, columnName: column.name },
        "itsaplan.bridge.completed_issue_no_linked_agent",
      );
      return;
    }

    let remote: { agentId: string; host: string } | null = null;
    try {
      remote = await this.fleet.findAgentByIssue(issueId);
    } catch (error) {
      this.logger.warn(
        { err: error, issueId: issue.id },
        "itsaplan.bridge.fleet_agent_lookup_failed",
      );
      return;
    }
    if (!remote) {
      this.logger.info(
        { issueId: issue.id, columnId: column.id, columnName: column.name },
        "itsaplan.bridge.completed_issue_no_linked_agent",
      );
      return;
    }

    const result = await this.fleet.setLifecycle({
      host: remote.host,
      agentId: remote.agentId,
      action: "done",
    });
    this.logCompletedProjection(issue, column, remote.agentId, remote.host, result);
  }

  private logCompletedProjection(
    issue: { id: number },
    column: { id: number; name: string },
    agentId: string,
    host: string,
    result: { ok: true } | { ok: false; error: string },
  ): void {
    if (!result.ok) {
      this.logger.warn(
        { issueId: issue.id, agentId, host, error: result.error },
        "itsaplan.bridge.agent_lifecycle_set_done_failed",
      );
      return;
    }
    this.logger.info(
      { issueId: issue.id, agentId, host, columnId: column.id, columnName: column.name },
      "itsaplan.bridge.agent_lifecycle_set_done",
    );
  }

  private async findAgentIdByIssueLabel(issueId: string): Promise<string | null> {
    const records = await this.agentStorage.list();
    const latest = records.reduce<Pick<StoredAgentRecord, "id" | "updatedAt"> | null>(
      (newest, record) => {
        if (getItsaplanIssueIdFromLabels(record.labels) !== issueId) {
          return newest;
        }
        if (newest && newest.updatedAt >= record.updatedAt) {
          return newest;
        }
        return { id: record.id, updatedAt: record.updatedAt };
      },
      null,
    );
    return latest?.id ?? null;
  }

  // ---------------------------------------------------------------------
  // (c) Projection listeners: Paseo agent lifecycle -> itsaplan
  // ---------------------------------------------------------------------

  private handleAgentManagerEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state") {
      return;
    }
    const agent = event.agent;
    const issueId = getItsaplanIssueIdFromLabels(agent.labels);
    if (!issueId) {
      return;
    }
    const isFirstSighting = !this.seenAgentIds.has(agent.id);
    this.seenAgentIds.add(agent.id);
    void this.projectAgentState(agent.id, issueId, isFirstSighting).catch((error) => {
      this.logger.error(
        { err: error, agentId: agent.id, issueId },
        "itsaplan.bridge.agent_state_projection_failed",
      );
    });
  }

  private async projectAgentState(
    agentId: string,
    issueId: string,
    isFirstSighting: boolean,
  ): Promise<void> {
    if (isFirstSighting) {
      await this.handleAgentCreated(agentId, issueId);
    }
    await this.checkLifecycleProjection(agentId, issueId);
  }

  private handleSelfReport(event: MissionControlEvent): void {
    void this.projectSelfReport(event).catch((error) => {
      this.logger.error(
        { err: error, agentId: event.agentId },
        "itsaplan.bridge.self_report_failed",
      );
    });
  }

  private async projectSelfReport(event: MissionControlEvent): Promise<void> {
    const labels = await this.getAgentLabels(event.agentId);
    const issueId = getItsaplanIssueIdFromLabels(labels);
    if (!issueId) {
      return;
    }
    if (event.kind === "finished") {
      await this.handleAgentCompleted(event.agentId, issueId, event.proof);
      return;
    }
    await this.checkLifecycleProjection(event.agentId, issueId);
  }

  private async getAgentLabels(agentId: string): Promise<Record<string, string> | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live?.labels) {
      return live.labels;
    }
    const record = await this.agentStorage.get(agentId);
    return record?.labels ?? null;
  }

  /** Todo -> In Progress (bridge-owned edge, ADR 0002) + a deep-link comment. */
  private async handleAgentCreated(agentId: string, issueId: string): Promise<void> {
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const client = new ItsaplanClient(config);
    const issue = await client.getIssue(numericIssueId);
    const projectKey = this.resolveProjectKey(issue);
    if (!projectKey) {
      return;
    }
    const columns = await client.listProjectColumns(projectKey);
    const currentColumn = columns.find((c) => c.id === issue.columnId);
    if (currentColumn?.stateType === "completed" || currentColumn?.stateType === "canceled") {
      return;
    }
    const inProgress = findInProgressColumn(columns);
    if (
      inProgress &&
      issue.columnId !== inProgress.id &&
      currentColumn?.name !== ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME
    ) {
      await client.moveIssueColumn(numericIssueId, inProgress.id);
    }
    await client.postComment(
      numericIssueId,
      `Dispatched: paseo://h/${this.serverId}/agent/${agentId}`,
    );
  }

  /** Running -> In Progress (bridge-owned edge, ADR 0002). */
  private async handleAgentRunning(agentId: string, issueId: string): Promise<void> {
    const record = await this.agentStorage.get(agentId);
    if (record?.archivedAt) {
      return;
    }
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const client = new ItsaplanClient(config);
    const issue = await client.getIssue(numericIssueId);
    const projectKey = this.resolveProjectKey(issue);
    if (!projectKey) {
      return;
    }
    const columns = await client.listProjectColumns(projectKey);
    const currentColumn = columns.find((c) => c.id === issue.columnId);
    if (currentColumn?.stateType === "completed" || currentColumn?.stateType === "canceled") {
      return;
    }
    const inProgress = findInProgressColumn(columns);
    if (inProgress && issue.columnId !== inProgress.id) {
      await client.moveIssueColumn(numericIssueId, inProgress.id);
      this.logger.info(
        { agentId, issueId, columnId: inProgress.id },
        "itsaplan.bridge.in_progress",
      );
    }
  }

  /** In Progress -> Ready to review (bridge-owned edge, ADR 0002) + proofs. */
  private async handleAgentCompleted(
    agentId: string,
    issueId: string,
    proof?: MissionControlProof[],
  ): Promise<void> {
    const record = await this.agentStorage.get(agentId);
    if (record?.archivedAt) {
      return;
    }
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const client = new ItsaplanClient(config);
    const issue = await client.getIssue(numericIssueId);
    const projectKey = this.resolveProjectKey(issue);
    if (!projectKey) {
      return;
    }
    const columns = await client.listProjectColumns(projectKey);
    const currentColumn = columns.find((c) => c.id === issue.columnId);
    if (currentColumn?.stateType === "completed" || currentColumn?.stateType === "canceled") {
      return;
    }
    const readyColumn = await client.ensureColumn(
      projectKey,
      ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
      "started",
    );
    const needsMove = issue.columnId !== readyColumn.id;
    if (needsMove) {
      await client.moveIssueColumn(numericIssueId, readyColumn.id);
    }
    if (needsMove || (proof !== undefined && proof.length > 0)) {
      await client.postComment(numericIssueId, formatProofsComment(proof));
    }
    this.lastBucketByAgentId.set(agentId, "ready");
    this.logger.info({ agentId, issueId }, "itsaplan.bridge.ready_for_review");
  }
  /**
   * Projects agent lifecycle bucket transitions to itsaplan:
   * - needs_you: flips assignee to configured human and posts pending question.
   * - exit needs_you: returns assignee to Commander bot and posts convergence comment.
   * - ready: moves ticket to Ready to review.
   * - user stop / done / idle / running: respects precedence (user stop is not completion).
   */
  private async checkLifecycleProjection(agentId: string, issueId: string): Promise<void> {
    const record = await this.agentStorage.get(agentId);
    if (record?.archivedAt) {
      return;
    }
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const bucket = await this.missionControl.getLifecycleBucket(agentId);
    const previousBucket = this.lastBucketByAgentId.get(agentId) ?? null;
    this.lastBucketByAgentId.set(agentId, bucket);

    const humanUserId = config.humanUserId;
    if (bucket === "needs_you") {
      if (previousBucket === "needs_you") {
        return;
      }
      if (humanUserId) {
        await this.enterNeedsYou(config, humanUserId, agentId, numericIssueId);
      }
      return;
    }

    if (previousBucket === "needs_you") {
      if (humanUserId) {
        await this.exitNeedsYou(agentId, numericIssueId, config);
      }
    }
    if (bucket === "running") {
      if (previousBucket !== "running") {
        await this.handleAgentRunning(agentId, issueId);
      }
      return;
    }

    if (bucket === "ready") {
      await this.handleAgentCompleted(agentId, issueId);
    }
  }

  private async enterNeedsYou(
    config: ItsaplanCentralConfig,
    humanUserId: string,
    agentId: string,
    numericIssueId: number,
  ): Promise<void> {
    const client = new ItsaplanClient(config);
    await client.updateAssignee(numericIssueId, humanUserId);
    await client.postComment(numericIssueId, this.resolvePendingQuestion(agentId));
  }

  /** Question text priority: latest clarification card > latest blocked
   * report > the live pending-permission prompt > generic fallback. */
  private resolvePendingQuestion(agentId: string): string {
    const remembered = this.lastQuestionByAgentId.get(agentId);
    if (remembered) {
      return remembered;
    }
    const pendingPermissions = this.agentManager.getAgent(agentId)?.pendingPermissions;
    if (pendingPermissions && pendingPermissions.size > 0) {
      const request = pendingPermissions.values().next().value;
      if (request) {
        const parts = [request.title, request.description].filter((part) => part !== undefined);
        if (parts.length > 0) {
          return parts.join("\n\n");
        }
      }
    }
    return "Waiting for input.";
  }

  private async exitNeedsYou(
    agentId: string,
    numericIssueId: number,
    config: ItsaplanCentralConfig,
  ): Promise<void> {
    const viaTicketComment = this.answeredViaTicketComment.has(agentId);
    this.answeredViaTicketComment.delete(agentId);
    const client = new ItsaplanClient(config);
    // The Commander bot user lives on the mapping; resolve it through the
    // issue's project. Unknown -> unassign rather than guess an assignee.
    const issue = await client.getIssue(numericIssueId);
    const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
    await client.updateAssignee(numericIssueId, mapping?.commanderUserId ?? null);
    await client.postComment(
      numericIssueId,
      viaTicketComment
        ? "Resumed — answered via ticket comment"
        : "Resumed — answered directly in Paseo",
    );
  }
  /**
   * When a workspace is archived, moves all associated tickets to Done (stateType "completed")
   * if they are not already in a completed column.
   */
  async handleWorkspaceArchived(workspaceId: string): Promise<void> {
    const config = this.getConfig();
    if (!config) {
      return;
    }
    const liveAgents = (this.agentManager.listAgents?.() ?? []).filter(
      (agent) => agent.workspaceId === workspaceId,
    );
    const storedAgents = await this.agentStorage.list();
    const workspaceStoredAgents = storedAgents.filter((agent) => agent.workspaceId === workspaceId);

    for (const agent of liveAgents) {
      this.lastBucketByAgentId.set(agent.id, "done");
    }
    for (const agent of workspaceStoredAgents) {
      this.lastBucketByAgentId.set(agent.id, "done");
    }

    const issueIds = new Set<string>();
    for (const agent of [...liveAgents, ...workspaceStoredAgents]) {
      const issueId = getItsaplanIssueIdFromLabels(agent.labels);
      if (issueId) {
        issueIds.add(issueId);
      }
    }

    if (issueIds.size === 0) {
      return;
    }

    const client = new ItsaplanClient(config);
    for (const issueId of issueIds) {
      const numericIssueId = Number(issueId);
      if (Number.isFinite(numericIssueId)) {
        await this.completeArchivedWorkspaceIssue(client, workspaceId, numericIssueId);
      }
    }
  }

  private async completeArchivedWorkspaceIssue(
    client: ItsaplanClient,
    workspaceId: string,
    numericIssueId: number,
  ): Promise<void> {
    try {
      const issue = await client.getIssue(numericIssueId);
      const projectKey = this.resolveProjectKey(issue);
      if (!projectKey) {
        return;
      }
      const columns = await client.listProjectColumns(projectKey);
      const currentColumn = columns.find((c) => c.id === issue.columnId);
      if (currentColumn?.stateType === "completed") {
        return;
      }
      const completedColumn =
        columns.find((c) => c.name === "Done" && c.stateType === "completed") ??
        columns.find((c) => c.stateType === "completed");
      if (completedColumn && issue.columnId !== completedColumn.id) {
        await client.moveIssueColumn(numericIssueId, completedColumn.id);
        this.logger.info(
          { workspaceId, issueId: numericIssueId, columnId: completedColumn.id },
          "itsaplan.bridge.workspace_archived_ticket_completed",
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId, issueId: numericIssueId },
        "itsaplan.bridge.workspace_archived_ticket_completion_failed",
      );
    }
  }

  /**
   * "Ticketize this agent": create an itsaplan ticket from an agent's
   * title/description, label the agent with the issue id, and post a
   * deep-link comment. Idempotent: returns existing ticket if already labeled.
   */
  async ticketizeAgent(
    agentId: string,
  ): Promise<{ issueId: number; url: string } | { error: string }> {
    const config = this.getConfig();
    if (!config) {
      return { error: "itsaplan bridge not configured" };
    }
    const client = new ItsaplanClient(config);

    const existing = await this.existingTicketForAgent(client, config, agentId);
    if (existing) {
      return existing;
    }

    const mappingOrError = await this.resolveTicketizeMapping(agentId);
    if ("error" in mappingOrError) {
      return mappingOrError;
    }
    const mapping = mappingOrError;

    const live = this.agentManager.getAgent(agentId);
    const stored = await this.agentStorage.get(agentId);
    const title = stored?.title || live?.name || `Agent ${agentId}`;
    const description = stored?.shortDescription || live?.shortDescription || "";

    const targetColumnId = await this.resolveTicketizeColumn(
      client,
      mapping.itsaplanProjectKey,
      agentId,
    );
    if (targetColumnId === undefined) {
      const bucket = await this.missionControl.getLifecycleBucket(agentId);
      return { error: `Could not resolve target column for lifecycle bucket ${bucket}` };
    }

    const createdIssue = await client.createIssue(mapping.itsaplanProjectKey, {
      columnId: targetColumnId,
      title,
      description: description.length > 0 ? description : undefined,
    });

    await this.agentManager.setLabels(agentId, {
      [ITSAPLAN_ISSUE_LABEL_KEY]: String(createdIssue.id),
    });
    await client.postComment(
      createdIssue.id,
      `Dispatched: paseo://h/${this.serverId}/agent/${agentId}`,
    );

    const url = `${config.baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(mapping.itsaplanProjectKey)}/issues/${createdIssue.sequenceNumber}`;
    return { issueId: createdIssue.id, url };
  }

  private async existingTicketForAgent(
    client: ItsaplanClient,
    config: ItsaplanCentralConfig,
    agentId: string,
  ): Promise<{ issueId: number; url: string } | null> {
    const existingLabels = await this.getAgentLabels(agentId);
    const existingIssueIdStr = getItsaplanIssueIdFromLabels(existingLabels);
    if (!existingIssueIdStr || !Number.isFinite(Number(existingIssueIdStr))) {
      return null;
    }
    const existingIssueId = Number(existingIssueIdStr);
    try {
      const issue = await client.getIssue(existingIssueId);
      const projectKey = this.resolveProjectKey(issue);
      if (!projectKey) {
        return null;
      }
      const url = `${config.baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(projectKey)}/issues/${issue.sequenceNumber}`;
      return { issueId: existingIssueId, url };
    } catch (err) {
      this.logger.warn(
        { err, agentId, existingIssueId },
        "itsaplan.bridge.ticketize_existing_issue_lookup_failed",
      );
      return null;
    }
  }

  /**
   * Resolves the itsaplan project key for an issue. Prefers the local project
   * mapping (which carries commanderUserId and other central-sync metadata),
   * but falls back to recovering the project key from the issue's own
   * identifier (e.g. "AMBIENTAISTA-9" -> "AMBIENTAISTA") so event-driven
   * projections work on peer hosts without a local projects.json file.
   */
  private resolveProjectKey(issue: { projectId: number; identifier?: string }): string | null {
    const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
    if (mapping?.itsaplanProjectKey) {
      return mapping.itsaplanProjectKey;
    }
    if (issue.identifier) {
      return extractProjectKeyFromIdentifier(issue.identifier);
    }
    return null;
  }

  private async resolveTicketizeMapping(
    agentId: string,
  ): Promise<ItsaplanProjectMapping | { error: string }> {
    const paseoProjectKey = this.resolvePaseoProjectKey
      ? await this.resolvePaseoProjectKey(agentId)
      : null;
    if (!paseoProjectKey) {
      return { error: `No Paseo project found for agent ${agentId}` };
    }
    const mapping = this.projectStore.getByPaseoProjectKey(paseoProjectKey);
    if (!mapping) {
      return { error: `No itsaplan project mapping found for Paseo project ${paseoProjectKey}` };
    }
    return mapping;
  }

  private async resolveTicketizeColumn(
    client: ItsaplanClient,
    projectKey: string,
    agentId: string,
  ): Promise<number | undefined> {
    const columns = await client.listProjectColumns(projectKey);
    const bucket = await this.missionControl.getLifecycleBucket(agentId);
    if (bucket === "running" || bucket === "needs_you") {
      return findInProgressColumn(columns)?.id;
    }
    if (bucket === "ready") {
      const readyCol = await client.ensureColumn(
        projectKey,
        ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
        "started",
      );
      return readyCol.id;
    }
    if (bucket === "done") {
      return columns.find((c) => c.stateType === "completed")?.id;
    }
    return columns.find((c) => c.stateType === "unstarted")?.id;
  }
}
