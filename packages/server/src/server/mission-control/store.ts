import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  MissionControlEventKindSchema,
  MissionControlEventSchema,
  MissionControlInstructionSchema,
  MissionControlProposalSchema,
  type MissionControlEvent,
  type MissionControlEventKind,
  type MissionControlInstruction,
  type MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";
import type { MissionControlRunRecord } from "./run-records.js";

export const MISSION_CONTROL_EVENTS_CAP = 5000;
/** Run-record retention cap (records are larger than events; 2000 keeps ~2x the event window). */
export const MISSION_CONTROL_RUN_RECORDS_CAP = 2000;
/**
 * M8 instruction ledger cap. Open rows are the hot set (the per-turn envelope
 * re-lists them); closed rows are history for the verbose thread. Rows are
 * small (id + capped text + ts); 1000 keeps years of instructions.
 */
export const MISSION_CONTROL_INSTRUCTIONS_CAP = 1000;
/** Instruction text cap (verbatim user/voice message, capped at record). */
export const MISSION_CONTROL_INSTRUCTION_TEXT_CAP = 2000;
const MISSION_CONTROL_DIR = "mission-control";
const EVENTS_FILENAME = "events.jsonl";
const OBSERVATIONS_FILENAME = "observations.json";
// v3 persistence (same JSONL + snapshot pattern as events/observations).
const STATE_FILENAME = "state.json"; // seq counter + rollout marker
const REVIEW_STATE_FILENAME = "review-state.json";
const PROPOSALS_FILENAME = "proposals.jsonl";
const MESSAGE_TAGS_FILENAME = "message-tags.jsonl";
const STOP_ORIGINS_FILENAME = "stop-origins.json";
// M6 context architecture: per-run records (own JSONL, same append pattern as
// proposals — the latest line for a key wins on load).
const RUN_RECORDS_FILENAME = "run-records.jsonl";
// M8 instruction ledger (own JSONL, same append pattern — latest line wins).
const INSTRUCTIONS_FILENAME = "instructions.jsonl";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase32(value: bigint, length: number): string {
  let encoded = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    encoded = CROCKFORD_BASE32[Number(remaining & 0x1fn)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

// ULID: 48 bits of millisecond time + 80 bits of randomness, Crockford base32.
// Kept local so event ids sort chronologically without a runtime dependency.
function generateUlid(): string {
  const timePart = encodeBase32(BigInt(Date.now()), 10);
  const randomPart = encodeBase32(BigInt(`0x${randomBytes(10).toString("hex")}`), 16);
  return `${timePart}${randomPart}`;
}

export function generateEventId(): string {
  return `mce_${generateUlid()}`;
}

/** Proposal ids sort chronologically like event ids ("mcp_" + ULID). */
export function generateProposalId(): string {
  return `mcp_${generateUlid()}`;
}

/**
 * Per-agent report cursors. Persisted so a daemon restart does not lose the
 * self-report rate-limit clock or the (agentId, kind) coalescing chain head.
 */
export interface MissionControlObservation {
  /** Timestamp of the agent's most recent self-reported event (report_status). */
  lastSelfReportTs: string | null;
  /**
   * Run epoch of the most recent self-reported event. The report_status
   * 60s rate limit is run-scoped: a report in a NEW run is never spam, so
   * the window only applies when this matches the agent's current runEpoch.
   */
  lastSelfReportRunEpoch: number;
  lastEventByKind: Partial<Record<MissionControlEventKind, string>>;
  /**
   * Run boundary for coalescing. Bumped on every `started` append and on
   * every store boot (initialize); stamped on each appended event as
   * `runEpoch`. Events coalesce only within the same epoch, so a `started`
   * — or a daemon restart — ends the previous run's chains.
   */
  runEpoch: number;
}

export interface MissionControlAppendInput {
  agentId: string;
  agentTitle: string;
  shortDescription?: string;
  kind: MissionControlEventKind;
  source: "system" | "summarizer" | "self" | "autopilot" | "verifier";
  severity: "info" | "attention" | "blocker";
  headline: string;
  detail?: string;
  proof?: MissionControlEvent["proof"];
  proposal?: MissionControlEvent["proposal"];
  // M4 Commander interaction cards (additive): structured question payload
  // (kind "clarification") and structured fleet answer payload (kind
  // "answer").
  clarification?: MissionControlEvent["clarification"];
  answer?: MissionControlEvent["answer"];
  // Original report_status kind preserved on source:"self" events (additive).
  reportKind?: MissionControlEvent["reportKind"];
  // Stop origin snapshotted at emit time (additive; see the event schema).
  stoppedBy?: MissionControlEvent["stoppedBy"];
}

export interface MissionControlFetchOptions {
  sinceTs?: string;
  // Cursor paging (v3): return events strictly older than this sequence.
  beforeSeq?: number;
  limit?: number;
  includeSuperseded?: boolean;
}

// ============================================================================
// v3 review lifecycle. Persisted per agent so a daemon restart neither forgets
// a verdict nor re-derives ready-for-review for pre-rollout agents.
// ============================================================================

export type MissionControlReviewStateValue = "none" | "ready" | "done" | "cleared";

export interface MissionControlVerdict {
  by: "verifier" | "user";
  summary: string;
  at: string;
  /** The ephemeral verifier agent that produced a verifier verdict (drill-in). */
  verifierAgentId?: string;
}

export interface MissionControlReviewStateRecord {
  reviewState: MissionControlReviewStateValue;
  doneAt: string | null;
  clearedAt: string | null;
  verdict: MissionControlVerdict | null;
}

export const EMPTY_REVIEW_STATE: MissionControlReviewStateRecord = {
  reviewState: "none",
  doneAt: null,
  clearedAt: null,
  verdict: null,
};

/** Commander-recorded user-message tag: which agents a user message relates to. */
export interface MissionControlMessageTag {
  messageId: string;
  agentIds: string[];
  ts: string;
  text: string;
}

export interface MissionControlStoreOptions {
  paseoHome: string;
  logger: Logger;
}

export class MissionControlStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private events: MissionControlEvent[] = [];
  private readonly observations = new Map<string, MissionControlObservation>();
  private readonly ackedEventIds = new Set<string>();
  private readonly supersedingEventIds = new Set<string>();
  private nextSeq = 0;
  private rolloutTs: string | null = null;
  private readonly reviewStateByAgent = new Map<string, MissionControlReviewStateRecord>();
  private readonly proposalsById = new Map<string, MissionControlProposal>();
  private readonly messageTagsByMessageId = new Map<string, MissionControlMessageTag>();
  private readonly stopOriginByAgent = new Map<string, "user" | "machinery" | "system">();
  // M6: per-run records keyed by their stable id ("mcr_<agentId>_<runEpoch>").
  private readonly runRecordsById = new Map<string, MissionControlRunRecord>();
  // M8: instruction ledger keyed by short id ("#12"). Open rows are re-listed
  // in the per-turn envelope; closed rows carry how they closed.
  private readonly instructionsById = new Map<string, MissionControlInstruction>();
  /** Next monotonic instruction number (persisted across restarts via the
   *  ledger file's own max — ids never reuse after a prune). */
  private nextInstructionNumber = 0;
  private appendTail: Promise<void> = Promise.resolve();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(options: MissionControlStoreOptions) {
    this.dir = join(options.paseoHome, MISSION_CONTROL_DIR);
    this.logger = options.logger.child({ module: "mission-control", component: "store" });
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.loadState();
    await this.loadEvents();
    // Seq floor: on an upgrade from a pre-seq store, new events must sort after
    // everything already persisted (count) and after any existing seq values.
    let maxSeq = this.events.length;
    for (const event of this.events) {
      if (event.seq !== undefined && event.seq >= maxSeq) {
        maxSeq = event.seq + 1;
      }
    }
    if (this.nextSeq < maxSeq) {
      this.nextSeq = maxSeq;
    }
    await this.loadObservations();
    // A daemon restart is a run boundary: a run spanning a restart must not
    // resurrect a pre-restart (agentId, kind) chain. Bump every agent's epoch
    // so pre-restart events can never be coalesced with (or inherited from).
    for (const [agentId, observation] of this.observations) {
      this.updateObservation(agentId, { runEpoch: observation.runEpoch + 1 });
    }
    await this.loadReviewState();
    await this.loadProposals();
    await this.loadMessageTags();
    await this.loadStopOrigins();
    await this.loadRunRecords();
    await this.loadInstructions();
  }

  private async loadEvents(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, EVENTS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.events = [];
        return;
      }
      throw error;
    }
    const events: MissionControlEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        events.push(MissionControlEventSchema.parse(JSON.parse(trimmed)));
      } catch (error) {
        this.logger.warn({ err: error }, "Skipping malformed mission control event");
      }
    }
    this.events = events;
    this.supersedingEventIds.clear();
    for (const event of events) {
      if (event.supersedesId) {
        this.supersedingEventIds.add(event.supersedesId);
      }
    }
  }

  private async loadObservations(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, OBSERVATIONS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control observations");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse mission control observations");
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    for (const [agentId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const lastEventByKind: MissionControlObservation["lastEventByKind"] = {};
      const lastEventByKindRaw = value["lastEventByKind"];
      if (isRecord(lastEventByKindRaw)) {
        for (const kind of MissionControlEventKindSchema.options) {
          const eventId = lastEventByKindRaw[kind];
          if (typeof eventId === "string") {
            lastEventByKind[kind] = eventId;
          }
        }
      }
      const lastSelfReportTs = value["lastSelfReportTs"];
      const lastSelfReportRunEpoch = value["lastSelfReportRunEpoch"];
      const runEpoch = value["runEpoch"];
      this.observations.set(agentId, {
        lastSelfReportTs: typeof lastSelfReportTs === "string" ? lastSelfReportTs : null,
        lastSelfReportRunEpoch:
          typeof lastSelfReportRunEpoch === "number" ? lastSelfReportRunEpoch : 0,
        runEpoch: typeof runEpoch === "number" ? runEpoch : 0,
        lastEventByKind,
      });
    }
  }

  /**
   * Seq counter + rollout marker. Rollout is the timestamp this v3 store first
   * came up: ready-for-review accrues only from events at/after it, and
   * pre-rollout agents derive as dormant.
   */
  private async loadState(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, STATE_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.nextSeq = this.events.length; // populated after loadEvents; safe floor
        this.rolloutTs = new Date().toISOString();
        return;
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)) {
        if (typeof parsed["nextSeq"] === "number") {
          this.nextSeq = parsed["nextSeq"];
        }
        if (typeof parsed["rolloutTs"] === "string") {
          this.rolloutTs = parsed["rolloutTs"];
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse mission control state");
    }
    if (this.rolloutTs === null) {
      this.rolloutTs = new Date().toISOString();
    }
  }

  private async loadReviewState(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, REVIEW_STATE_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control review state");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse mission control review state");
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    for (const [agentId, value] of Object.entries(parsed)) {
      const record = parseReviewStateRecord(value);
      if (record) {
        this.reviewStateByAgent.set(agentId, record);
      }
    }
  }

  private async loadProposals(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, PROPOSALS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control proposals");
      return;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const proposal = MissionControlProposalSchema.parse(JSON.parse(trimmed));
        this.proposalsById.set(proposal.id, proposal);
      } catch (error) {
        this.logger.warn({ err: error }, "Skipping malformed mission control proposal");
      }
    }
  }

  private async loadMessageTags(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, MESSAGE_TAGS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control message tags");
      return;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const tag = parseMessageTag(JSON.parse(trimmed));
        if (tag) {
          this.messageTagsByMessageId.set(tag.messageId, tag);
        }
      } catch (error) {
        this.logger.warn({ err: error }, "Skipping malformed mission control message tag");
      }
    }
  }

  private async loadStopOrigins(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, STOP_ORIGINS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control stop origins");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse mission control stop origins");
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    for (const [agentId, value] of Object.entries(parsed)) {
      if (value === "user" || value === "machinery" || value === "system") {
        this.stopOriginByAgent.set(agentId, value);
      }
    }
  }

  /**
   * M6 run records: own JSONL, same append pattern as proposals — later lines
   * for the same record id win, so re-assembly (a verdict landing after the
   * run-end assembly) updates the record in place.
   */
  private async loadRunRecords(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, RUN_RECORDS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control run records");
      return;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const record = parseRunRecord(JSON.parse(trimmed));
        if (record) {
          this.runRecordsById.set(record.id, record);
        }
      } catch (error) {
        this.logger.warn({ err: error }, "Skipping malformed mission control run record");
      }
    }
  }

  /**
   * M8 instruction ledger: own JSONL, same append pattern as run records —
   * later lines for the same instruction id win (a close re-writes the row in
   * place). The next id counter is derived from the max numeric suffix so ids
   * never reuse after a prune/restart.
   */
  private async loadInstructions(): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.dir, INSTRUCTIONS_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load mission control instructions");
      return;
    }
    let maxNumber = 0;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const instruction = MissionControlInstructionSchema.parse(JSON.parse(trimmed));
        this.instructionsById.set(instruction.id, instruction);
        const number = parseInstructionNumber(instruction.id);
        if (number > maxNumber) {
          maxNumber = number;
        }
      } catch (error) {
        this.logger.warn({ err: error }, "Skipping malformed mission control instruction");
      }
    }
    this.nextInstructionNumber = maxNumber;
  }

  /**
   * The live chain head for (agentId, kind): the last event of that kind that
   * has not itself been superseded. Used for coalescing.
   */
  private previousEventFor(
    agentId: string,
    kind: MissionControlEventKind,
  ): MissionControlEvent | undefined {
    const previousId = this.getObservation(agentId).lastEventByKind[kind];
    return previousId ? this.events.find((event) => event.id === previousId) : undefined;
  }

  /**
   * Whether the next append for (agentId, kind) would coalesce: the previous
   * event of that kind exists, is still unacked, AND belongs to the agent's
   * current run. Coalescing-only: the self-report rate-limit escape is the
   * service's own predicate (see MissionControlService
   * canBypassSelfReportRateLimit), built on getEvent/isEventPending — the
   * two rules never share a predicate.
   */
  wouldCoalesce(agentId: string, kind: MissionControlEventKind): boolean {
    const previous = this.previousEventFor(agentId, kind);
    if (previous === undefined || this.ackedEventIds.has(previous.id)) {
      return false;
    }
    return (previous.runEpoch ?? 0) === this.getObservation(agentId).runEpoch;
  }

  /**
   * Append a new event, coalescing it into the (agentId, kind) chain when the
   * previous chain head is still unacked AND belongs to the same run: the new
   * event supersedes the old one and carries the per-run coalesced count. A
   * `started` event (or a daemon restart) ends the run, so a later event of a
   * kind never coalesces over — or inherits detail/proofs from — an event of
   * the same kind from a previous run. Proposal cards supersede in place
   * across runs regardless of ack state.
   */
  async append(input: MissionControlAppendInput): Promise<MissionControlEvent> {
    // A `started` event opens a new run; the (agentId, kind) chain is
    // run-scoped (see runEpochForAppend and supersessionFor).
    const runEpoch = this.runEpochForAppend(input.agentId, input.kind);
    const { superseded, isProposal } = this.supersessionFor(input, runEpoch);
    const event = MissionControlEventSchema.parse({
      id: generateEventId(),
      ts: new Date().toISOString(),
      seq: this.nextSeq++,
      ...input,
      runEpoch,
      ...(superseded && !input.proof && superseded.proof ? { proof: superseded.proof } : {}),
      ...(superseded && !input.detail && superseded.detail ? { detail: superseded.detail } : {}),
      ...(superseded
        ? {
            supersedesId: superseded.id,
            ...(!isProposal ? { coalescedCount: (superseded.coalescedCount ?? 0) + 1 } : {}),
          }
        : {}),
    });
    this.events.push(event);
    if (event.supersedesId) {
      this.supersedingEventIds.add(event.supersedesId);
    }
    this.updateObservation(input.agentId, { lastEventByKind: { [input.kind]: event.id } });
    this.appendTail = this.appendTail
      .then(() => appendFile(join(this.dir, EVENTS_FILENAME), `${JSON.stringify(event)}\n`, "utf8"))
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to append mission control event");
      });
    this.schedulePersistState();
    return event;
  }

  /** Most recent event carrying the given proposal payload. */
  private lastEventForProposal(proposalId: string): MissionControlEvent | undefined {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index];
      if (event.proposal?.id === proposalId) {
        return event;
      }
    }
    return undefined;
  }

  /**
   * The run epoch for the next append of `kind`. A `started` event opens a
   * new run: the agent's stored epoch is bumped (and persisted) first, so
   * the started card and everything after it live in the new run.
   */
  private runEpochForAppend(agentId: string, kind: MissionControlEventKind): number {
    const current = this.getObservation(agentId).runEpoch;
    if (kind !== "started") {
      return current;
    }
    this.updateObservation(agentId, { runEpoch: current + 1 });
    return current + 1;
  }

  /** The event the next append supersedes, and whether that is a proposal. */
  private supersessionFor(
    input: MissionControlAppendInput,
    runEpoch: number,
  ): { superseded: MissionControlEvent | undefined; isProposal: boolean } {
    // Proposal cards supersede in place: each status change for the same
    // proposal id supersedes the proposal's previous card, regardless of ack
    // state or run boundary (the app always shows the latest card for a
    // proposal; its status changes are one logical card).
    const proposalId = input.proposal?.id;
    const previousProposalEvent = proposalId ? this.lastEventForProposal(proposalId) : undefined;
    const previous = previousProposalEvent ?? this.previousEventFor(input.agentId, input.kind);
    // The (agentId, kind) chain coalesces only over the unacked same-kind
    // head of the SAME run. When a system card (e.g. the run-finished event)
    // coalesces over a self-reported card, the self report's proofs and
    // detail are kept: a proof is the evidence the worker attached, and
    // losing it on coalesce would hide every proof attached to a completed
    // report_status.
    const sameRun = previousProposalEvent !== undefined || (previous?.runEpoch ?? 0) === runEpoch;
    const coalesces = previous !== undefined && !this.ackedEventIds.has(previous.id) && sameRun;
    const superseded =
      previous && (previousProposalEvent !== undefined || coalesces) ? previous : undefined;
    return { superseded, isProposal: previousProposalEvent !== undefined };
  }

  fetchEvents(options?: MissionControlFetchOptions): MissionControlEvent[] {
    let result = this.events;
    if (!options?.includeSuperseded) {
      result = result.filter((event) => !this.supersedingEventIds.has(event.id));
    }
    const sinceTs = options?.sinceTs;
    if (sinceTs) {
      result = result.filter((event) => event.ts > sinceTs);
    }
    const beforeSeq = options?.beforeSeq;
    if (beforeSeq !== undefined) {
      result = result.filter((event) => (event.seq ?? -1) < beforeSeq);
    }
    const sorted = [...result].sort((left, right) => {
      const bySeq = (right.seq ?? -1) - (left.seq ?? -1);
      return bySeq !== 0 ? bySeq : right.ts.localeCompare(left.ts);
    });
    if (options?.limit !== undefined && options.limit > 0) {
      return sorted.slice(0, options.limit);
    }
    return sorted;
  }

  ackEvents(eventIds: string[]): void {
    for (const eventId of eventIds) {
      this.ackedEventIds.add(eventId);
    }
  }

  /** The retained event with the given id, if any. Reads a single event. */
  getEvent(eventId: string): MissionControlEvent | undefined {
    return this.events.find((event) => event.id === eventId);
  }

  /**
   * Whether a retained event is still pending: never acked by a client. Reads
   * ack state only; meaningful for event ids that exist in the store.
   */
  isEventPending(eventId: string): boolean {
    return !this.ackedEventIds.has(eventId);
  }

  // ==========================================================================
  // v3 review lifecycle
  // ==========================================================================

  getReviewState(agentId: string): MissionControlReviewStateRecord {
    return this.reviewStateByAgent.get(agentId) ?? { ...EMPTY_REVIEW_STATE };
  }

  getReviewStates(): ReadonlyMap<string, MissionControlReviewStateRecord> {
    return this.reviewStateByAgent;
  }

  /**
   * Persist a review-state transition. done → doneAt + optional verdict;
   * clear → clearedAt; ready/none reset the closed fields. Returns the new
   * record.
   */
  async setReviewState(
    agentId: string,
    state: MissionControlReviewStateValue,
    options?: { verdict?: MissionControlVerdict },
  ): Promise<MissionControlReviewStateRecord> {
    const current = this.getReviewState(agentId);
    const now = new Date().toISOString();
    let next: MissionControlReviewStateRecord;
    switch (state) {
      case "done":
        next = {
          reviewState: "done",
          doneAt: now,
          clearedAt: null,
          verdict: options?.verdict ?? current.verdict,
        };
        break;
      case "cleared":
        next = {
          reviewState: "cleared",
          doneAt: current.doneAt,
          clearedAt: now,
          verdict: current.verdict,
        };
        break;
      case "ready":
        next = { ...EMPTY_REVIEW_STATE, reviewState: "ready" };
        break;
      case "none":
        next = { ...EMPTY_REVIEW_STATE };
        break;
    }
    this.reviewStateByAgent.set(agentId, next);
    this.schedulePersistReviewState();
    return next;
  }

  /** Agent ids currently ready for review (drives verifier dispatch). */
  getReadyForReview(): string[] {
    const ready: string[] = [];
    for (const [agentId, record] of this.reviewStateByAgent) {
      if (record.reviewState === "ready") {
        ready.push(agentId);
      }
    }
    return ready;
  }

  // ==========================================================================
  // v3 approval gate: proposals (JSONL append, latest status wins on load)
  // ==========================================================================

  getProposal(proposalId: string): MissionControlProposal | null {
    return this.proposalsById.get(proposalId) ?? null;
  }

  listProposals(): MissionControlProposal[] {
    return [...this.proposalsById.values()];
  }

  async putProposal(proposal: MissionControlProposal): Promise<void> {
    this.proposalsById.set(proposal.id, proposal);
    this.appendTail = this.appendTail
      .then(() =>
        appendFile(join(this.dir, PROPOSALS_FILENAME), `${JSON.stringify(proposal)}\n`, "utf8"),
      )
      .catch((error) => {
        this.logger.error({ err: error, proposalId: proposal.id }, "Failed to append proposal");
      });
  }

  /**
   * Expire proposals older than the given cutoff: pending → expired. Returns
   * the expired proposals so callers can push updated cards.
   */
  async expireProposals(
    now = Date.now(),
    ttlMs = 24 * 60 * 60 * 1000,
  ): Promise<MissionControlProposal[]> {
    const expired: MissionControlProposal[] = [];
    for (const proposal of this.proposalsById.values()) {
      if (proposal.status !== "pending") {
        continue;
      }
      if (now - Date.parse(proposal.createdAt) >= ttlMs) {
        const updated = { ...proposal, status: "expired" as const };
        await this.putProposal(updated);
        expired.push(updated);
      }
    }
    return expired;
  }

  // ==========================================================================
  // v3 user-message tagging (Commander records relatedAgentIds per message)
  // ==========================================================================

  recordMessageTags(input: Omit<MissionControlMessageTag, "ts"> & { ts?: string }): void {
    const tag = {
      ...input,
      agentIds: [...new Set(input.agentIds)],
      ts: input.ts ?? new Date().toISOString(),
    };
    this.messageTagsByMessageId.set(tag.messageId, tag);
    this.appendTail = this.appendTail
      .then(() =>
        appendFile(join(this.dir, MESSAGE_TAGS_FILENAME), `${JSON.stringify(tag)}\n`, "utf8"),
      )
      .catch((error) => {
        this.logger.error(
          { err: error, messageId: tag.messageId },
          "Failed to append mission control message tag",
        );
      });
  }

  getMessageTags(messageId: string): MissionControlMessageTag | null {
    return this.messageTagsByMessageId.get(messageId) ?? null;
  }

  allMessageTags(): MissionControlMessageTag[] {
    return [...this.messageTagsByMessageId.values()];
  }

  // ==========================================================================
  // v3 stop origins: who cancelled the agent's last run ("user" forces ask)
  // ==========================================================================

  recordStopOrigin(agentId: string, origin: "user" | "machinery" | "system" | null): void {
    if (origin === null) {
      this.stopOriginByAgent.delete(agentId);
    } else {
      this.stopOriginByAgent.set(agentId, origin);
    }
    this.schedulePersistStopOrigins();
  }

  getStopOrigin(agentId: string): "user" | "machinery" | "system" | null {
    return this.stopOriginByAgent.get(agentId) ?? null;
  }

  // ==========================================================================
  // M6 run records: deterministic per-run context (brief + reports + verdict
  // + proofs), assembled at run end / ready-for-review and persisted here.
  // ==========================================================================

  /**
   * Upsert one run record. Idempotent per record id: a verdict landing after
   * the run-end assembly re-writes the same record (latest line wins on load).
   */
  putRunRecord(record: MissionControlRunRecord): void {
    this.runRecordsById.set(record.id, record);
    this.appendTail = this.appendTail
      .then(() =>
        appendFile(join(this.dir, RUN_RECORDS_FILENAME), `${JSON.stringify(record)}\n`, "utf8"),
      )
      .catch((error) => {
        this.logger.error({ err: error, recordId: record.id }, "Failed to append run record");
      });
  }

  /** The most recent run record for an agent (or null when it has none). */
  getLatestRunRecord(agentId: string): MissionControlRunRecord | null {
    let latest: MissionControlRunRecord | null = null;
    for (const record of this.runRecordsById.values()) {
      if (record.agentId !== agentId) {
        continue;
      }
      if (!latest || record.endedAt > latest.endedAt) {
        latest = record;
      }
    }
    return latest;
  }

  /** All retained run records, newest run first. */
  getRunRecords(): MissionControlRunRecord[] {
    return [...this.runRecordsById.values()].sort((left, right) =>
      right.endedAt.localeCompare(left.endedAt),
    );
  }

  // ==========================================================================
  // M8 instruction ledger: every user/voice instruction delivered to the
  // Commander. Open rows ride the per-turn envelope (never lost to
  // compaction); a citing card (respondsTo) or a verbose manual close closes
  // a row. Own JSONL — the latest line for an id wins on load.
  // ==========================================================================

  /**
   * Open a ledger row for a delivered user/voice instruction. The id is short
   * and monotonic ("#12"); the counter survives restarts (derived from the
   * max loaded id), so ids never reuse. Text is capped at
   * MISSION_CONTROL_INSTRUCTION_TEXT_CAP.
   */
  openInstruction(input: { text: string; source: "chat" | "voice" }): MissionControlInstruction {
    const number = ++this.nextInstructionNumber;
    const instruction: MissionControlInstruction = {
      id: `#${number}`,
      text: input.text.trim().slice(0, MISSION_CONTROL_INSTRUCTION_TEXT_CAP),
      ts: new Date().toISOString(),
      source: input.source,
      status: "open",
    };
    this.instructionsById.set(instruction.id, instruction);
    this.appendInstruction(instruction);
    this.pruneInstructionsInMemory();
    return instruction;
  }

  /**
   * Close an open instruction row. Returns the closed row, or null when the
   * id is unknown or already closed (idempotent). `closedBy` records whether
   * a citing card (cardId) or the verbose manual close (manual) closed it.
   */
  closeInstruction(id: string, closedBy: "cardId" | "manual"): MissionControlInstruction | null {
    const current = this.instructionsById.get(id);
    if (!current || current.status === "closed") {
      return null;
    }
    const closed: MissionControlInstruction = { ...current, status: "closed", closedBy };
    this.instructionsById.set(id, closed);
    this.appendInstruction(closed);
    return closed;
  }

  /** The retained row with the given ledger id, if any. */
  getInstruction(id: string): MissionControlInstruction | null {
    return this.instructionsById.get(id) ?? null;
  }

  /** All retained instruction rows, newest first. */
  listInstructions(): MissionControlInstruction[] {
    return [...this.instructionsById.values()].sort((left, right) =>
      right.ts.localeCompare(left.ts),
    );
  }

  /** Open rows only, oldest first (the envelope lists them in order). */
  listOpenInstructions(): MissionControlInstruction[] {
    return [...this.instructionsById.values()]
      .filter((instruction) => instruction.status === "open")
      .sort((left, right) => left.ts.localeCompare(right.ts));
  }

  private appendInstruction(instruction: MissionControlInstruction): void {
    this.appendTail = this.appendTail
      .then(() =>
        appendFile(
          join(this.dir, INSTRUCTIONS_FILENAME),
          `${JSON.stringify(instruction)}\n`,
          "utf8",
        ),
      )
      .catch((error) => {
        this.logger.error(
          { err: error, instructionId: instruction.id },
          "Failed to append mission control instruction",
        );
      });
  }

  /** Enforce the ledger cap in memory (the file keeps the full history;
   *  pruned rows are unreachable by id, matching the events window). */
  private pruneInstructionsInMemory(): void {
    if (this.instructionsById.size <= MISSION_CONTROL_INSTRUCTIONS_CAP) {
      return;
    }
    const byTs = [...this.instructionsById.values()].sort((left, right) =>
      right.ts.localeCompare(left.ts),
    );
    const retained = byTs.slice(0, MISSION_CONTROL_INSTRUCTIONS_CAP);
    this.instructionsById.clear();
    for (const instruction of retained) {
      this.instructionsById.set(instruction.id, instruction);
    }
  }

  // ==========================================================================
  // v3 dormant derivation: pre-rollout agents (no events since rollout) are
  // dormant — hidden by default, shown under the "All unarchived" toggle. A
  // dormant agent that runs again enters the lifecycle normally.
  // ==========================================================================

  getRolloutTs(): string | null {
    return this.rolloutTs;
  }

  isDormant(agentId: string): boolean {
    if (!this.rolloutTs) {
      return false;
    }
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index];
      if (event.agentId === agentId && event.ts >= this.rolloutTs) {
        return false;
      }
    }
    return true;
  }

  dormantAgentIds(): string[] {
    if (!this.rolloutTs) {
      return [];
    }
    const seen = new Set<string>();
    for (const event of this.events) {
      if (event.ts >= this.rolloutTs) {
        seen.add(event.agentId);
      }
    }
    const dormant = new Set<string>();
    for (const event of this.events) {
      if (!seen.has(event.agentId)) {
        dormant.add(event.agentId);
      }
    }
    for (const agentId of this.reviewStateByAgent.keys()) {
      if (!seen.has(agentId)) {
        dormant.add(agentId);
      }
    }
    return [...dormant];
  }

  getObservation(agentId: string): MissionControlObservation {
    return (
      this.observations.get(agentId) ?? {
        lastSelfReportTs: null,
        lastSelfReportRunEpoch: 0,
        lastEventByKind: {},
        runEpoch: 0,
      }
    );
  }

  updateObservation(
    agentId: string,
    patch: Partial<
      Pick<MissionControlObservation, "lastSelfReportTs" | "lastSelfReportRunEpoch" | "runEpoch">
    > & {
      lastEventByKind?: Partial<Record<MissionControlEventKind, string>>;
    },
  ): void {
    const current = this.getObservation(agentId);
    const next: MissionControlObservation = {
      lastSelfReportTs: patch.lastSelfReportTs ?? current.lastSelfReportTs,
      lastSelfReportRunEpoch: patch.lastSelfReportRunEpoch ?? current.lastSelfReportRunEpoch,
      runEpoch: patch.runEpoch ?? current.runEpoch,
      lastEventByKind: { ...current.lastEventByKind, ...patch.lastEventByKind },
    };
    this.observations.set(agentId, next);
    this.persistTail = this.persistTail
      .then(() => this.persistObservations())
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to persist mission control observations");
      });
  }

  /** Drop events older than retentionDays and enforce the hard cap. */
  async prune(retentionDays: number, hardCap: number = MISSION_CONTROL_EVENTS_CAP): Promise<void> {
    const cutoffTs = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    let retained = this.events.filter((event) => event.ts >= cutoffTs);
    if (retained.length > hardCap) {
      retained = retained.slice(retained.length - hardCap);
    }
    if (retained.length !== this.events.length) {
      this.events = retained;
      const retainedIds = new Set(retained.map((event) => event.id));
      this.supersedingEventIds.clear();
      for (const event of retained) {
        if (event.supersedesId && retainedIds.has(event.supersedesId)) {
          this.supersedingEventIds.add(event.supersedesId);
        }
      }
      await writeFileAtomic(
        join(this.dir, EVENTS_FILENAME),
        retained.map((event) => JSON.stringify(event)).join("\n") +
          (retained.length > 0 ? "\n" : ""),
      );
    }
    await this.pruneRunRecords(cutoffTs);
  }

  /**
   * Run records share the retention window and their own cap: records for
   * runs that ended before the cutoff (or beyond the cap) are dropped, oldest
   * first. Follows the events pattern — rewrite the JSONL atomically.
   */
  private async pruneRunRecords(cutoffTs: string): Promise<void> {
    let retained = [...this.runRecordsById.values()]
      .filter((record) => record.endedAt >= cutoffTs)
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt));
    if (retained.length > MISSION_CONTROL_RUN_RECORDS_CAP) {
      retained = retained.slice(0, MISSION_CONTROL_RUN_RECORDS_CAP);
    }
    if (retained.length === this.runRecordsById.size) {
      return;
    }
    this.runRecordsById.clear();
    for (const record of retained) {
      this.runRecordsById.set(record.id, record);
    }
    await writeFileAtomic(
      join(this.dir, RUN_RECORDS_FILENAME),
      retained.map((record) => JSON.stringify(record)).join("\n") +
        (retained.length > 0 ? "\n" : ""),
    );
  }

  private schedulePersistState(): void {
    this.persistTail = this.persistTail
      .then(() => this.persistState())
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to persist mission control state");
      });
  }

  private async persistState(): Promise<void> {
    await writeJsonFileAtomic(join(this.dir, STATE_FILENAME), {
      nextSeq: this.nextSeq,
      rolloutTs: this.rolloutTs,
    });
  }

  private schedulePersistReviewState(): void {
    this.persistTail = this.persistTail
      .then(() => this.persistReviewState())
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to persist mission control review state");
      });
  }

  private async persistReviewState(): Promise<void> {
    const snapshot: Record<string, MissionControlReviewStateRecord> = {};
    for (const [agentId, record] of this.reviewStateByAgent) {
      snapshot[agentId] = record;
    }
    await writeJsonFileAtomic(join(this.dir, REVIEW_STATE_FILENAME), snapshot);
  }

  private schedulePersistStopOrigins(): void {
    this.persistTail = this.persistTail
      .then(() => this.persistStopOrigins())
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to persist mission control stop origins");
      });
  }

  private async persistStopOrigins(): Promise<void> {
    const snapshot: Record<string, "user" | "machinery" | "system"> = {};
    for (const [agentId, origin] of this.stopOriginByAgent) {
      snapshot[agentId] = origin;
    }
    await writeJsonFileAtomic(join(this.dir, STOP_ORIGINS_FILENAME), snapshot);
  }

  private async persistObservations(): Promise<void> {
    const snapshot: Record<string, MissionControlObservation> = {};
    for (const [agentId, observation] of this.observations) {
      snapshot[agentId] = observation;
    }
    await writeJsonFileAtomic(join(this.dir, OBSERVATIONS_FILENAME), snapshot);
  }
}

function parseReviewStateRecord(value: unknown): MissionControlReviewStateRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const reviewState = value["reviewState"];
  if (
    reviewState !== "none" &&
    reviewState !== "ready" &&
    reviewState !== "done" &&
    reviewState !== "cleared"
  ) {
    return null;
  }
  const doneAt = typeof value["doneAt"] === "string" ? value["doneAt"] : null;
  const clearedAt = typeof value["clearedAt"] === "string" ? value["clearedAt"] : null;
  let verdict: MissionControlVerdict | null = null;
  const verdictRaw = value["verdict"];
  if (isRecord(verdictRaw)) {
    const by = verdictRaw["by"];
    const summary = verdictRaw["summary"];
    const at = verdictRaw["at"];
    if (
      (by === "verifier" || by === "user") &&
      typeof summary === "string" &&
      typeof at === "string"
    ) {
      const verifierAgentId =
        typeof verdictRaw["verifierAgentId"] === "string"
          ? verdictRaw["verifierAgentId"]
          : undefined;
      verdict = { by, summary, at, ...(verifierAgentId ? { verifierAgentId } : {}) };
    }
  }
  return { reviewState, doneAt, clearedAt, verdict };
}

function parseMessageTag(value: unknown): MissionControlMessageTag | null {
  if (!isRecord(value)) {
    return null;
  }
  const messageId = value["messageId"];
  const agentIds = value["agentIds"];
  const ts = value["ts"];
  const text = value["text"];
  if (
    typeof messageId !== "string" ||
    !Array.isArray(agentIds) ||
    !agentIds.every((id) => typeof id === "string") ||
    typeof ts !== "string" ||
    typeof text !== "string"
  ) {
    return null;
  }
  return { messageId, agentIds, ts, text };
}

const RUN_OUTCOMES: Record<string, boolean> = {
  finished: true,
  failed: true,
  interrupted: true,
  blocked: true,
  ready: true,
  running: true,
};

/** Lenient parse: older/malformed lines are skipped, valid fields survive. */
function parseRunRecord(value: unknown): MissionControlRunRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const required = [
    "id",
    "agentId",
    "agentName",
    "agentTitle",
    "hostAlias",
    "serverId",
    "runEpoch",
    "startedAt",
    "endedAt",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" && key !== "runEpoch") {
      return null;
    }
    if (key === "runEpoch" && typeof value[key] !== "number") {
      return null;
    }
  }
  const outcome = value["outcome"];
  if (typeof outcome !== "string" || !RUN_OUTCOMES[outcome]) {
    return null;
  }
  const reports = Array.isArray(value["reports"]) ? value["reports"].filter(isRunReport) : [];
  const proofs = Array.isArray(value["proofs"]) ? value["proofs"].filter(isRunProof) : [];
  const verdict =
    value["verdict"] === null || value["verdict"] === undefined ? null : value["verdict"];
  return {
    id: value["id"] as string,
    agentId: value["agentId"] as string,
    agentName: value["agentName"] as string,
    agentTitle: value["agentTitle"] as string,
    hostAlias: value["hostAlias"] as string,
    serverId: value["serverId"] as string,
    workspaceId: typeof value["workspaceId"] === "string" ? value["workspaceId"] : null,
    workspaceTitle: typeof value["workspaceTitle"] === "string" ? value["workspaceTitle"] : null,
    projectId: typeof value["projectId"] === "string" ? value["projectId"] : null,
    projectName: typeof value["projectName"] === "string" ? value["projectName"] : null,
    runEpoch: value["runEpoch"] as number,
    startedAt: value["startedAt"] as string,
    endedAt: value["endedAt"] as string,
    outcome: outcome as MissionControlRunRecord["outcome"],
    brief: typeof value["brief"] === "string" ? value["brief"] : null,
    reports,
    verdict: isRecord(verdict) ? (verdict as unknown as MissionControlRunRecord["verdict"]) : null,
    proofs,
    createdAt: value["createdAt"] as string,
    updatedAt: value["updatedAt"] as string,
  };
}

function isRunReport(value: unknown): value is MissionControlRunRecord["reports"][number] {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["ts"] === "string" && typeof value["headline"] === "string";
}

/** The numeric suffix of a ledger id ("#12" → 12); 0 for malformed ids. */
function parseInstructionNumber(id: string): number {
  const match = /^#(\d+)$/.exec(id.trim());
  return match ? Number(match[1]) : 0;
}

function isRunProof(value: unknown): value is MissionControlRunRecord["proofs"][number] {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["kind"] === "string";
}
