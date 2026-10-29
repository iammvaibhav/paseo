import { isTurnTrigger, isTurnBoundary } from "@/agent-stream/turn-membership";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem, ToolCallItem, ThoughtItem } from "@/types/stream";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

/** A step of agent work that folds into a group: a tool call, or the thinking between calls. */
export type GroupableItem = ToolCallItem | ThoughtItem;

/**
 * One uninterrupted stretch of agent work: consecutive tool calls and the thoughts between
 * them. Assistant text, user messages and cards end a run. A run always holds at least one
 * tool call; thinking with no tool call around it stays its own row.
 */
export interface ToolCallRun {
  id: string;
  calls: readonly GroupableItem[];
  latest: GroupableItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingCalls: readonly GroupableItem[];
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

/** `report_status` is the agent's own status card; it reads on its own, not folded away. */
export function isStatusReportToolCall(item: ToolCallItem): boolean {
  return item.payload.source === "agent" && item.payload.data.name === "report_status";
}

/**
 * `show_page` puts a page in the reply, so it renders as the page and never folds into a
 * run. Claude spells it `mcp__paseo__show_page`, Codex `paseo.show_page`, omp `show_page`.
 */
export function isShowPageToolCall(item: ToolCallItem): boolean {
  if (item.payload.source !== "agent") return false;
  const { name } = item.payload.data;
  return (getPaseoToolLeafName(name) ?? normalizeToolName(name)) === "show_page";
}

export function isGroupableToolCall(
  item: StreamItem,
  autoExpandReasoning = false,
): item is GroupableItem {
  if (item.kind === "thought") return !autoExpandReasoning;
  if (
    item.kind !== "tool_call" ||
    isTurnTrigger(item) ||
    isStatusReportToolCall(item) ||
    isShowPageToolCall(item)
  ) {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function hasToolCall(calls: readonly GroupableItem[]): boolean {
  return calls.some((call) => call.kind === "tool_call");
}

function createRun(calls: readonly GroupableItem[], isSealed: boolean): ToolCallRun {
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, calls, latest, isSealed };
}

function createHost(run: ToolCallRun): GroupableItem {
  if (run.calls.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: GroupableItem): boolean {
  if (call.kind === "thought") return call.status !== "ready";
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  calls: readonly GroupableItem[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.calls.length === 0) {
    return;
  }
  if (!hasToolCall(input.calls)) {
    input.output.push(...input.calls);
    return;
  }
  const run = createRun(input.calls, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  if (run.calls.length > 1) input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
  autoExpandReasoning?: boolean;
  /** Rows a run must end at: the last loaded row before a history gap. */
  runEndIds?: ReadonlySet<string>;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: GroupableItem[] = [];

  const sealPending = () => {
    appendRun({
      calls: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
  };

  for (const item of input.tail) {
    const isGroupable = isGroupableToolCall(item, input.autoExpandReasoning);
    if (!isGroupable || isTurnBoundary(pending.at(-1) ?? null, item)) sealPending();
    if (!isGroupable) {
      output.push(item);
      continue;
    }
    pending.push(item);
    // A run never reaches across unloaded history.
    if (input.runEndIds?.has(item.id)) sealPending();
  }

  const trailing = pending;
  sealPending();

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    // Thinking that ended history without a tool call is already a plain row; a later
    // tool call starts its own run rather than reaching back into it.
    pendingCalls: hasToolCall(trailing) ? trailing : [],
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
  autoExpandReasoning?: boolean;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending = [...input.history.pendingCalls];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    if (hostPlacement === "head" && !hasToolCall(pending)) {
      head.push(...pending);
    } else {
      const run = createRun(pending, isSealed);
      if (hostPlacement === "head") {
        head.push(createHost(run));
      }
      const needsLiveGroup = hostPlacement === "head" || pendingIncludesHead || !isSealed;
      if (run.calls.length > 1 && needsLiveGroup) {
        liveGroups.set(run.id, input.buildGroup(run));
      }
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isTurnBoundary(pending.at(-1) ?? null, item)) flush(true);
    if (isGroupableToolCall(item, input.autoExpandReasoning)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(item);
      pendingIncludesHead = true;
      continue;
    }
    flush(true);
    head.push(item);
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive = input.isTurnActive || pending.some(isRunning);
  flush(!trailingRunIsActive);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    const isHistoryHost =
      input.history.groupsByHostId.has(id) || input.history.pendingCalls[0]?.id === id;
    if (isHistoryHost) {
      historyGroupUpdatesByHostId ??= new Map();
      historyGroupUpdatesByHostId.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdatesByHostId ?? EMPTY_GROUPS,
  };
}
