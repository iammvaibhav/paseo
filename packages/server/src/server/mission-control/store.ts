import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  MissionControlEventKindSchema,
  MissionControlEventSchema,
  type MissionControlEvent,
  type MissionControlEventKind,
} from "@getpaseo/protocol/mission-control/types";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";

export const MISSION_CONTROL_EVENTS_CAP = 5000;
const MISSION_CONTROL_DIR = "mission-control";
const EVENTS_FILENAME = "events.jsonl";
const OBSERVATIONS_FILENAME = "observations.json";

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

/**
 * Per-agent autopilot bookkeeping. Persisted so a daemon restart neither
 * re-evaluates a finish that already produced a verdict nor forgets how many
 * nudges a worker has burned through.
 */
export interface MissionControlAutopilotObservation {
  nudgeCount: number;
  lastEvaluatedSeq: number;
  /**
   * Finished-event ledger: the attention timestamp of the last evaluated
   * finish. Each finish is uniquely identified by that timestamp, so a
   * replayed agent_state for the same transition can never evaluate twice.
   */
  lastEvaluatedFinishedAt: string | null;
}

/**
 * Per-agent summarizer cursors. Persisted so a daemon restart does not resummarize
 * rows that were already consumed or repost a headline that was already posted.
 */
export interface MissionControlObservation {
  lastTimelineSeq: number;
  lastSummarizerTs: string | null;
  /** Timestamp of the agent's most recent self-reported event (report_milestone). */
  lastSelfReportTs: string | null;
  lastEventByKind: Partial<Record<MissionControlEventKind, string>>;
  autopilot?: MissionControlAutopilotObservation;
}

export interface MissionControlAppendInput {
  agentId: string;
  agentTitle: string;
  kind: MissionControlEventKind;
  source: "system" | "summarizer" | "self" | "autopilot";
  severity: "info" | "attention" | "blocker";
  headline: string;
  detail?: string;
  proof?: MissionControlEvent["proof"];
}

export interface MissionControlFetchOptions {
  sinceTs?: string;
  limit?: number;
  includeSuperseded?: boolean;
}

export interface MissionControlStoreOptions {
  paseoHome: string;
  logger: Logger;
}

export function normalizeHeadline(headline: string): string {
  return headline.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class MissionControlStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private events: MissionControlEvent[] = [];
  private readonly observations = new Map<string, MissionControlObservation>();
  private readonly ackedEventIds = new Set<string>();
  private readonly supersedingEventIds = new Set<string>();
  private appendTail: Promise<void> = Promise.resolve();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(options: MissionControlStoreOptions) {
    this.dir = join(options.paseoHome, MISSION_CONTROL_DIR);
    this.logger = options.logger.child({ module: "mission-control", component: "store" });
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.loadEvents();
    await this.loadObservations();
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
      const lastTimelineSeq = value["lastTimelineSeq"];
      const lastSummarizerTs = value["lastSummarizerTs"];
      const lastSelfReportTs = value["lastSelfReportTs"];
      const autopilotRaw = value["autopilot"];
      this.observations.set(agentId, {
        lastTimelineSeq: typeof lastTimelineSeq === "number" ? lastTimelineSeq : -1,
        lastSummarizerTs: typeof lastSummarizerTs === "string" ? lastSummarizerTs : null,
        lastSelfReportTs: typeof lastSelfReportTs === "string" ? lastSelfReportTs : null,
        lastEventByKind,
        ...(isRecord(autopilotRaw)
          ? {
              autopilot: {
                nudgeCount:
                  typeof autopilotRaw["nudgeCount"] === "number" ? autopilotRaw["nudgeCount"] : 0,
                lastEvaluatedSeq:
                  typeof autopilotRaw["lastEvaluatedSeq"] === "number"
                    ? autopilotRaw["lastEvaluatedSeq"]
                    : -1,
                lastEvaluatedFinishedAt:
                  typeof autopilotRaw["lastEvaluatedFinishedAt"] === "string"
                    ? autopilotRaw["lastEvaluatedFinishedAt"]
                    : null,
              },
            }
          : {}),
      });
    }
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
   * event of that kind exists and is still unacked. The rate-limited
   * self-report path allows a within-window report only when it coalesces.
   */
  wouldCoalesce(agentId: string, kind: MissionControlEventKind): boolean {
    const previous = this.previousEventFor(agentId, kind);
    return previous !== undefined && !this.ackedEventIds.has(previous.id);
  }

  /**
   * Append a new event, coalescing it into the (agentId, kind) chain when the
   * previous chain head is still unacked: the new event supersedes the old one
   * and carries the running coalesced count.
   */
  async append(input: MissionControlAppendInput): Promise<MissionControlEvent> {
    const previous = this.previousEventFor(input.agentId, input.kind);
    const coalesces = previous !== undefined && !this.ackedEventIds.has(previous.id);
    const event = MissionControlEventSchema.parse({
      id: generateEventId(),
      ts: new Date().toISOString(),
      ...input,
      ...(coalesces && previous
        ? {
            supersedesId: previous.id,
            coalescedCount: (previous.coalescedCount ?? 0) + 1,
          }
        : {}),
    });
    this.events.push(event);
    if (coalesces) {
      this.supersedingEventIds.add(previous.id);
    }
    this.updateObservation(input.agentId, { lastEventByKind: { [input.kind]: event.id } });
    this.appendTail = this.appendTail
      .then(() => appendFile(join(this.dir, EVENTS_FILENAME), `${JSON.stringify(event)}\n`, "utf8"))
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to append mission control event");
      });
    return event;
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
    const sorted = [...result].sort((left, right) => right.ts.localeCompare(left.ts));
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

  getObservation(agentId: string): MissionControlObservation {
    return (
      this.observations.get(agentId) ?? {
        lastTimelineSeq: -1,
        lastSummarizerTs: null,
        lastSelfReportTs: null,
        lastEventByKind: {},
        autopilot: { nudgeCount: 0, lastEvaluatedSeq: -1, lastEvaluatedFinishedAt: null },
      }
    );
  }

  updateObservation(
    agentId: string,
    patch: Partial<
      Pick<MissionControlObservation, "lastTimelineSeq" | "lastSummarizerTs" | "lastSelfReportTs">
    > & {
      lastEventByKind?: Partial<Record<MissionControlEventKind, string>>;
      autopilot?: Partial<MissionControlAutopilotObservation>;
    },
  ): void {
    const current = this.getObservation(agentId);
    const next: MissionControlObservation = {
      lastTimelineSeq: patch.lastTimelineSeq ?? current.lastTimelineSeq,
      lastSummarizerTs: patch.lastSummarizerTs ?? current.lastSummarizerTs,
      lastSelfReportTs: patch.lastSelfReportTs ?? current.lastSelfReportTs,
      lastEventByKind: { ...current.lastEventByKind, ...patch.lastEventByKind },
    };
    if (patch.autopilot !== undefined) {
      next.autopilot = {
        nudgeCount: patch.autopilot.nudgeCount ?? current.autopilot?.nudgeCount ?? 0,
        lastEvaluatedSeq:
          patch.autopilot.lastEvaluatedSeq ?? current.autopilot?.lastEvaluatedSeq ?? -1,
        lastEvaluatedFinishedAt:
          patch.autopilot.lastEvaluatedFinishedAt ??
          current.autopilot?.lastEvaluatedFinishedAt ??
          null,
      };
    } else if (current.autopilot !== undefined) {
      next.autopilot = current.autopilot;
    }
    this.observations.set(agentId, next);
    this.persistTail = this.persistTail
      .then(() => this.persistObservations())
      .catch((error) => {
        this.logger.error({ err: error }, "Failed to persist mission control observations");
      });
  }

  /** Most recent deterministic event for an agent/kind, used to dedupe summarizer cards. */
  lastSystemEvent(agentId: string, kind: MissionControlEventKind): MissionControlEvent | null {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index];
      if (event.agentId === agentId && event.kind === kind && event.source === "system") {
        return event;
      }
    }
    return null;
  }

  /** Normalized headlines of every prior event for the agent, for summarizer dedupe. */
  normalizedHeadlines(agentId: string): Set<string> {
    const headlines = new Set<string>();
    for (const event of this.events) {
      if (event.agentId === agentId) {
        headlines.add(normalizeHeadline(event.headline));
      }
    }
    return headlines;
  }

  /** Drop events older than retentionDays and enforce the hard cap. */
  async prune(retentionDays: number, hardCap: number = MISSION_CONTROL_EVENTS_CAP): Promise<void> {
    const cutoffTs = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    let retained = this.events.filter((event) => event.ts >= cutoffTs);
    if (retained.length > hardCap) {
      retained = retained.slice(retained.length - hardCap);
    }
    if (retained.length === this.events.length) {
      return;
    }
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
      retained.map((event) => JSON.stringify(event)).join("\n") + (retained.length > 0 ? "\n" : ""),
    );
  }

  private async persistObservations(): Promise<void> {
    const snapshot: Record<string, MissionControlObservation> = {};
    for (const [agentId, observation] of this.observations) {
      snapshot[agentId] = observation;
    }
    await writeJsonFileAtomic(join(this.dir, OBSERVATIONS_FILENAME), snapshot);
  }
}
