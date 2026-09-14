import { randomUUID } from "node:crypto";
import {
  TimelineProjection,
  selectProjectedTimelinePage,
  type ProjectedTimelineRow,
} from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  committed: AgentTimelineRow[];
  nextSeq: number;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }
  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const committed =
      options?.rows?.map((row) => ({
        seq: row.seq,
        timestamp: row.timestamp,
        item: row.item,
        ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
        ...(row.providerMessageId !== undefined
          ? { providerMessageId: row.providerMessageId }
          : {}),
      })) ?? this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = committed.reduce(
      (next, row) => Math.max(next, row.seq + 1),
      options?.nextSeq ?? 1,
    );
    const projection = new TimelineProjection();
    for (const row of committed) projection.append(row);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      committed,
      nextSeq,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  getCommittedRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).committed.map(cloneRow);
  }

  /**
   * Oldest submitted user prompt that still lacks provider identity. Used when a
   * provider echo arrives without `clientMessageId` (e.g. OMP false local-only
   * race) so FIFO same-text submissions still reconcile correctly.
   */
  findOldestUnenrichedSubmittedUserMessageByText(
    agentId: string,
    text: string,
  ): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId !== undefined &&
          candidate.item.text === text &&
          candidate.providerMessageId === undefined,
      );
    return row ? cloneRow(row) : null;
  }

  /**
   * Remove committed rows by seq (e.g. digest ack-drop retraction). Returns the
   * removed rows. Seq identity is preserved — late observers see a gap rather
   * than renumbered rows, so cursors stay valid.
   */
  removeRows(agentId: string, seqs: readonly number[]): AgentTimelineRow[] {
    if (seqs.length === 0) {
      return [];
    }
    const state = this.requireState(agentId);
    const drop = new Set(seqs);
    const removed = state.committed.filter((row) => drop.has(row.seq));
    if (removed.length === 0) {
      return [];
    }
    state.committed = state.committed.filter((row) => !drop.has(row.seq));
    const rebuilt = new TimelineProjection();
    for (const row of state.committed) rebuilt.append(row);
    state.projection = rebuilt;
    return removed.map(cloneRow);
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const rows = state.projection.getRows();
    const minSeq = rows[0]?.seqStart ?? state.nextSeq;
    const window = { minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      rows.length > 0 &&
      cursor.seq < minSeq - 1;
    const reset = staleCursor || gap;
    const page = selectProjectedTimelinePage({
      rows,
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    state.committed.push(row);
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getRows().find((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .findLast((candidate) => candidate.item.type === "assistant_message");
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
