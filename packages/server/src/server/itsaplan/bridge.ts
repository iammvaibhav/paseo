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
  buildItsaplanIssueUrl,
  findInProgressColumn,
  ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
  ItsaplanApiError,
  ItsaplanClient,
  type ItsaplanIssue,
} from "./client.js";
import {
  resolveTicketAttachments,
  rewriteMarkdownAttachmentUrls,
  stripNativeMarkdownImages,
} from "./ticket-images.js";
import {
  isHomeDirectoryRoot,
  ITSAPLAN_WEBHOOK_EVENTS,
  type ItsaplanCentralConfig,
  type ItsaplanProjectMapping,
  type ItsaplanProjectStore,
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
/** Feed pages (100 items each) searched for an earlier "Dispatched" comment. */
const MAX_FEED_PAGES_FOR_DISPATCH_CHECK = 5;

const ItsaplanWebhookIssueDataSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  sequenceNumber: z.number(),
  identifier: z.string().optional(),
  columnId: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  delegateUserId: z.string().nullable().optional(),
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

type DispatchableIssue = Pick<
  z.infer<typeof ItsaplanWebhookIssueDataSchema>,
  "id" | "sequenceNumber" | "title" | "description" | "initiative" | "initiativeId"
>;

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
    | "labels"
    | "title"
    | "name"
    | "shortDescription"
    | "cwd"
    | "workspaceId"
    | "archivedAt"
    | "attentionReason"
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

export interface ItsaplanWorkerDispatch {
  title: string;
  brief: string;
  images?: Array<{ data: string; mimeType: string }>;
  labels: Record<string, string>;
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
   * Starts the ticket's worker agent: placed from the brief (host, project,
   * model, mode) and labeled with the ticket so the bridge tracks it.
   * Returns the new agent id, or null when it could not be created. Injected
   * so this module stays testable; bootstrap.ts wires fleet_create_agent.
   */
  dispatchWorker: (input: ItsaplanWorkerDispatch) => Promise<string | null>;
  /**
   * Steers the agent the user is answering mid-turn — the same path a user
   * message in Paseo takes for a blocked worker (sendPromptToAgent with
   * activeTurnBehavior "steer"). Injected rather than imported so tests can
   * fake delivery; bootstrap.ts wires sendPromptToAgent.
   */
  steerWorkerPrompt: (agentId: string, prompt: string) => Promise<void>;
  /** Closed-ticket archive (handleTicketCompletedOrCanceled). bootstrap.ts wires
   * the real registries and archive commands; tests leave them out unless they
   * exercise the archive. */
  workspaceRegistry?: { get: (id: string) => Promise<{ archivedAt?: string | null } | null> };
  projectRegistry?: {
    list: () => Promise<Array<{ baseWorkspaceId?: string | null; archivedAt?: string | null }>>;
  };
  archiveWorkspace?: (workspaceId: string, requestId: string) => Promise<unknown>;
  /** Cancels a running agent, then archives it (archiveAgentCommand). */
  archiveAgent?: (agentId: string) => Promise<unknown>;
  /** This daemon's webhook URL: a board whose webhook delivers here is one this
   * host dispatches (reconcileOwnedBoards). */
  getWebhookUrl?: () => string | null;
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
    if (!target) {
      return `- ${label}`;
    }
    if (target.startsWith("paseo://")) {
      return `- [${label}](${target})`;
    }
    return `- ${label}: ${target}`;
  });
  return ["Ready for review.", "", "Proofs:", ...lines].join("\n");
}

export interface BuildDispatchPromptInput {
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

/** Self-reported progress the bridge mirrors onto the ticket (not blocked/finished: those move columns). */
function isMilestoneReport(event: MissionControlEvent): boolean {
  return (
    event.source === "self" &&
    (event.kind === "milestone" || event.kind === "finding" || event.kind === "diverged")
  );
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatAskComment(ask: string): string {
  return `Vaibhav asked:\n\n${quote(ask)}`;
}

export function formatUserPromptComment(text: string): string {
  return `Vaibhav asked (in the app):\n\n${quote(text)}`;
}

export function formatMilestoneComment(event: MissionControlEvent): string {
  const kind = event.reportKind ?? "milestone";
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return event.detail
    ? `${label}: ${event.headline}\n\n${event.detail}`
    : `${label}: ${event.headline}`;
}

export function buildDispatchPrompt(input: BuildDispatchPromptInput): string {
  const lines: string[] = [
    `You own itsaplan ticket ${input.ticketKey}. Work it to done and report on it.`,
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
      `${input.nativeImageCount} image${input.nativeImageCount === 1 ? "" : "s"} from the ticket ${input.nativeImageCount === 1 ? "is" : "are"} attached to this message.`,
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
    "Use the ticketed-work and verifiable-artifact skills. Paseo moves the ticket's column and mirrors your report_status milestones onto it; do not move columns yourself.",
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
  private readonly dispatchWorker: ItsaplanBridgeOptions["dispatchWorker"];
  private readonly steerWorkerPrompt: (agentId: string, prompt: string) => Promise<void>;
  private readonly resolvePaseoProjectKey?: (agentId: string) => Promise<string | null>;
  private readonly workspaceRegistry?: ItsaplanBridgeOptions["workspaceRegistry"];
  private readonly projectRegistry?: ItsaplanBridgeOptions["projectRegistry"];
  private readonly archiveWorkspace?: ItsaplanBridgeOptions["archiveWorkspace"];
  private readonly archiveAgent?: ItsaplanBridgeOptions["archiveAgent"];
  private readonly getWebhookUrl?: ItsaplanBridgeOptions["getWebhookUrl"];

  private readonly seenAgentIds = new Set<string>();
  private readonly lastBucketByAgentId = new Map<string, LifecycleBucket>();
  /** The turn each agent reported completed in; the rest of that turn is not new work. */
  private readonly completedTurnByAgentId = new Map<string, string>();
  private readonly processedWebhookEventIds = new Set<string>();
  /** Tickets whose closed-ticket archive is in flight (webhook or reconcile). */
  private readonly closingIssueIds = new Set<string>();
  /** Tickets whose worker dispatch is in flight (webhook or reconcile). */
  private readonly dispatchingIssueIds = new Set<number>();
  /** Agents whose needs_you exit was caused by a ticket comment (vs a direct
   * Paseo answer); drives the convergence-comment wording on bucket exit. */
  private readonly answeredViaTicketComment = new Set<string>();
  /** Latest clarification/blocked question text per agent, kept fresh from
   * the mission-control feed so a needs_you entry comment can quote what the
   * agent is actually asking. */
  private readonly lastQuestionByAgentId = new Map<string, string>();
  private readonly lastCommentByIssueId = new Map<number, { body: string; timestamp: number }>();
  private static readonly MAX_TRACKED_COMMENTS = 500;
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
    this.dispatchWorker = options.dispatchWorker;
    this.steerWorkerPrompt = options.steerWorkerPrompt;
    this.resolvePaseoProjectKey = options.resolvePaseoProjectKey;
    this.workspaceRegistry = options.workspaceRegistry;
    this.projectRegistry = options.projectRegistry;
    this.archiveWorkspace = options.archiveWorkspace;
    this.archiveAgent = options.archiveAgent;
    this.getWebhookUrl = options.getWebhookUrl;
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
    if (
      envelope.event === "issue.created" ||
      envelope.event === "issue.state_changed" ||
      envelope.event === "issue.assigned"
    ) {
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
      const isAssignedToCommander = await this.isIssueAssignedToCommander(client, mapping, issue);
      if (!isAssignedToCommander) {
        this.logger.info(
          {
            issueId: issue.id,
            assigneeUserId: issue.assigneeUserId,
            delegateUserId: issue.delegateUserId,
            commanderUserId: mapping.commanderUserId,
          },
          "itsaplan.bridge.issue_dispatch_skipped_not_assigned_to_commander",
        );
        return;
      }

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
    if (column.stateType === "completed" || column.stateType === "canceled") {
      this.projectCompletedColumnOntoAgent(issue, column);
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
    issue: DispatchableIssue,
    client?: ItsaplanClient,
  ): Promise<void> {
    // The webhook and the reconcile pass can reach the same Todo ticket at once.
    if (this.dispatchingIssueIds.has(issue.id)) {
      return;
    }
    this.dispatchingIssueIds.add(issue.id);
    try {
      await this.dispatchIssueOnce(mapping, config, issue, client ?? new ItsaplanClient(config));
    } finally {
      this.dispatchingIssueIds.delete(issue.id);
    }
  }

  private async dispatchIssueOnce(
    mapping: ItsaplanProjectMapping,
    config: ItsaplanCentralConfig,
    issue: DispatchableIssue,
    apiClient: ItsaplanClient,
  ): Promise<void> {
    const ticketKey = `${mapping.itsaplanProjectKey}-${issue.sequenceNumber}`;
    const url = buildItsaplanIssueUrl(config, mapping.itsaplanProjectKey, issue.sequenceNumber);

    const [initiative, attachments] = await Promise.all([
      this.resolveInitiativeContext(apiClient, issue),
      resolveTicketAttachments(apiClient, issue.id, config.baseUrl).catch(() => ({
        images: [],
        files: [],
      })),
    ]);

    const prompt = buildDispatchPrompt({
      ticketKey,
      title: issue.title,
      body: issue.description ?? "",
      url,
      projectKey: mapping.paseoProjectKey,
      initiative,
      attachments: attachments.files.length > 0 ? attachments.files : undefined,
      nativeImageCount: attachments.images.length,
    });
    if (await this.hasLiveAgentForIssue(issue.id)) {
      // A webhook redelivery, or the reconcile pass racing it: the ticket
      // already has its worker.
      this.logger.info(
        { issueId: issue.id, ticketKey },
        "itsaplan.bridge.dispatch_skipped_has_agent",
      );
      return;
    }
    const agentId = await this.dispatchWorker({
      title: `${ticketKey} ${issue.title}`.slice(0, 60),
      brief: prompt,
      ...(attachments.images.length > 0 ? { images: attachments.images } : {}),
      labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(issue.id) },
    });
    if (!agentId) {
      this.logger.warn({ issueId: issue.id, ticketKey }, "itsaplan.bridge.worker_dispatch_failed");
      return;
    }
    this.logger.info(
      { issueId: issue.id, ticketKey, agentId },
      "itsaplan.bridge.worker_dispatched",
    );
    // Leaving Todo right away is what makes dispatch idempotent across
    // restarts: the reconcile pass only dispatches tickets still in Todo, and
    // the worker may run on a peer whose own projection lands later (or, while
    // that peer is offline, not at all).
    const inProgress = findInProgressColumn(
      await apiClient.listProjectColumns(mapping.itsaplanProjectKey),
    );
    if (inProgress) {
      await apiClient.moveIssueColumn(issue.id, inProgress.id);
    }
  }

  /** A non-archived agent labeled with the ticket, here or on a reachable peer. */
  private async hasLiveAgentForIssue(issueId: number): Promise<boolean> {
    const local = await this.findAllAgentsByIssueLabel(String(issueId));
    if (local.some((record) => !record.archivedAt)) {
      return true;
    }
    const remote = await this.fleet?.findAgentByIssue(String(issueId)).catch(() => null);
    return Boolean(remote);
  }

  /**
   * Repair pass over the boards whose webhook this host owns (it is their
   * dispatcher), run by the reconcile sweep at boot and every few minutes, so a
   * host that was asleep or unreachable catches up on what itsaplan could not
   * deliver: a webhook itsaplan auto-disabled after repeated failures is
   * re-enabled, and every Todo ticket goes through the same path a webhook
   * takes (dispatch only when assigned to the bot and unblocked, never twice).
   */
  async reconcileOwnedBoards(): Promise<void> {
    const config = this.getConfig();
    if (!config) {
      return;
    }
    const client = new ItsaplanClient(config);
    for (const mapping of this.projectStore.list()) {
      if (mapping.webhookId === undefined) {
        continue;
      }
      try {
        await this.reconcileOwnedBoard(mapping, config, client);
      } catch (error) {
        if (error instanceof ItsaplanApiError && error.status === 429) {
          throw error;
        }
        // 404: a deleted board; the next project resync drops its mapping.
        if (!(error instanceof ItsaplanApiError && error.status === 404)) {
          this.logger.warn(
            { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey },
            "itsaplan.bridge.board_reconcile_failed",
          );
        }
      }
    }
  }

  private async reconcileOwnedBoard(
    mapping: ItsaplanProjectMapping,
    config: ItsaplanCentralConfig,
    client: ItsaplanClient,
  ): Promise<void> {
    const webhooks = await client.listWebhooks(mapping.itsaplanProjectKey);
    const mine = webhooks.find((webhook) => webhook.id === mapping.webhookId);
    // Only the host itsaplan delivers to dispatches the board's tickets.
    if (!mine || mine.url !== this.getWebhookUrl?.()) {
      return;
    }
    if (mine.isActive === false) {
      await client.updateWebhook(mine.id, { events: [...ITSAPLAN_WEBHOOK_EVENTS], isActive: true });
      this.logger.info(
        { itsaplanProjectKey: mapping.itsaplanProjectKey, webhookId: mine.id },
        "itsaplan.bridge.webhook_reactivated",
      );
    }
    const columns = await client.listProjectColumns(mapping.itsaplanProjectKey);
    const todo = new Set(
      columns.filter((column) => column.stateType === "unstarted").map((column) => column.id),
    );
    const { issues } = await client.listBoardIssues(mapping.itsaplanProjectKey);
    for (const issue of issues) {
      if (todo.has(issue.columnId)) {
        await this.handleIssueStateChanged(issue, config);
      }
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
  /**
   * Evaluates whether an issue is assigned or delegated to the project's
   * Commander bot user. Automated dispatch strictly gates on this: issues
   * assigned to humans (or unassigned without a Commander delegate) are not
   * dispatched to the Commander.
   */
  private async isIssueAssignedToCommander(
    client: ItsaplanClient,
    mapping: ItsaplanProjectMapping,
    issue: {
      id: number;
      assigneeUserId?: string | null;
      delegateUserId?: string | null;
    },
  ): Promise<boolean> {
    const commanderUserId = mapping.commanderUserId;
    if (!commanderUserId) {
      return false;
    }
    let assigneeUserId = issue.assigneeUserId;
    let delegateUserId = issue.delegateUserId;
    if (
      assigneeUserId !== commanderUserId &&
      delegateUserId !== commanderUserId &&
      (assigneeUserId === undefined || delegateUserId === undefined)
    ) {
      try {
        const fullIssue = await client.getIssue(issue.id);
        assigneeUserId = fullIssue.assigneeUserId;
        delegateUserId = fullIssue.delegateUserId;
      } catch (error) {
        this.logger.warn(
          { err: error, issueId: issue.id },
          "itsaplan.bridge.fetch_issue_for_assignment_check_failed",
        );
        return false;
      }
    }
    return assigneeUserId === commanderUserId || delegateUserId === commanderUserId;
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
        const isAssignedToCommander = await this.isIssueAssignedToCommander(
          client,
          mapping,
          dependent,
        );
        if (isAssignedToCommander) {
          await this.dispatchIssue(mapping, config, dependent, client);
        } else {
          this.logger.info(
            {
              issueId: dependent.id,
              assigneeUserId: dependent.assigneeUserId,
              delegateUserId: dependent.delegateUserId,
              commanderUserId: mapping.commanderUserId,
            },
            "itsaplan.bridge.dependent_dispatch_skipped_not_assigned_to_commander",
          );
        }
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

  /**
   * A ticket moved into a completed or canceled column: the ticket's work is
   * over, so its linked agents are marked done and archived (a running agent is
   * cancelled first), and each of their workspaces is archived unless another
   * live agent still works in it. Terminals, editors and other non-agent things
   * open in the workspace do not keep it alive.
   *
   * Agents are looked up locally first, then across the fleet, because webhook
   * ingress terminates on one host while the agent commonly runs on another. A
   * peer only gets the done mark from here; its own reconcile sweep archives the
   * agent and workspace (ItsaplanReconcileService).
   *
   * The bucket is read before writing so an inbound move cannot bounce back out
   * as an outbound projection event.
   */
  async handleTicketCompletedOrCanceled(
    issueId: string | number,
    column?: { id: number; name: string; stateType?: string },
  ): Promise<void> {
    const issueIdStr = String(issueId);
    if (this.closingIssueIds.has(issueIdStr)) {
      return;
    }
    this.closingIssueIds.add(issueIdStr);
    try {
      await this.closeTicketAgents(issueIdStr, column);
    } finally {
      this.closingIssueIds.delete(issueIdStr);
    }
  }

  private async closeTicketAgents(
    issueId: string,
    column?: { id: number; name: string; stateType?: string },
  ): Promise<void> {
    const localAgents = (await this.findAllAgentsByIssueLabel(issueId)).filter(
      (record) => !record.archivedAt,
    );
    if (localAgents.length > 0) {
      await this.closeLocalTicketAgents(issueId, localAgents, column);
      return;
    }
    await this.markRemoteTicketAgentDone(issueId, column);
  }

  private async closeLocalTicketAgents(
    issueId: string,
    agents: readonly Pick<StoredAgentRecord, "id" | "workspaceId">[],
    column?: { id: number; name: string },
  ): Promise<void> {
    const workspaceIds = new Set<string>();
    for (const record of agents) {
      const bucket = await this.missionControl.getLifecycleBucket(record.id).catch(() => null);
      if (bucket !== "done") {
        await this.missionControl.setLifecycle({ agentId: record.id, action: "done" });
      }
      // Marking done can already have archived the workspace (and the agent
      // with it), so archive only what is still live.
      const current = await this.agentStorage.get(record.id);
      if (current && !current.archivedAt && this.archiveAgent) {
        await this.archiveAgent(record.id).catch((err: unknown) => {
          this.logger.warn({ err, agentId: record.id }, "itsaplan.bridge.archive_agent_failed");
        });
      }
      const workspaceId = current?.workspaceId ?? record.workspaceId;
      if (workspaceId) {
        workspaceIds.add(workspaceId);
      }
      this.logCompletedProjection(
        { id: Number(issueId) },
        column ?? { id: 0, name: "Done" },
        record.id,
        "local",
        { ok: true },
      );
    }
    for (const workspaceId of workspaceIds) {
      await this.maybeArchiveWorkspaceForCompletedTicket(workspaceId, issueId);
    }
  }

  /** The agent runs on a peer: mark it done there. The peer's own reconcile
   * sweep archives it and its workspace. */
  private async markRemoteTicketAgentDone(
    issueId: string,
    column?: { id: number; name: string },
  ): Promise<void> {
    let remote: { agentId: string; host: string } | null = null;
    try {
      remote = (await this.fleet?.findAgentByIssue(issueId)) ?? null;
    } catch (error) {
      this.logger.warn({ err: error, issueId }, "itsaplan.bridge.fleet_agent_lookup_failed");
      return;
    }
    if (!remote || !this.fleet) {
      this.logger.info(
        { issueId, columnId: column?.id, columnName: column?.name },
        "itsaplan.bridge.completed_issue_no_linked_agent",
      );
      return;
    }
    const result = await this.fleet.setLifecycle({
      host: remote.host,
      agentId: remote.agentId,
      action: "done",
    });
    this.logCompletedProjection(
      { id: Number(issueId) },
      column ?? { id: 0, name: "Done" },
      remote.agentId,
      remote.host,
      result,
    );
  }

  private async maybeArchiveWorkspaceForCompletedTicket(
    workspaceId: string,
    issueId: string,
  ): Promise<void> {
    if (!this.archiveWorkspace) {
      return;
    }
    if (this.workspaceRegistry) {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (!workspace || workspace.archivedAt) {
        return;
      }
    }
    if (this.projectRegistry) {
      const projects = await this.projectRegistry.list();
      const isBaseWorkspace = projects.some(
        (project) => !project.archivedAt && project.baseWorkspaceId === workspaceId,
      );
      if (isBaseWorkspace) {
        this.logger.info(
          { workspaceId, issueId },
          "itsaplan.bridge.workspace_archive_skipped_base_workspace",
        );
        return;
      }
    }

    // Every agent has a stored record; a live agent the store has not caught up
    // with yet still counts unless the store says it is archived.
    const storedRecords = await this.agentStorage.list();
    const archivedIds = new Set(
      storedRecords.filter((record) => record.archivedAt).map((record) => record.id),
    );
    const otherActiveAgents = new Set<string>();
    for (const record of storedRecords) {
      if (
        record.workspaceId === workspaceId &&
        !record.archivedAt &&
        getItsaplanIssueIdFromLabels(record.labels) !== issueId
      ) {
        otherActiveAgents.add(record.id);
      }
    }
    for (const liveAgent of this.agentManager.listAgents?.() ?? []) {
      if (
        liveAgent.workspaceId === workspaceId &&
        !archivedIds.has(liveAgent.id) &&
        getItsaplanIssueIdFromLabels(liveAgent.labels) !== issueId
      ) {
        otherActiveAgents.add(liveAgent.id);
      }
    }

    if (otherActiveAgents.size > 0) {
      this.logger.info(
        { workspaceId, issueId, otherActiveAgents: [...otherActiveAgents] },
        "itsaplan.bridge.workspace_archive_blocked_by_other_agents",
      );
      return;
    }

    const requestId = `auto-archive-workspace-ticket-done-${issueId}-${workspaceId}-${Date.now()}`;
    this.logger.info({ issueId, workspaceId, requestId }, "itsaplan.bridge.auto_archive_workspace");
    try {
      await this.archiveWorkspace(workspaceId, requestId);
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId, issueId },
        "itsaplan.bridge.auto_archive_workspace_failed",
      );
    }
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

  /**
   * Runs the closed-ticket archive without holding the webhook response: an
   * archive deletes a worktree and can take far longer than itsaplan's delivery
   * timeout, and a timed-out delivery is retried. The reconcile sweep re-runs
   * this for any ticket whose agents are still live, so a failure here heals.
   */
  private projectCompletedColumnOntoAgent(
    issue: { id: number },
    column: { id: number; name: string; stateType?: string },
  ): void {
    void this.handleTicketCompletedOrCanceled(issue.id, column).catch((error: unknown) => {
      this.logger.error(
        { err: error, issueId: issue.id },
        "itsaplan.bridge.closed_ticket_archive_failed",
      );
    });
  }

  private async findAllAgentsByIssueLabel(
    issueId: string,
  ): Promise<
    Pick<StoredAgentRecord, "id" | "labels" | "updatedAt" | "workspaceId" | "archivedAt">[]
  > {
    const records = await this.agentStorage.list();
    return records.filter((record) => getItsaplanIssueIdFromLabels(record.labels) === issueId);
  }

  private async findAgentIdByIssueLabel(issueId: string): Promise<string | null> {
    const agents = await this.findAllAgentsByIssueLabel(issueId);
    const latest = agents.reduce<Pick<StoredAgentRecord, "id" | "updatedAt"> | null>(
      (newest, record) => {
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
      const live = this.agentManager.getAgent(event.agentId);
      const turnId = live?.activeTurnId ?? live?.activeForegroundTurnId;
      if (turnId) {
        this.completedTurnByAgentId.set(event.agentId, turnId);
      }
      this.lastBucketByAgentId.set(event.agentId, "ready");
      await this.handleAgentCompleted(event.agentId, issueId, event.proof);
      return;
    }
    if (isMilestoneReport(event)) {
      await this.mirrorMilestone(event, issueId);
    }
    await this.checkLifecycleProjection(event.agentId, issueId);
  }

  /**
   * A prompt Vaibhav sent the agent directly (from the app) goes onto the
   * agent's ticket, so the ticket keeps the whole conversation about the work.
   */
  async mirrorUserPrompt(agentId: string, text: string): Promise<void> {
    this.completedTurnByAgentId.delete(agentId);
    const issueId = getItsaplanIssueIdFromLabels(await this.getAgentLabels(agentId));
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!issueId || !config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const issue = await new ItsaplanClient(config).getIssue(numericIssueId);
    const commentClient = this.getCommentClient(config, issue.projectId);
    await this.postDeduplicatedComment(
      commentClient,
      numericIssueId,
      formatUserPromptComment(text),
    );
    this.logger.info({ agentId, issueId }, "itsaplan.bridge.user_prompt_mirrored");
  }

  /** A worker's milestone report becomes a ticket comment, so the ticket is the record of progress. */
  private async mirrorMilestone(event: MissionControlEvent, issueId: string): Promise<void> {
    const config = this.getConfig();
    const numericIssueId = Number(issueId);
    if (!config || !Number.isFinite(numericIssueId)) {
      return;
    }
    const issue = await new ItsaplanClient(config).getIssue(numericIssueId);
    const commentClient = this.getCommentClient(config, issue.projectId);
    await this.postDeduplicatedComment(
      commentClient,
      numericIssueId,
      formatMilestoneComment(event),
    );
    this.logger.info({ agentId: event.agentId, issueId }, "itsaplan.bridge.milestone_mirrored");
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
    const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
    const commentClient = this.getCommentClient(config, mapping);
    const record = await this.agentStorage.get(agentId);
    const live = this.agentManager.getAgent(agentId);
    const title = record?.title || live?.name || `Agent ${agentId}`;
    const uri = `paseo://h/${encodeURIComponent(this.serverId)}/agent/${encodeURIComponent(agentId)}`;
    // "First sighting" is per process: after a daemon restart every labeled
    // agent is sighted again, so the ticket itself says whether it was announced.
    if (await this.ticketAnnouncesAgent(client, numericIssueId, uri)) {
      return;
    }
    await this.postDeduplicatedComment(
      commentClient,
      numericIssueId,
      `Dispatched: [${title}](${uri})`,
    );
  }

  /** Whether the ticket already has a "Dispatched" comment linking this agent. Unknown (feed unreadable) → false. */
  private async ticketAnnouncesAgent(
    client: ItsaplanClient,
    issueId: number,
    agentUri: string,
  ): Promise<boolean> {
    let cursor: string | null = null;
    try {
      for (let page = 0; page < MAX_FEED_PAGES_FOR_DISPATCH_CHECK; page += 1) {
        const feed = await client.listIssueFeedPage(issueId, cursor);
        if (
          feed.items.some(
            (item) =>
              item.kind === "comment" &&
              item.body?.startsWith("Dispatched:") === true &&
              item.body.includes(`(${agentUri})`),
          )
        ) {
          return true;
        }
        cursor = feed.nextCursor;
        if (!cursor) return false;
      }
    } catch (error) {
      this.logger.warn({ err: error, issueId }, "itsaplan.bridge.dispatch_check_failed");
    }
    return false;
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
      const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
      const commentClient = this.getCommentClient(config, mapping);
      await this.postDeduplicatedComment(commentClient, numericIssueId, formatProofsComment(proof));
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
    if (bucket === previousBucket) {
      return;
    }
    this.lastBucketByAgentId.set(agentId, bucket);

    const humanUserId = config.humanUserId;
    if (bucket === "needs_you") {
      await this.handleAgentRunning(agentId, issueId);
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
      // An agent reports completed and then ends its turn: the rest of the
      // reporting turn must not move the ticket back to In Progress.
      const live = this.agentManager.getAgent(agentId);
      const turnId = live?.activeTurnId ?? live?.activeForegroundTurnId;
      if (turnId && this.completedTurnByAgentId.get(agentId) === turnId) {
        this.lastBucketByAgentId.set(agentId, "ready");
        return;
      }
      await this.handleAgentRunning(agentId, issueId);
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
    const issue = await client.getIssue(numericIssueId).catch(() => null);
    const commentClient = this.getCommentClient(config, issue?.projectId);
    await this.postDeduplicatedComment(
      commentClient,
      numericIssueId,
      await this.resolvePendingQuestion(agentId),
    );
  }
  /** Question text priority: latest clarification card > latest blocked
   * report > the live pending-permission prompt > a failed or interrupted run
   * > generic fallback. */
  private async resolvePendingQuestion(agentId: string): Promise<string> {
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
    const record = await this.agentStorage.get(agentId).catch(() => null);
    if (record?.attentionReason === "error") {
      return "The agent stopped before finishing: its run failed or was cut off by a daemon restart. Open it and re-prompt to continue, or move this ticket to Done to archive it.";
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
    const commentClient = this.getCommentClient(config, mapping);
    await this.postDeduplicatedComment(
      commentClient,
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
  /**
   * Give an agent its ticket: link `ticket` (a key like PASEO-71, or an issue
   * id) when given, else keep the one it has, else create one on its project's
   * board. `ask` (Vaibhav's words) becomes the new ticket's description and a
   * comment on the ticket either way.
   */
  async ticketizeAgent(
    agentId: string,
    options: { ticket?: string; ask?: string } = {},
  ): Promise<{ issueId: number; url: string } | { error: string }> {
    const config = this.getConfig();
    if (!config) {
      return { error: "itsaplan bridge not configured" };
    }
    const client = new ItsaplanClient(config);
    const ticket = options.ticket
      ? await this.linkTicket(client, config, agentId, options.ticket)
      : ((await this.existingTicketForAgent(client, config, agentId)) ??
        (await this.createTicketForAgent(client, config, agentId, options.ask)));
    if ("error" in ticket || !options.ask?.trim()) {
      return ticket;
    }
    const issue = await client.getIssue(ticket.issueId);
    await this.postDeduplicatedComment(
      this.getCommentClient(config, issue.projectId),
      ticket.issueId,
      formatAskComment(options.ask),
    );
    return ticket;
  }

  /** Label the agent with an existing ticket; the lifecycle projection then moves it and comments. */
  private async linkTicket(
    client: ItsaplanClient,
    config: ItsaplanCentralConfig,
    agentId: string,
    ticket: string,
  ): Promise<{ issueId: number; url: string } | { error: string }> {
    const keyMatch = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ticket.trim());
    let issue: ItsaplanIssue;
    try {
      issue = keyMatch
        ? await client.getIssueByKey(keyMatch[1]!.toUpperCase(), Number(keyMatch[2]))
        : await client.getIssue(Number(ticket));
    } catch (error) {
      return { error: `Ticket "${ticket}" not found: ${String(error)}` };
    }
    const projectKey = this.resolveProjectKey(issue);
    if (!projectKey) {
      return { error: `Ticket "${ticket}" has no resolvable project` };
    }
    await this.agentManager.setLabels(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(issue.id) });
    return {
      issueId: issue.id,
      url: buildItsaplanIssueUrl(config, projectKey, issue.sequenceNumber),
    };
  }

  private async createTicketForAgent(
    client: ItsaplanClient,
    config: ItsaplanCentralConfig,
    agentId: string,
    ask: string | undefined,
  ): Promise<{ issueId: number; url: string } | { error: string }> {
    const mappingOrError = await this.resolveTicketizeMapping(agentId);
    if ("error" in mappingOrError) {
      return mappingOrError;
    }
    const mapping = mappingOrError;

    const live = this.agentManager.getAgent(agentId);
    const stored = await this.agentStorage.get(agentId);
    const title = stored?.title || live?.name || `Agent ${agentId}`;
    const description = ask?.trim() || stored?.shortDescription || live?.shortDescription || "";

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
    const commentClient = this.getCommentClient(config, mapping);
    const uri = `paseo://h/${encodeURIComponent(this.serverId)}/agent/${encodeURIComponent(agentId)}`;
    await this.postDeduplicatedComment(
      commentClient,
      createdIssue.id,
      `Dispatched: [${title}](${uri})`,
    );
    const url = buildItsaplanIssueUrl(
      config,
      mapping.itsaplanProjectKey,
      createdIssue.sequenceNumber,
    );
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
      const url = buildItsaplanIssueUrl(config, projectKey, issue.sequenceNumber);
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
      const hostPathMatch = /^host:[^:]+:(.+)$/.exec(paseoProjectKey);
      if (hostPathMatch && isHomeDirectoryRoot(hostPathMatch[1]!)) {
        return {
          error: `Cannot ticketize agent in home folder project (${hostPathMatch[1]}): home directories do not have an itsaplan board. Move agent to a mapped project or experiments first.`,
        };
      }
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

  private getCommentClient(
    config: ItsaplanCentralConfig,
    projectIdOrMapping?: ItsaplanProjectMapping | number | string | null,
  ): ItsaplanClient {
    let mapping: ItsaplanProjectMapping | null = null;
    if (typeof projectIdOrMapping === "object" && projectIdOrMapping !== null) {
      mapping = projectIdOrMapping;
    } else if (typeof projectIdOrMapping === "number") {
      mapping = this.projectStore.getByItsaplanProjectId(projectIdOrMapping);
    } else if (typeof projectIdOrMapping === "string") {
      mapping =
        this.projectStore.getByPaseoProjectKey(projectIdOrMapping) ??
        this.projectStore.list().find((m) => m.itsaplanProjectKey === projectIdOrMapping) ??
        null;
    }
    const apiKey = mapping?.commanderApiKey ?? config.apiKey;
    return new ItsaplanClient({
      baseUrl: config.baseUrl,
      apiKey,
    });
  }

  private async postDeduplicatedComment(
    client: ItsaplanClient,
    issueId: number,
    body: string,
  ): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    const last = this.lastCommentByIssueId.get(issueId);
    if (last && last.body === trimmed && Date.now() - last.timestamp < 60_000) {
      this.logger.info({ issueId, body: trimmed }, "itsaplan.bridge.duplicate_comment_suppressed");
      return;
    }
    this.lastCommentByIssueId.set(issueId, { body: trimmed, timestamp: Date.now() });
    if (this.lastCommentByIssueId.size > ItsaplanBridge.MAX_TRACKED_COMMENTS) {
      const oldestKey = this.lastCommentByIssueId.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastCommentByIssueId.delete(oldestKey);
      }
    }
    await client.postComment(issueId, trimmed);
  }
}
