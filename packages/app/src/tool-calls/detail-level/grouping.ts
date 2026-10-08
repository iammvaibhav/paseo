import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem, ThoughtItem, ToolCallItem } from "@/types/stream";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

/** A step of agent work that folds into a group: a tool call, or the thinking between calls. */
export type ToolRunItem = ToolCallItem | ThoughtItem;

/**
 * One uninterrupted stretch of agent work: consecutive tool calls and the thoughts between
 * them. Assistant text, user messages and cards end a run. A run always holds at least one
 * tool call; thinking with no tool call around it stays its own row.
 */
export interface ToolCallRun {
  id: string;
  items: readonly ToolRunItem[];
  latest: ToolRunItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingItems: readonly ToolRunItem[];
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

function isGroupableItem(item: StreamItem): item is ToolRunItem {
  if (item.kind === "thought") {
    return true;
  }
  if (item.kind !== "tool_call" || isStatusReportToolCall(item) || isShowPageToolCall(item)) {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function hasToolCall(items: readonly ToolRunItem[]): boolean {
  return items.some((item) => item.kind === "tool_call");
}

function createRun(items: readonly ToolRunItem[], isSealed: boolean): ToolCallRun {
  const first = items[0];
  const latest = items.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, items, latest, isSealed };
}

function createHost(run: ToolCallRun): ToolRunItem {
  if (run.items.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(item: ToolRunItem): boolean {
  if (item.kind === "thought") {
    return item.status === "loading";
  }
  const status = describeToolCall(item).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  items: readonly ToolRunItem[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.items.length === 0) {
    return;
  }
  if (!hasToolCall(input.items)) {
    input.output.push(...input.items);
    return;
  }
  const run = createRun(input.items, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: ToolRunItem[] = [];

  for (const item of input.tail) {
    if (isGroupableItem(item)) {
      pending.push(item);
      continue;
    }
    appendRun({
      items: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
    output.push(item);
  }

  appendRun({
    items: pending,
    isSealed: true,
    output,
    groups,
    buildGroup: input.buildGroup,
  });

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    // Thinking that ended history without a tool call is already a plain row; a later
    // tool call starts its own run rather than reaching back into it.
    pendingItems: hasToolCall(pending) ? pending : [],
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending = [...input.history.pendingItems];
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
      if (hostPlacement === "head" || pendingIncludesHead || !isSealed) {
        liveGroups.set(run.id, input.buildGroup(run));
      }
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isGroupableItem(item)) {
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
  if (input.history.groupsByHostId.size === 0) {
    return {
      tail: input.history.tail,
      head,
      groupsByHostId: liveGroups,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id)) {
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
