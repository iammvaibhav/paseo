import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import YAML from "yaml";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { PaseoToolResult } from "../agent/tools/types.js";
import type { CreateAgentOptions } from "../agent/agent-manager.js";
import { MISSION_CONTROL_LABEL_KEY } from "./commander-contract.js";
import { formatVerifierContactMessage } from "./approvals.js";
import { hasMissionControlLabels } from "./naming.js";
import type { MissionControlAppendInput, MissionControlFetchOptions } from "./store.js";

/**
 * Mission Control Verifier: one ephemeral omp agent per ready-for-review item
 * that audits the worker's evidence against its brief and returns a verdict.
 *
 * The dispatcher watches reviewState "ready" transitions (and reconciles the
 * persisted ready list at boot), respects `evaluationScope`, caps concurrent
 * verifiers at `verifierConcurrency` (default 3), and spawns each verifier in
 * the item's context: launch brief, full report_status history, attached
 * proofs, tagged user messages, worker agentId + host. No transcripts, no
 * timeline tools — the verifier session gets exactly two tools:
 *
 * - contact_worker { message }: routes through the approval gate as a
 *   verifier-origin proposal; once sent, the message is delivered as a steer
 *   to the worker with a reply marker, and the worker's next report_status or
 *   final turn text is relayed back into the waiting verifier session. An
 *   approved allow-pair short-circuits further approvals for the pair
 *   (handled by the approvals module).
 * - submit_verdict { result: done|insufficient, summary }: "done" marks the
 *   item done via the lifecycle API and posts the verdict card; "insufficient"
 *   without a prior contact creates the proof-demand proposal itself.
 *
 * Crash/timeout: the item stays ready-for-review, spawn is retried once, then
 * a Needs-you card is posted (spec Edge cases).
 *
 * The label value mirrors the Commander's: verifiers carry
 * `paseo.mission-control=verifier` and are excluded from board buckets,
 * badge counts, and feed self-loops via the shared hasMissionControlLabels
 * filter.
 */
export const MISSION_CONTROL_VERIFIER_LABEL_VALUE = "verifier";

const VERIFIER_AGENT_DEFINITION_RELATIVE_PATH = join("resources", "verifier-agent.md");
const VERIFIER_LIFETIME_TIMEOUT_MS = 30 * 60_000;
const VERIFIER_DISPOSE_DELAY_MS = 5_000;
const VERDICT_SUMMARY_MAX_CHARS = 280;
const CONTACT_MESSAGE_MAX_CHARS = 4000;
const QUEUE_LIMIT = 50;

export const VERIFIER_INITIAL_PROMPT =
  "Audit the worker's work against the launch brief and evidence in your system context. " +
  "If proofs are missing or unclear, call contact_worker with a precise request, then wait for " +
  "the worker's reply to arrive as a message. When the evidence suffices, call submit_verdict " +
  'with result "done" and a one-line summary. If evidence is still insufficient after an ' +
  'exchange, call submit_verdict with result "insufficient" and a summary of what is missing. ' +
  "Never do or re-run any work yourself.";

// Appended to the proposal message when a verifier contacts its worker, so
// the worker knows its reply (a report_status or its final turn text) will be
// relayed back to the verifier. Rides the proposal message itself because the
// approvals module is what delivers the (possibly user-edited) message.
const VERIFIER_REPLY_MARKER =
  "\n\n(Your reply — a report_status or your final turn text — is relayed back to the verifier.)";

// Fallback instructions when the repo resource cannot be read at runtime (e.g.
// a broken install). Kept in sync with packages/server/resources/verifier-agent.md.
const FALLBACK_VERIFIER_INSTRUCTIONS = `You are a Mission Control Verifier: a short-lived audit agent. A fleet worker finished a task and reported it complete; you decide whether the evidence proves it.

Your system context contains everything you are allowed to use: the worker's identity and host, the launch brief, the worker's full report_status history, the proofs attached to each report, and user messages tagged to that worker.

Rules:
1. Audit the proofs against the brief. Every requirement in the brief must be covered by a self-reported status that credibly addresses it, ideally backed by a proof.
2. Demand missing proofs via contact_worker with a precise request, then wait for the worker's reply to arrive as a message. Re-audit when it arrives.
3. Never do the work: you have no shell, file, or investigation tools. Never re-run, re-test, re-implement, or fix anything.
4. Verdict: when evidence suffices, call submit_verdict with result "done" and a one-line summary. If still insufficient after your contact exchange, call submit_verdict with result "insufficient" and a summary of exactly what is missing. One verdict per audit.
5. Scope discipline: judge only what the brief asked. Do not invent requirements.
6. No transcripts, no timelines: the reports and proofs are the record.`;

// ============================================================================
// Cross-slice contracts (ProtocolStoreSlice owns the implementations; these
// structural types are the subset this module consumes).
// ============================================================================

export type VerifierReviewStateKind = "none" | "ready" | "done" | "cleared";

export interface VerifierCentralConfig {
  verifierModel?: string | null;
  verifierConcurrency: number;
  evaluationScope: "commander" | "all";
}

export interface VerifierReadyItem {
  agentId: string;
  title: string;
  at: string;
}

export interface VerifierTaggedMessage {
  messageId: string;
  agentIds: string[];
  ts: string;
  text: string;
}

export interface VerifierProposal {
  id: string;
  origin: "verifier" | "commander" | "stall";
  serverId: string;
  targetAgentId: string;
  message: string;
  deliveryMode: "steer" | "interrupt";
  reason: string;
  classification: "normal" | "destructive";
  status: "pending" | "approved" | "denied" | "sent" | "expired";
  allowPair?: boolean;
}

export interface VerifierCreateProposalInput {
  origin: "verifier";
  serverId: string;
  targetAgentId: string;
  message: string;
  deliveryMode: "steer";
  reason: string;
  classification: "normal" | "destructive";
}

/**
 * The agent-manager surface the dispatcher drives: spawn, run, archive, and
 * observe the worker/verifier sessions. Wired from bootstrap with the real
 * AgentManager; tests inject an in-memory fake.
 */
export interface VerifierAgentManager {
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  getAgent(agentId: string): ManagedAgent | null;
  getTimelineRows(agentId: string): Promise<AgentTimelineRow[]>;
  createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent>;
  runAgent(agentId: string, prompt: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
}

export interface VerifierAgentStorage {
  get(agentId: string): Promise<{ labels?: Record<string, string> } | null>;
}

export interface MissionControlVerifierDispatcherOptions {
  logger: Logger;
  agentManager: VerifierAgentManager;
  agentStorage: VerifierAgentStorage;
  serverId: string;
  hostName: string;
  /** Central settings (mission-control/config.ts). Read live on every decision. */
  getCentralConfig: () => VerifierCentralConfig;
  subscribeReviewState: (
    callback: (agentId: string, state: VerifierReviewStateKind) => void,
  ) => () => void;
  /** Persisted ready items for boot reconciliation. */
  getReadyForReview: () => VerifierReadyItem[];
  fetchEvents: (options?: MissionControlFetchOptions) => MissionControlEvent[];
  listMessageTags: () => VerifierTaggedMessage[];
  createProposal: (input: VerifierCreateProposalInput) => Promise<VerifierProposal>;
  onProposalChange: (callback: (proposal: VerifierProposal) => void) => () => void;
  subscribeSelfReports: (callback: (event: MissionControlEvent) => void) => () => void;
  /**
   * Lifecycle API. Passing a verifier verdict emits the kind:"verdict" card
   * with source "verifier" (ProtocolStoreSlice contract).
   */
  setReviewState: (
    agentId: string,
    state: VerifierReviewStateKind,
    options?: { verdict?: { by: "verifier" | "user"; summary: string; at: string } },
  ) => Promise<void>;
  /** Emit a feed card (used for the Needs-you card on retry exhaustion). */
  publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  /** Override the verifier-agent.md source path (tests). */
  agentDefinitionPath?: string;
}

type VerifierRunPhase = "spawning" | "auditing" | "waiting" | "closed" | "failed";

interface VerifierRun {
  item: VerifierReadyItem;
  attempt: number;
  verifierAgentId: string | null;
  phase: VerifierRunPhase;
  /** True once the verifier called contact_worker (exonerates submit_verdict "insufficient"). */
  contactedWorker: boolean;
  /** True once a verdict was recorded; guards the review-state handler against its own done. */
  verdictDone: boolean;
  /** The proposal currently awaiting resolution, if any. */
  pendingProposalId: string | null;
  /** "relay" = worker reply relay armed; the verifier turn ended and awaits the relay. */
  waitingForReply: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

interface VerifierSpawnContext {
  workerAgentId: string;
  hostName: string;
  workerTitle: string;
  brief: string;
  reportHistory: string;
  taggedMessages: string;
  proofs: string;
}

const toolOk = (text: string, structured?: Record<string, unknown>): PaseoToolResult => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const toolError = (text: string): PaseoToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * Model resolution per spec: central `verifierModel` setting wins, then the
 * omp `modelRoles.verifier` role ("@verifier", shipped by deploy as a copy of
 * task values), then `modelRoles.task` ("@task"), then the omp host default
 * (no model).
 */
export function resolveVerifierModel(
  roles: Record<string, string>,
  centralOverride: string | null,
): string | null {
  if (centralOverride && centralOverride.trim()) {
    return centralOverride.trim();
  }
  if (roles.verifier && roles.verifier.trim()) {
    return "@verifier";
  }
  if (roles.task && roles.task.trim()) {
    return "@task";
  }
  return null;
}

/** omp modelRoles from ~/.omp/agent/config.yml. Mirrors context.ts's reader. */
export function readOmpModelRoles(): Record<string, string> {
  try {
    const content = readFileSync(join(homedir(), ".omp", "agent", "config.yml"), "utf8");
    const parsed: unknown = YAML.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const roles = (parsed as Record<string, unknown>)["modelRoles"];
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [role, model] of Object.entries(roles as Record<string, unknown>)) {
      if (typeof model === "string" && model.trim()) {
        result[role] = model;
      }
    }
    return result;
  } catch {
    // Missing or unparsable config.yml is normal on non-omp hosts.
    return {};
  }
}

/**
 * Loads the verifier agent definition (frontmatter-stripped instructions) from
 * packages/server/resources/verifier-agent.md. Resolves the packaged layout
 * (dist/server/resources) first, then the repo checkout via the package root.
 */
export function loadVerifierAgentInstructions(
  explicitPath: string | null | undefined,
  moduleUrl: string,
): string {
  if (explicitPath) {
    return readInstructionsOrFallback(explicitPath);
  }
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDir, "..", "..", VERIFIER_AGENT_DEFINITION_RELATIVE_PATH),
    resolvePackageRootPath(moduleDir, VERIFIER_AGENT_DEFINITION_RELATIVE_PATH),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readInstructionsOrFallback(candidate);
    }
  }
  return FALLBACK_VERIFIER_INSTRUCTIONS;
}

function readInstructionsOrFallback(path: string): string {
  const content = readFileSync(path, "utf8");
  const body = stripFrontmatter(content).trim();
  return body.length > 0 ? body : FALLBACK_VERIFIER_INSTRUCTIONS;
}

/** Strips the leading `---` frontmatter block of an omp agent definition. */
function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return content;
  }
  let endIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }
  return endIndex === -1 ? content : lines.slice(endIndex + 1).join("\n");
}

function resolvePackageRootPath(moduleDir: string, relative: string): string {
  let currentDir = moduleDir;
  while (true) {
    if (existsSync(join(currentDir, "package.json"))) {
      return join(currentDir, relative);
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return join(currentDir, relative);
    }
    currentDir = parentDir;
  }
}

export class MissionControlVerifierDispatcher {
  private readonly logger: Logger;
  private readonly agentManager: VerifierAgentManager;
  private readonly agentStorage: VerifierAgentStorage;
  private readonly serverId: string;
  private readonly hostName: string;
  private readonly getCentralConfig: MissionControlVerifierDispatcherOptions["getCentralConfig"];
  private readonly subscribeReviewState: MissionControlVerifierDispatcherOptions["subscribeReviewState"];
  private readonly getReadyForReview: MissionControlVerifierDispatcherOptions["getReadyForReview"];
  private readonly fetchEvents: MissionControlVerifierDispatcherOptions["fetchEvents"];
  private readonly listMessageTags: MissionControlVerifierDispatcherOptions["listMessageTags"];
  private readonly createProposal: MissionControlVerifierDispatcherOptions["createProposal"];
  private readonly onProposalChange: MissionControlVerifierDispatcherOptions["onProposalChange"];
  private readonly subscribeSelfReports: MissionControlVerifierDispatcherOptions["subscribeSelfReports"];
  private readonly setReviewState: MissionControlVerifierDispatcherOptions["setReviewState"];
  private readonly publish: MissionControlVerifierDispatcherOptions["publish"];
  private readonly agentInstructions: string;

  private readonly queue: Array<VerifierReadyItem & { attempt: number }> = [];
  private readonly queuedOrActive = new Set<string>();
  private readonly runsByVerifier = new Map<string, VerifierRun>();
  private readonly runsByWorker = new Map<string, VerifierRun>();
  private readonly exchangesByProposal = new Map<string, VerifierRun>();
  private inFlight = 0;
  private readonly workerReplyBuffers = new Map<string, string[]>();
  private unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(options: MissionControlVerifierDispatcherOptions) {
    this.logger = options.logger.child({ module: "mission-control", component: "verifier" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.serverId = options.serverId;
    this.hostName = options.hostName;
    this.getCentralConfig = options.getCentralConfig;
    this.subscribeReviewState = options.subscribeReviewState;
    this.getReadyForReview = options.getReadyForReview;
    this.fetchEvents = options.fetchEvents;
    this.listMessageTags = options.listMessageTags;
    this.createProposal = options.createProposal;
    this.onProposalChange = options.onProposalChange;
    this.subscribeSelfReports = options.subscribeSelfReports;
    this.setReviewState = options.setReviewState;
    this.publish = options.publish;
    this.agentInstructions = loadVerifierAgentInstructions(
      options.agentDefinitionPath,
      import.meta.url,
    );
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribers.push(
      this.subscribeReviewState((agentId, state) => this.handleReviewState(agentId, state)),
      this.onProposalChange((proposal) => this.handleProposalChange(proposal)),
      this.subscribeSelfReports((event) => this.handleWorkerSelfReport(event)),
      this.agentManager.subscribe((event) => this.handleManagerEvent(event)),
    );
    // Boot reconciliation: items persisted as ready (e.g. a verifier died with
    // the daemon) get re-verified. Attempts reset on restart; the review state
    // still says "ready", so nothing is lost.
    for (const item of this.getReadyForReview()) {
      this.enqueue(item, 1);
    }
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    for (const run of this.runsByVerifier.values()) {
      clearTimeout(run.timer ?? undefined);
    }
    this.runsByVerifier.clear();
    this.runsByWorker.clear();
    this.exchangesByProposal.clear();
    this.queuedOrActive.clear();
    this.queue.length = 0;
    this.started = false;
  }

  // ==========================================================================
  // Tool-catalog surface (paseo-tools.ts registers the tools only for
  // verifier-labeled callers).
  // ==========================================================================

  isVerifierAgent(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    return agent?.labels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_VERIFIER_LABEL_VALUE;
  }

  async handleContactWorker(verifierAgentId: string, message: string): Promise<PaseoToolResult> {
    const run = this.runsByVerifier.get(verifierAgentId);
    if (!run || run.phase === "closed" || run.phase === "failed") {
      return toolError("No active verification session for this agent.");
    }
    const trimmed = message.trim();
    if (!trimmed) {
      return toolError("message is required.");
    }
    run.contactedWorker = true;
    try {
      const proposal = await this.createProposal({
        origin: "verifier",
        serverId: this.serverId,
        targetAgentId: run.item.agentId,
        // The reply marker rides the proposal message itself: the approvals
        // module is the single delivery path (it sends the — possibly
        // user-edited — message to the worker on "sent"), so the marker must
        // be embedded before createProposal.
        message: formatVerifierContactMessage(
          verifierAgentId,
          `${trimmed.slice(0, CONTACT_MESSAGE_MAX_CHARS)}${VERIFIER_REPLY_MARKER}`,
        ),
        deliveryMode: "steer",
        reason: "Verifier clarification request",
        classification: "normal",
      });
      run.pendingProposalId = proposal.id;
      this.exchangesByProposal.set(proposal.id, run);
      this.logger.info(
        {
          workerAgentId: run.item.agentId,
          verifierAgentId,
          proposalId: proposal.id,
          status: proposal.status,
        },
        "verifier.exchange.requested",
      );
      if (proposal.status === "sent") {
        // Auto mode or a granted allow-pair: approvals already delivered the
        // steer; arm the reply relay.
        this.armExchangeRelay(run, proposal.id);
      }
      return toolOk(
        `Contact request sent for approval (proposal ${proposal.id}). When the worker replies, ` +
          "the reply will be delivered here as a message; then re-audit and submit your verdict.",
        { proposalId: proposal.id, status: proposal.status },
      );
    } catch (error) {
      this.logger.warn(
        { err: error, verifierAgentId, workerAgentId: run.item.agentId },
        "verifier.exchange.proposal_failed",
      );
      return toolError(`Failed to create the contact request: ${String(error)}`);
    }
  }

  async handleSubmitVerdict(
    verifierAgentId: string,
    input: { result: "done" | "insufficient"; summary: string },
  ): Promise<PaseoToolResult> {
    const run = this.runsByVerifier.get(verifierAgentId);
    if (!run || run.phase === "closed" || run.phase === "failed") {
      return toolError("No active verification session for this agent.");
    }
    const summary = (input.summary ?? "").trim().slice(0, VERDICT_SUMMARY_MAX_CHARS);
    run.verdictDone = true;

    if (input.result === "done") {
      try {
        await this.setReviewState(run.item.agentId, "done", {
          verdict: {
            by: "verifier",
            summary: summary || "Verified complete",
            at: new Date().toISOString(),
          },
        });
        this.logger.info(
          { workerAgentId: run.item.agentId, verifierAgentId, summary },
          "verifier.verdict.done",
        );
      } catch (error) {
        this.logger.error(
          { err: error, workerAgentId: run.item.agentId, verifierAgentId },
          "verifier.verdict.mark_failed",
        );
        await this.failRun(run, `failed to record the verdict: ${String(error)}`, {
          retry: false,
          needsYou: true,
        });
        return toolError("Verdict could not be recorded. The verification will be surfaced.");
      }
      await this.closeRun(run);
      return toolOk(
        "Verdict recorded: done. The item is marked done; your session is shutting down.",
      );
    }

    // insufficient
    this.logger.info(
      { workerAgentId: run.item.agentId, verifierAgentId, summary },
      "verifier.verdict.insufficient",
    );
    if (!run.contactedWorker) {
      await this.sendProofDemand(run, summary);
    }
    await this.closeRun(run);
    return toolOk(
      run.contactedWorker
        ? "Verdict recorded: insufficient. The worker was already contacted during this audit; the item stays ready for review."
        : "Verdict recorded: insufficient. The worker has been asked for the missing proofs; the item stays ready for review.",
    );
  }

  // ==========================================================================
  // Dispatcher internals
  // ==========================================================================

  private handleReviewState(agentId: string, state: VerifierReviewStateKind): void {
    if (state === "ready") {
      const worker = this.agentManager.getAgent(agentId) ?? null;
      if (worker && (worker.internal || hasMissionControlLabels(worker.labels))) {
        return;
      }
      const title =
        worker?.name ?? (worker?.config.title?.trim() ? worker.config.title : null) ?? agentId;
      this.enqueue({ agentId, title, at: new Date().toISOString() }, 1);
      return;
    }
    if (state === "done" || state === "cleared") {
      // The user (or another path) settled the item before/while verifying.
      const run = this.runsByWorker.get(agentId);
      if (run && !run.verdictDone && run.phase !== "failed" && run.phase !== "closed") {
        this.logger.info({ workerAgentId: agentId, state }, "verifier.cancelled_user_override");
        void this.cancelRun(run, `review state changed to ${state} before the verdict`);
      }
      this.dequeue(agentId);
    }
  }

  private enqueue(item: VerifierReadyItem, attempt: number): void {
    if (this.queuedOrActive.has(item.agentId)) {
      return;
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      this.logger.warn({ workerAgentId: item.agentId }, "verifier.queue_full_dropped");
      return;
    }
    this.queuedOrActive.add(item.agentId);
    this.queue.push({ ...item, attempt });
    this.pumpQueue();
  }

  private dequeue(agentId: string): void {
    const index = this.queue.findIndex((entry) => entry.agentId === agentId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.queuedOrActive.delete(agentId);
    }
  }

  private pumpQueue(): void {
    const config = this.getCentralConfig();
    const cap = Math.max(1, Math.floor(config.verifierConcurrency) || 1);
    // The slot is reserved synchronously so a burst of ready items cannot
    // over-spawn while the first spawn awaits its scope check.
    while (this.inFlight < cap && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.inFlight += 1;
      void this.spawnVerifier(entry).catch((error) => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.logger.error(
          { err: error, workerAgentId: entry.agentId },
          "verifier.spawn_unexpected_error",
        );
        void this.failRunFor(entry, `spawn failed: ${String(error)}`);
      });
    }
  }

  private async spawnVerifier(entry: VerifierReadyItem & { attempt: number }): Promise<void> {
    if (!(await this.isInScope(entry.agentId))) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.queuedOrActive.delete(entry.agentId);
      this.logger.debug({ workerAgentId: entry.agentId }, "verifier.out_of_scope");
      this.pumpQueue();
      return;
    }
    const run: VerifierRun = {
      item: { agentId: entry.agentId, title: entry.title, at: entry.at },
      attempt: entry.attempt,
      verifierAgentId: null,
      phase: "spawning",
      contactedWorker: false,
      verdictDone: false,
      pendingProposalId: null,
      waitingForReply: false,
      timer: null,
      disposed: false,
    };

    let verifierAgentId: string;
    try {
      const context = await this.buildSpawnContext(entry.agentId);
      const config = this.getCentralConfig();
      const model = resolveVerifierModel(readOmpModelRoles(), config.verifierModel ?? null);
      const worker = this.agentManager.getAgent(entry.agentId) ?? null;
      const agent = await this.agentManager.createAgent(
        {
          provider: "omp",
          cwd: worker?.cwd ?? process.cwd(),
          ...(model ? { model } : {}),
          modeId: "full",
          systemPromptMode: "replace",
          systemPrompt: this.buildVerifierSystemPrompt(context),
          toolAllowlist: ["contact_worker", "submit_verdict"],
        },
        undefined,
        {
          labels: { [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_VERIFIER_LABEL_VALUE },
          initialTitle: `Verifier · ${entry.title}`,
          workspaceId: undefined,
        },
      );
      verifierAgentId = agent.id;
    } catch (error) {
      this.inFlight -= 1;
      this.queuedOrActive.delete(entry.agentId);
      this.logger.warn(
        { err: error, workerAgentId: entry.agentId, attempt: entry.attempt },
        "verifier.spawn_failed",
      );
      await this.failRunFor(entry, `spawn failed: ${String(error)}`);
      this.pumpQueue();
      return;
    }

    run.verifierAgentId = verifierAgentId;
    run.phase = "auditing";
    this.runsByVerifier.set(verifierAgentId, run);
    this.runsByWorker.set(entry.agentId, run);
    this.startRunTimer(run);
    const model =
      resolveVerifierModel(readOmpModelRoles(), this.getCentralConfig().verifierModel ?? null) ??
      "host-default";
    this.logger.info(
      {
        workerAgentId: entry.agentId,
        verifierAgentId,
        attempt: entry.attempt,
        model,
        title: entry.title,
      },
      "verifier.spawn",
    );
    this.runVerifierTurn(run, VERIFIER_INITIAL_PROMPT);
  }

  private runVerifierTurn(run: VerifierRun, prompt: string): void {
    if (!run.verifierAgentId) {
      return;
    }
    void this.agentManager.runAgent(run.verifierAgentId, prompt).then(
      () => this.handleVerifierTurnEnded(run),
      (error) => {
        void this.failRun(run, `verifier run failed: ${String(error)}`);
      },
    );
  }

  private handleVerifierTurnEnded(run: VerifierRun): void {
    if (run.phase === "failed" || run.phase === "closed") {
      // Verdict submitted or failure handled; the session is being torn down.
      this.disposeVerifierSession(run);
      return;
    }
    // A turn ended without a verdict. Legitimate only while an exchange is in
    // flight: a proposal awaiting approval, or the worker reply relay armed.
    if (run.pendingProposalId !== null || run.waitingForReply) {
      run.phase = "waiting";
      return;
    }
    void this.failRun(run, "verifier finished its turn without submitting a verdict");
  }

  private startRunTimer(run: VerifierRun): void {
    clearTimeout(run.timer ?? undefined);
    run.timer = setTimeout(() => {
      void this.failRun(run, "verifier timed out");
    }, VERIFIER_LIFETIME_TIMEOUT_MS);
  }

  private clearRunTimer(run: VerifierRun): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  }

  /** Failure with retry-once semantics: attempt 1 retries, attempt 2 posts Needs-you. */
  private async failRun(
    run: VerifierRun,
    reason: string,
    options?: { retry?: boolean; needsYou?: boolean },
  ): Promise<void> {
    if (run.phase === "closed" || run.phase === "failed") {
      return;
    }
    const retry = options?.retry ?? true;
    const needsYou = options?.needsYou ?? true;
    run.phase = "failed";
    this.clearRunTimer(run);
    this.unregisterRun(run);
    this.releaseSlot();
    this.logger.warn(
      {
        workerAgentId: run.item.agentId,
        verifierAgentId: run.verifierAgentId,
        attempt: run.attempt,
        reason,
      },
      "verifier.failed",
    );
    this.disposeVerifierSession(run);
    if (retry && run.attempt < 2) {
      this.logger.info(
        { workerAgentId: run.item.agentId, attempt: run.attempt + 1 },
        "verifier.retry",
      );
      this.enqueue(run.item, run.attempt + 1);
    } else if (needsYou) {
      // Item stays ready-for-review; the Needs-you card surfaces it to the user.
      this.publish({
        agentId: run.item.agentId,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: "Verification failed — needs your review",
        detail: reason.slice(0, 200),
      });
    }
    this.pumpQueue();
  }

  private async failRunFor(
    entry: VerifierReadyItem & { attempt: number },
    reason: string,
  ): Promise<void> {
    if (entry.attempt < 2) {
      this.logger.info(
        { workerAgentId: entry.agentId, attempt: entry.attempt + 1 },
        "verifier.retry",
      );
      this.enqueue({ agentId: entry.agentId, title: entry.title, at: entry.at }, entry.attempt + 1);
    } else {
      this.publish({
        agentId: entry.agentId,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: "Verification failed — needs your review",
        detail: reason.slice(0, 200),
      });
    }
    this.pumpQueue();
  }

  /** User override: no retry, no Needs-you card — the user already settled it. */
  private async cancelRun(run: VerifierRun, reason: string): Promise<void> {
    if (run.phase === "closed" || run.phase === "failed") {
      return;
    }
    run.phase = "failed";
    this.clearRunTimer(run);
    this.unregisterRun(run);
    this.releaseSlot();
    this.logger.info(
      { workerAgentId: run.item.agentId, verifierAgentId: run.verifierAgentId, reason },
      "verifier.cancelled",
    );
    this.disposeVerifierSession(run);
    this.pumpQueue();
  }

  private async closeRun(run: VerifierRun): Promise<void> {
    run.phase = "closed";
    this.clearRunTimer(run);
    this.unregisterRun(run);
    this.releaseSlot();
    // The session archive is deferred so the final tool response flushes to
    // the model before the omp session is torn down.
    this.disposeVerifierSession(run, VERIFIER_DISPOSE_DELAY_MS);
    this.pumpQueue();
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private unregisterRun(run: VerifierRun): void {
    if (run.verifierAgentId) {
      this.runsByVerifier.delete(run.verifierAgentId);
    }
    this.runsByWorker.delete(run.item.agentId);
    if (run.pendingProposalId) {
      this.exchangesByProposal.delete(run.pendingProposalId);
    }
    this.queuedOrActive.delete(run.item.agentId);
    this.workerReplyBuffers.delete(run.item.agentId);
  }

  private disposeVerifierSession(run: VerifierRun, delayMs = 0): void {
    if (!run.verifierAgentId) {
      return;
    }
    const archive = async (): Promise<void> => {
      if (run.disposed) {
        return;
      }
      run.disposed = true;
      try {
        await this.agentManager.archiveAgent(run.verifierAgentId!);
      } catch (error) {
        this.logger.debug(
          { err: error, verifierAgentId: run.verifierAgentId },
          "verifier.archive_failed",
        );
      }
    };
    if (delayMs > 0) {
      setTimeout(() => void archive(), delayMs);
    } else {
      void archive();
    }
  }

  private async isInScope(workerAgentId: string): Promise<boolean> {
    const scope = this.getCentralConfig().evaluationScope;
    if (scope === "all") {
      return true;
    }
    const worker = this.agentManager.getAgent(workerAgentId) ?? null;
    const parentAgentId = getParentAgentIdFromLabels(worker?.labels ?? {});
    if (!parentAgentId) {
      return false;
    }
    return this.isCommander(parentAgentId);
  }

  private async isCommander(agentId: string): Promise<boolean> {
    const live = this.agentManager.getAgent(agentId);
    const labels = live?.labels ?? (await this.agentStorage.get(agentId))?.labels;
    return labels?.[MISSION_CONTROL_LABEL_KEY] === "commander";
  }

  private async readTimelineRows(agentId: string): Promise<AgentTimelineRow[]> {
    try {
      return await this.agentManager.getTimelineRows(agentId);
    } catch {
      // Agent closed before the spawn; the durable rows are unavailable. The
      // report history and tagged messages still carry the audit record.
      return [];
    }
  }

  private async buildSpawnContext(workerAgentId: string): Promise<VerifierSpawnContext> {
    const worker = this.agentManager.getAgent(workerAgentId) ?? null;
    const rows = await this.readTimelineRows(workerAgentId);
    const briefRow = rows.find(
      (row): row is AgentTimelineRow & { item: { type: "user_message"; text: string } } =>
        row.item.type === "user_message" && row.item.text.trim().length > 0,
    );
    const brief = briefRow?.item.text ?? "(no launch brief available)";
    const reports = this.fetchEvents({ includeSuperseded: true })
      .filter((event) => event.agentId === workerAgentId && event.source === "self")
      .sort((left, right) => left.ts.localeCompare(right.ts));
    const reportHistory = reports
      .map((event) => {
        const proof = formatProofs(event.proof);
        const ts = event.ts.slice(0, 19).replace("T", " ");
        return `- [${ts}] ${event.kind}: ${event.headline}${event.detail ? ` — ${event.detail}` : ""}${proof}`;
      })
      .join("\n");
    const taggedMessages = this.listMessageTags()
      .filter((tag) => tag.agentIds.includes(workerAgentId))
      .sort((left, right) => left.ts.localeCompare(right.ts))
      .map((tag) => `- [${tag.ts.slice(0, 19).replace("T", " ")}] ${tag.text}`)
      .join("\n");
    const proofs = reports
      .flatMap((event) => (event.proof ?? []).map((proof) => formatProof(proof)))
      .join("\n");
    return {
      workerAgentId,
      hostName: this.hostName,
      workerTitle: worker?.name ?? worker?.config?.title ?? workerAgentId,
      brief,
      reportHistory: reportHistory || "(none)",
      taggedMessages: taggedMessages || "(none)",
      proofs: proofs || "(none)",
    };
  }

  private buildVerifierSystemPrompt(context: VerifierSpawnContext): string {
    const block = [
      "<verifier-context>",
      `Worker: ${context.workerTitle} (${context.workerAgentId}) on host ${context.hostName}`,
      "",
      "Launch brief:",
      context.brief,
      "",
      "Report history:",
      context.reportHistory,
      "",
      "User messages tagged to this worker:",
      context.taggedMessages,
      "",
      "Attached proofs:",
      context.proofs,
      "</verifier-context>",
    ].join("\n");
    return `${this.agentInstructions}\n\n${block}`;
  }

  // ==========================================================================
  // Worker exchange (contact_worker → approval gate → steer → relay)
  // ==========================================================================

  /**
   * The approvals module delivers the steer on "sent" (single delivery path
   * for every proposal origin); the dispatcher only arms the worker-reply
   * relay so the worker's next report_status or final turn text is injected
   * back into the waiting verifier session.
   */
  private armExchangeRelay(run: VerifierRun, proposalId: string): void {
    if (run.pendingProposalId === proposalId) {
      run.pendingProposalId = null;
      this.exchangesByProposal.delete(proposalId);
    }
    run.waitingForReply = true;
    this.logger.info(
      { workerAgentId: run.item.agentId, verifierAgentId: run.verifierAgentId, proposalId },
      "verifier.exchange.sent",
    );
  }

  private handleProposalChange(proposal: VerifierProposal): void {
    const run = this.exchangesByProposal.get(proposal.id);
    if (!run || run.phase === "closed" || run.phase === "failed") {
      return;
    }
    if (proposal.status === "sent") {
      // Approvals delivered the steer (possibly edited); arm the relay.
      this.armExchangeRelay(run, proposal.id);
      return;
    }
    if (proposal.status === "denied" || proposal.status === "expired") {
      this.exchangesByProposal.delete(proposal.id);
      run.pendingProposalId = null;
      this.logger.info(
        { workerAgentId: run.item.agentId, proposalId: proposal.id, status: proposal.status },
        "verifier.exchange.denied",
      );
      this.runVerifierTurn(
        run,
        `Your contact request was ${proposal.status === "denied" ? "denied by the user" : "not resolved in time (expired)"}. ` +
          "Re-audit the available evidence and submit your verdict; if it is insufficient, " +
          'submit result "insufficient".',
      );
    }
  }

  private handleWorkerSelfReport(event: MissionControlEvent): void {
    const run = this.runsByWorker.get(event.agentId);
    if (!run || !run.waitingForReply || (run.phase !== "waiting" && run.phase !== "auditing")) {
      return;
    }
    run.waitingForReply = false;
    this.logger.info(
      { workerAgentId: event.agentId, verifierAgentId: run.verifierAgentId, eventId: event.id },
      "verifier.exchange.relay",
    );
    const proof = formatProofs(event.proof);
    this.runVerifierTurn(
      run,
      `The worker replied with a status report:\n[${event.kind}] ${event.headline}` +
        `${event.detail ? ` — ${event.detail}` : ""}${proof}`,
    );
  }

  private handleManagerEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream") {
      return;
    }
    const run = this.runsByWorker.get(event.agentId);
    if (!run || !run.waitingForReply || (run.phase !== "waiting" && run.phase !== "auditing")) {
      return;
    }
    if (event.event.type === "timeline" && event.event.item.type === "assistant_message") {
      const buffers = this.workerReplyBuffers.get(event.agentId) ?? [];
      buffers.push(event.event.item.text);
      this.workerReplyBuffers.set(event.agentId, buffers);
      return;
    }
    if (event.event.type === "turn_completed") {
      const buffers = this.workerReplyBuffers.get(event.agentId) ?? [];
      this.workerReplyBuffers.delete(event.agentId);
      const text = buffers.join("\n").trim() || "(the worker's reply contained no text)";
      run.waitingForReply = false;
      this.logger.info(
        { workerAgentId: event.agentId, verifierAgentId: run.verifierAgentId },
        "verifier.exchange.relay",
      );
      this.runVerifierTurn(run, `The worker replied:\n${text}`);
      return;
    }
    if (event.event.type === "turn_failed") {
      this.workerReplyBuffers.delete(event.agentId);
      run.waitingForReply = false;
      this.logger.warn(
        {
          workerAgentId: event.agentId,
          verifierAgentId: run.verifierAgentId,
          error: event.event.error,
        },
        "verifier.exchange.worker_failed",
      );
      this.runVerifierTurn(
        run,
        `The worker's reply turn failed (${event.event.error}). Re-audit the available evidence ` +
          'and submit your verdict; if it is insufficient, submit result "insufficient".',
      );
    }
  }

  private async sendProofDemand(run: VerifierRun, summary: string): Promise<void> {
    const message =
      `A Mission Control verifier audited your completed work and found the evidence ` +
      `insufficient: ${summary || "missing proofs"}. ` +
      "Reply with a report_status providing the missing proofs, and set status to completed " +
      "once done, so the work can be re-verified.";
    try {
      const proposal = await this.createProposal({
        origin: "verifier",
        serverId: this.serverId,
        targetAgentId: run.item.agentId,
        message,
        deliveryMode: "steer",
        reason: "Verifier proof demand",
        classification: "normal",
      });
      // Approvals is the single delivery path: it steers the worker on "sent"
      // (auto/allow-pair) or once the user approves. No relay is armed — the
      // verifier session is closing; the worker's next completed report
      // re-enters the ready lifecycle and a fresh verifier audits it.
      this.logger.info(
        { workerAgentId: run.item.agentId, proposalId: proposal.id, status: proposal.status },
        "verifier.proof_demand",
      );
    } catch (error) {
      this.logger.warn(
        { err: error, workerAgentId: run.item.agentId },
        "verifier.proof_demand_failed",
      );
    }
  }
}

function formatProofs(proofs: MissionControlEvent["proof"] | undefined): string {
  if (!proofs || proofs.length === 0) {
    return "";
  }
  return ` [proof: ${proofs.map((proof) => formatProof(proof)).join("; ")}]`;
}

function formatProof(proof: NonNullable<MissionControlEvent["proof"]>[number]): string {
  return [proof.url, proof.path, proof.label ?? proof.kind].filter(Boolean).join(" · ");
}
