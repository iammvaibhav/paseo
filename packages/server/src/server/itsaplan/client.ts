import { z } from "zod";

/**
 * Minimal REST client for a self-hosted itsaplan instance (ADR 0002). Covers
 * exactly the surface the bridge needs — ticket read/move, column discovery
 * and lazy creation, comments, project/webhook provisioning, links, and
 * assignee updates. Auth is `x-api-key` (itsaplan's "AI agent"/personal API
 * key header, see local://itsaplan-core.md §2 "Auth mechanism").
 */

export interface ItsaplanClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout; default 15s. */
  requestTimeoutMs?: number;
}

export type ItsaplanColumnStateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type ItsaplanLinkKind = "blocks" | "relates" | "duplicates";

const ItsaplanColumnSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  stateType: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
  color: z.string().optional(),
  position: z.number().optional(),
});
export type ItsaplanColumn = z.infer<typeof ItsaplanColumnSchema>;

// One relation as GET /issues/:id carries it: the relation reads from the
// queried issue, `direction` says which side of it the issue sits on, and
// `issue` names the other end.
const ItsaplanIssueLinkWireSchema = z.object({
  id: z.number(),
  kind: z.enum(["blocks", "relates", "duplicates"]),
  direction: z.enum(["outward", "inward"]),
  issue: z.object({ id: z.number() }),
});
type ItsaplanIssueLinkWire = z.infer<typeof ItsaplanIssueLinkWireSchema>;

// The relation normalized to its stored row shape: the source of a "blocks"
// row blocks, its target is blocked by. Resolved against the queried issue id,
// because the wire payload only names the other end.
export interface ItsaplanIssueLink {
  id: number;
  kind: "blocks" | "relates" | "duplicates";
  sourceIssueId: number;
  targetIssueId: number;
}

function normalizeIssueLink(issueId: number, wire: ItsaplanIssueLinkWire): ItsaplanIssueLink {
  const otherIssueId = wire.issue.id;
  return wire.direction === "outward"
    ? { id: wire.id, kind: wire.kind, sourceIssueId: issueId, targetIssueId: otherIssueId }
    : { id: wire.id, kind: wire.kind, sourceIssueId: otherIssueId, targetIssueId: issueId };
}

const ItsaplanLabelSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  color: z.string().optional(),
});
export type ItsaplanLabel = z.infer<typeof ItsaplanLabelSchema>;

const ItsaplanIssueSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  // "<PROJECT KEY>-<sequenceNumber>", e.g. AMBIENTAISTA-9. The only response
  // field carrying the project's KEY rather than its numeric id, which is what
  // lets a host with no local project mapping still resolve the board.
  identifier: z.string().optional(),
  sequenceNumber: z.number(),
  identifier: z.string().optional(),
  columnId: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  delegateUserId: z.string().nullable().optional(),
  labelIds: z.array(z.number()).optional(),
  links: z.array(ItsaplanIssueLinkWireSchema).optional(),
});
export type ItsaplanIssue = z.infer<typeof ItsaplanIssueSchema>;

const ItsaplanProjectSchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  // The Paseo sync stamps the full cross-host paseoProjectKey here so a
  // create-key 409 can tell its own earlier crashed attempt (adopt) from
  // another paseo project whose derived name collides (suffix around it).
  description: z.string().nullable().optional(),
  columns: z.array(ItsaplanColumnSchema).optional(),
  labels: z.array(ItsaplanLabelSchema).optional(),
});
export type ItsaplanProject = z.infer<typeof ItsaplanProjectSchema>;

/**
 * Live GET /projects/:key returns a nested scaffold (`{ project, columns, labels }`),
 * not a flat project. POST /projects still returns the flat row. Both shapes
 * carry columns/labels at the top level of whichever object we parse here.
 */
const ItsaplanProjectScaffoldSchema = z
  .object({
    project: ItsaplanProjectSchema.optional(),
    columns: z.array(ItsaplanColumnSchema).optional(),
    labels: z.array(ItsaplanLabelSchema).optional(),
  })
  .transform((value) => ({
    id: value.project?.id,
    key: value.project?.key,
    name: value.project?.name,
    description: value.project?.description,
    columns: value.columns ?? value.project?.columns ?? [],
    labels: value.labels ?? value.project?.labels ?? [],
  }))
  .or(
    ItsaplanProjectSchema.transform((value) => ({
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      columns: value.columns ?? [],
      labels: value.labels ?? [],
    })),
  );

const ItsaplanWebhookSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  url: z.string(),
  events: z.array(z.string()),
  isActive: z.boolean().optional(),
  // itsaplan generates the secret server-side (whsec_<hex>) and returns it
  // here; the bridge stores it per project and verifies deliveries with it.
  secret: z.string().optional(),
});
export type ItsaplanWebhook = z.infer<typeof ItsaplanWebhookSchema>;

const ItsaplanAiAgentSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  userId: z.string(),
  username: z.string(),
  kind: z.enum(["external", "internal"]),
  triggerOnMention: z.boolean().optional(),
});
export type ItsaplanAiAgent = z.infer<typeof ItsaplanAiAgentSchema>;

const ItsaplanCreateAiAgentResponseSchema = z.object({
  agent: ItsaplanAiAgentSchema,
  apiKey: z.string().nullable(),
});

const ItsaplanRegenerateKeyResponseSchema = z.object({ apiKey: z.string() });

const ItsaplanClaimedAgentRunSchema = z.object({
  id: z.number(),
  trigger: z.string(),
  prompt: z.string(),
  systemPrompt: z.string(),
  attempts: z.number(),
  issueId: z.number().nullable().optional(),
  issueIdentifier: z.string().nullable().optional(),
});
export type ItsaplanClaimedAgentRun = z.infer<typeof ItsaplanClaimedAgentRunSchema>;

const ItsaplanClaimAgentRunResponseSchema = z.object({
  run: ItsaplanClaimedAgentRunSchema.nullable(),
});

// --- Chat-runner wire shapes (local://itsaplan-features.md §1) ---

const ItsaplanClaimedChatMessageSchema = z.object({
  id: z.number(),
  threadId: z.string(),
  prompt: z.string(),
  systemPrompt: z.string(),
  attempts: z.number(),
  sessionId: z.string().nullable(),
});
export type ItsaplanClaimedChatMessage = z.infer<typeof ItsaplanClaimedChatMessageSchema>;

const ItsaplanClaimChatResponseSchema = z.object({
  message: ItsaplanClaimedChatMessageSchema.nullable(),
});

const ItsaplanChatAckSchema = z.object({ canceled: z.boolean() });
export type ItsaplanChatAck = z.infer<typeof ItsaplanChatAckSchema>;

/**
 * AG-UI event subset the chat-runner speaks (itsaplan's chat wire protocol —
 * apps/api/src/modules/agents/chat/model.ts `AgUiEvent`): only the run
 * lifecycle and plain-text shapes. Tool-call events exist in the same union
 * for a coding-CLI runner; the chat-runner delivers to the Commander's own
 * mailbox instead of running tools locally, so it never emits them.
 */
export type ItsaplanAgUiEvent =
  | { type: "RUN_STARTED" }
  | { type: "RUN_FINISHED" }
  | { type: "RUN_ERROR"; message: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string };

/**
 * itsaplan's own claim wait window defaults to 25s (`AGENT_CHAT_CLAIM_WAIT_MS`,
 * apps/api/src/modules/agents/chat/service.ts `agentChatConfig`) — the request
 * timeout for a claim call must outlast it with margin, well past the
 * ItsaplanClient default (15s) used for every other call.
 */
export const ITSAPLAN_CHAT_CLAIM_TIMEOUT_MS = 60_000;

export class ItsaplanApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ItsaplanApiError";
  }
}

/** The default In Progress-equivalent target: the first `started` column that
 * isn't the bridge's own lazily-created Ready-to-review column. Exported so
 * bridge.ts and reconcile.ts share one definition of "the review column
 * name" and one rule for finding its default sibling. */
export const ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME = "Ready to review";

export function findInProgressColumn(
  columns: readonly ItsaplanColumn[],
): ItsaplanColumn | undefined {
  return columns.find(
    (column) =>
      column.stateType === "started" && column.name !== ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
  );
}

export class ItsaplanClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(config: ItsaplanClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  async getIssue(issueId: number): Promise<ItsaplanIssue> {
    return this.request("GET", `/issues/${issueId}`, undefined, ItsaplanIssueSchema);
  }

  /** Links are not a separate route in itsaplan — they ride `GET /issues/:id`.
   * The wire shape reads each relation from the queried issue (`direction` plus
   * the other end in `issue`); normalize it back to the stored row so callers
   * can reason about sources and targets. */
  async listIssueLinks(issueId: number): Promise<ItsaplanIssueLink[]> {
    const issue = await this.getIssue(issueId);
    return (issue.links ?? []).map((wire) => normalizeIssueLink(issueId, wire));
  }

  async moveIssueColumn(issueId: number, columnId: number): Promise<ItsaplanIssue> {
    return this.request("PATCH", `/issues/${issueId}`, { columnId }, ItsaplanIssueSchema);
  }

  async updateAssignee(issueId: number, assigneeUserId: string | null): Promise<ItsaplanIssue> {
    return this.request("PATCH", `/issues/${issueId}`, { assigneeUserId }, ItsaplanIssueSchema);
  }

  async postComment(issueId: number, body: string): Promise<void> {
    await this.request("POST", `/issues/${issueId}/comments`, { body }, z.unknown());
  }

  /** Columns ride GET /projects/:key (nested `{ project, columns }` or a flat project). */
  async listProjectColumns(projectKey: string): Promise<ItsaplanColumn[]> {
    const scaffold = await this.request(
      "GET",
      `/projects/${encodeURIComponent(projectKey)}`,
      undefined,
      ItsaplanProjectScaffoldSchema,
    );
    return scaffold.columns;
  }

  /** Labels ride the same GET /projects/:key scaffold as columns. */
  async listProjectLabels(projectKey: string): Promise<ItsaplanLabel[]> {
    const scaffold = await this.request(
      "GET",
      `/projects/${encodeURIComponent(projectKey)}`,
      undefined,
      ItsaplanProjectScaffoldSchema,
    );
    return scaffold.labels;
  }

  async createLabel(
    projectKey: string,
    input: { name: string; color?: string },
  ): Promise<ItsaplanLabel> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/labels`,
      input,
      ItsaplanLabelSchema,
    );
  }

  async ensureLabel(projectKey: string, name: string): Promise<ItsaplanLabel> {
    const labels = await this.listProjectLabels(projectKey);
    const existing = labels.find((l) => l.name === name);
    if (existing) {
      return existing;
    }
    return this.createLabel(projectKey, { name });
  }

  async createIssue(
    projectKey: string,
    input: {
      columnId: number;
      title: string;
      description?: string;
      labelIds?: number[];
    },
  ): Promise<ItsaplanIssue> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/issues`,
      input,
      ItsaplanIssueSchema,
    );
  }

  /**
   * Finds an existing column by exact name (columns are per-project, free-
   * named — see local://itsaplan-core.md §1); creates one with the given
   * `stateType` when absent. Matching by name (not stateType alone) because
   * more than one column can legally share a `stateType` — e.g. the
   * bridge-owned "Ready to review" column also uses `started`, alongside the
   * default "In Progress" column.
   */
  async ensureColumn(
    projectKey: string,
    name: string,
    stateType: ItsaplanColumnStateType,
  ): Promise<ItsaplanColumn> {
    const columns = await this.listProjectColumns(projectKey);
    const existing = columns.find((column) => column.name === name);
    if (existing) {
      return existing;
    }
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/columns`,
      { name, stateType },
      ItsaplanColumnSchema,
    );
  }

  async createProject(input: {
    key: string;
    name: string;
    description?: string;
  }): Promise<ItsaplanProject> {
    return this.request("POST", "/projects", input, ItsaplanProjectSchema);
  }

  /**
   * Fetches a project by key (GET /projects/:key — nested scaffold on the
   * wire, flattened here). Null when itsaplan has no such project; used to
   * adopt a pre-existing project after a create-key 409 (created manually,
   * or by an interrupted earlier sync) instead of failing the mapping.
   */
  async getProject(
    projectKey: string,
  ): Promise<Pick<ItsaplanProject, "id" | "key" | "name" | "description"> | null> {
    try {
      const scaffold = await this.request(
        "GET",
        `/projects/${encodeURIComponent(projectKey)}`,
        undefined,
        ItsaplanProjectScaffoldSchema,
      );
      if (scaffold.id === undefined || scaffold.key === undefined) {
        return null;
      }
      return {
        id: scaffold.id,
        key: scaffold.key,
        name: scaffold.name ?? "",
        description: scaffold.description,
      };
    } catch (error) {
      if (error instanceof ItsaplanApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Registers a project-scoped outgoing webhook. itsaplan IGNORES any
   * client-supplied secret and always generates its own (`whsec_<hex>`,
   * apps/api/src/modules/webhooks/service.ts generateSecret) — the caller
   * MUST persist the returned `secret` and verify deliveries against it.
   */
  async registerWebhook(
    projectKey: string,
    input: { url: string; events: string[] },
  ): Promise<ItsaplanWebhook> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/webhooks`,
      input,
      ItsaplanWebhookSchema,
    );
  }

  /** Lists a project's registered webhooks (used to repair event-set drift). */
  async listWebhooks(projectKey: string): Promise<ItsaplanWebhook[]> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(projectKey)}/webhooks`,
      undefined,
      z.array(ItsaplanWebhookSchema),
    );
  }

  /**
   * Patches a webhook (itsaplan PATCH /webhooks/:id). Used by the project
   * sync to bring a webhook registered before `comment.created` existed up
   * to the full event set without re-creating it (the generated secret —
   * and therefore delivery verification — survives the patch).
   */
  async updateWebhook(webhookId: number, input: { events: string[] }): Promise<ItsaplanWebhook> {
    return this.request("PATCH", `/webhooks/${webhookId}`, input, ItsaplanWebhookSchema);
  }

  /**
   * Creates an `ai_agent` row of kind "external" (an itsaplan project-owner
   * call, authenticated with the project admin key this ItsaplanClient was
   * constructed with). itsaplan returns the plaintext API key exactly once,
   * here — never again, not even via GET — so the caller MUST persist it
   * immediately; `regenerateAiAgentApiKey` is the only way back if it is
   * lost. Throws `ItsaplanApiError` with status 409 when the username is
   * already taken in this project (itsaplan `assertUsernameFree`).
   */
  async createAiAgent(
    projectKey: string,
    input: { name: string; username: string; kind: "external"; triggerOnMention?: boolean },
  ): Promise<{ agent: ItsaplanAiAgent; apiKey: string | null }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/ai-agents`,
      input,
      ItsaplanCreateAiAgentResponseSchema,
    );
  }

  async listAiAgents(projectKey: string): Promise<ItsaplanAiAgent[]> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(projectKey)}/ai-agents`,
      undefined,
      z.array(ItsaplanAiAgentSchema),
    );
  }

  async updateAiAgent(
    projectKey: string,
    agentId: number,
    patch: { triggerOnMention?: boolean; name?: string; username?: string },
  ): Promise<ItsaplanAiAgent> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectKey)}/ai-agents/${agentId}`,
      patch,
      ItsaplanAiAgentSchema,
    );
  }

  /**
   * Rotates an agent's key (itsaplan: delete + create, same identity) and
   * returns the new plaintext secret once. Used to recover a usable
   * credential when a Commander agent already exists on itsaplan but this
   * daemon's own mapping store lost the original one-time key.
   */
  async regenerateAiAgentApiKey(projectKey: string, agentId: number): Promise<string> {
    const result = await this.request(
      "POST",
      `/projects/${encodeURIComponent(projectKey)}/ai-agents/${agentId}/regenerate-key`,
      undefined,
      ItsaplanRegenerateKeyResponseSchema,
    );
    return result.apiKey;
  }

  // --- Chat-runner surface: call these on a client constructed with the
  // AGENT's own api key (see chat-runner.ts), never the project admin key
  // used above. ---

  /**
   * Long-polls itsaplan's chat queue for this agent's next message to answer
   * (`POST /agent-chats/claim`) and returns null when none arrived within
   * itsaplan's own wait window (`AGENT_CHAT_CLAIM_WAIT_MS`, default 25s —
   * apps/api/src/modules/agents/chat/service.ts `agentChatConfig`). The
   * request timeout must outlast that server-side wait: chat-runner.ts
   * constructs the claim client with `ITSAPLAN_CHAT_CLAIM_TIMEOUT_MS`.
   */
  async claimChatMessage(): Promise<ItsaplanClaimedChatMessage | null> {
    const result = await this.request(
      "POST",
      "/agent-chats/claim",
      undefined,
      ItsaplanClaimChatResponseSchema,
      ITSAPLAN_CHAT_CLAIM_TIMEOUT_MS,
    );
    return result.message;
  }

  /**
   * Reports AG-UI events for a claimed answer; also extends its lease. The
   * response's `canceled` is how a chat-side stop reaches the runner —
   * itsaplan keeps no connection to the operator's machine otherwise.
   */
  async postChatEvents(messageId: number, events: ItsaplanAgUiEvent[]): Promise<ItsaplanChatAck> {
    return this.request(
      "POST",
      `/agent-chats/${messageId}/events`,
      { events },
      ItsaplanChatAckSchema,
    );
  }

  /** Keeps a claimed answer's lease alive without reporting new content. */
  async heartbeatChatMessage(messageId: number): Promise<ItsaplanChatAck> {
    return this.request(
      "POST",
      `/agent-chats/${messageId}/heartbeat`,
      undefined,
      ItsaplanChatAckSchema,
    );
  }

  /**
   * Closes a claimed answer. A "failed" result is terminal — itsaplan never
   * retries a chat answer — so this is also how chat-runner reports an
   * unreachable Commander without leaving the claim hanging past its lease.
   */
  async postChatResult(
    messageId: number,
    result: { status: "success" | "failed"; error?: string | null },
  ): Promise<void> {
    await this.request("POST", `/agent-chats/${messageId}/result`, result, z.unknown());
  }

  // --- Agent-run runner surface (mention drains) ---

  async claimAgentRun(): Promise<ItsaplanClaimedAgentRun | null> {
    const result = await this.request(
      "POST",
      "/agent-runs/claim",
      undefined,
      ItsaplanClaimAgentRunResponseSchema,
      ITSAPLAN_CHAT_CLAIM_TIMEOUT_MS,
    );
    return result.run;
  }

  async heartbeatAgentRun(runId: number): Promise<void> {
    await this.request("POST", `/agent-runs/${runId}/heartbeat`, undefined, z.unknown());
  }

  async postAgentRunResult(
    runId: number,
    result: { status: "success" | "failed"; output?: string | null; error?: string | null },
  ): Promise<void> {
    await this.request("POST", `/agent-runs/${runId}/result`, result, z.unknown());
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ItsaplanApiError(
          response.status,
          method,
          path,
          `itsaplan ${method} ${path} failed: ${response.status} ${text}`.trim(),
        );
      }
      if (response.status === 204) {
        return schema.parse(undefined);
      }
      const json: unknown = await response.json();
      return schema.parse(json);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`itsaplan ${method} ${path} timed out`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
