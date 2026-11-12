/**
 * Project ACP session/update records into Paseo timeline items.
 *
 * Used for offline history: Grok persists the live ACP update stream to
 * `updates.jsonl`. Replaying that stream with the same rules as live
 * `session/load` hydration produces the UI timeline without spawning the agent.
 *
 * Tool rule (matches loadSession compaction observed in goldens):
 * emit each tool once, when it first reaches a terminal status (completed/failed/canceled),
 * using the fully merged snapshot at that moment.
 */
import { randomUUID } from "node:crypto";

import type {
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";

/** Minimal ACP session update shape we need for history projection. */
export interface AcpHistorySessionUpdate {
  sessionUpdate: string;
  messageId?: string | null;
  content?: ContentBlock | { type?: string; text?: string } | null;
  toolCallId?: string;
  title?: string | null;
  kind?: ToolKind | string | null;
  status?: ToolCallStatus | string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  contentBlocks?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  // tool_call / tool_call_update also carry `content` as ToolCallContent[]
  [key: string]: unknown;
}

export interface ACPToolSnapshot {
  toolCallId: string;
  title: string;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

class AcpHistoryProjector {
  private readonly items: AgentTimelineItem[] = [];
  private pendingUser: { text: string; messageId?: string } | null = null;
  private fallbackAssistantMessageId: string | null = null;
  private readonly toolSnapshots = new Map<string, ACPToolSnapshot>();
  private readonly emittedTools = new Set<string>();

  apply(update: AcpHistorySessionUpdate): void {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      this.applyUserChunk(update);
      return;
    }
    // Any non-user update flushes pending user text first (live ACP behavior).
    this.flushUser();
    if (kind === "agent_thought_chunk") {
      this.applyThoughtChunk(update);
      return;
    }
    if (kind === "agent_message_chunk") {
      this.applyAssistantChunk(update);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.applyToolUpdate(update);
    }
    // turn_completed, usage_update, session_info_update, etc. — no timeline rows
  }

  finish(): AgentTimelineItem[] {
    this.flushUser();
    // Emit any tools that never reached a terminal status (still show last snapshot).
    for (const [toolCallId, snapshot] of this.toolSnapshots) {
      if (this.emittedTools.has(toolCallId)) continue;
      this.emittedTools.add(toolCallId);
      this.items.push(mapToolSnapshotToTimeline(snapshot));
    }
    return this.items;
  }

  private flushUser(): void {
    if (!this.pendingUser) return;
    const text = this.pendingUser.text;
    const messageId = this.pendingUser.messageId;
    this.pendingUser = null;
    if (!text) return;
    this.items.push({
      type: "user_message",
      text,
      ...(messageId ? { messageId } : {}),
    });
  }

  private applyUserChunk(update: AcpHistorySessionUpdate): void {
    this.fallbackAssistantMessageId = null;
    const chunkText = contentBlockToText(update.content as ContentBlock);
    if (!chunkText) return;
    const messageId =
      typeof update.messageId === "string" && update.messageId.length > 0
        ? update.messageId
        : undefined;
    const startsNew = Boolean(
      this.pendingUser?.messageId && messageId && this.pendingUser.messageId !== messageId,
    );
    if (startsNew) this.flushUser();
    this.pendingUser ??= { text: "", ...(messageId ? { messageId } : {}) };
    if (!this.pendingUser.messageId && messageId) this.pendingUser.messageId = messageId;
    this.pendingUser.text += chunkText;
  }

  private applyThoughtChunk(update: AcpHistorySessionUpdate): void {
    this.fallbackAssistantMessageId = null;
    const text = contentBlockToText(update.content as ContentBlock);
    if (text) this.items.push({ type: "reasoning", text });
  }

  private applyAssistantChunk(update: AcpHistorySessionUpdate): void {
    const text = contentBlockToText(update.content as ContentBlock);
    if (!text) return;
    const messageId = resolveAssistantMessageId(update.messageId, () => {
      this.fallbackAssistantMessageId ??= randomUUID();
      return this.fallbackAssistantMessageId;
    });
    if (typeof update.messageId === "string" && update.messageId.length > 0) {
      this.fallbackAssistantMessageId = null;
    }
    this.items.push({ type: "assistant_message", text, messageId });
  }

  private applyToolUpdate(update: AcpHistorySessionUpdate): void {
    this.fallbackAssistantMessageId = null;
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
    if (!toolCallId) return;

    const previous = this.toolSnapshots.get(toolCallId);
    const content = coalesceToolContent(update);
    const snapshot = mergeToolSnapshot(toolCallId, update, previous, content);
    this.toolSnapshots.set(toolCallId, snapshot);

    const status = mapToolStatus(snapshot.status);
    if (
      (status === "completed" || status === "failed" || status === "canceled") &&
      !this.emittedTools.has(toolCallId)
    ) {
      this.emittedTools.add(toolCallId);
      this.items.push(mapToolSnapshotToTimeline(snapshot));
    }
  }
}

/**
 * Project an ordered list of ACP session updates into timeline items.
 * Mirrors the history-replay behavior of ACPAgentSession while replaying loadSession.
 */
export function projectAcpSessionUpdates(
  updates: readonly AcpHistorySessionUpdate[],
): AgentTimelineItem[] {
  const projector = new AcpHistoryProjector();
  for (const update of updates) {
    projector.apply(update);
  }
  return projector.finish();
}

function resolveAssistantMessageId(
  messageId: string | null | undefined,
  fallback: () => string,
): string {
  if (typeof messageId === "string" && messageId.length > 0) {
    return messageId;
  }
  return fallback();
}

function coalesceToolContent(
  update: AcpHistorySessionUpdate,
): ToolCallContent[] | null | undefined {
  if (Array.isArray(update.content)) {
    return update.content as ToolCallContent[];
  }
  if (Array.isArray(update.contentBlocks)) {
    return update.contentBlocks;
  }
  return undefined;
}

function pickDefined<T>(next: T | undefined, previous: T | undefined, fallback: T): T {
  if (next !== undefined) return next;
  if (previous !== undefined) return previous;
  return fallback;
}

function mergeToolSnapshot(
  toolCallId: string,
  update: AcpHistorySessionUpdate,
  previous: ACPToolSnapshot | undefined,
  content: ToolCallContent[] | null | undefined,
): ACPToolSnapshot {
  const titleFromUpdate =
    typeof update.title === "string" && update.title.length > 0 ? update.title : undefined;
  return {
    toolCallId,
    title: titleFromUpdate ?? previous?.title ?? toolCallId,
    kind: pickDefined(update.kind as ToolKind | null | undefined, previous?.kind, null),
    status: pickDefined(update.status as ToolCallStatus | null | undefined, previous?.status, null),
    content: pickDefined(content, previous?.content, null),
    locations: pickDefined(update.locations, previous?.locations, null),
    rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
  };
}

function mapToolStatus(status: ToolCallStatus | null | undefined): ToolCallTimelineItem["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    default:
      return "running";
  }
}

function mapToolSnapshotToTimeline(snapshot: ACPToolSnapshot): ToolCallTimelineItem {
  const status = mapToolStatus(snapshot.status);
  const detail = mapToolDetail(snapshot);
  // ACP kind "other" is a placeholder; the UI name is the human title (e.g. List `/path`).
  const kind = snapshot.kind && snapshot.kind !== "other" ? snapshot.kind : null;
  const base = {
    type: "tool_call" as const,
    callId: snapshot.toolCallId,
    name: kind ?? snapshot.title,
    detail,
    metadata: {
      ...(kind ? { kind } : {}),
      title: snapshot.title,
    },
  };
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { message: readErrorMessage(snapshot.rawOutput) },
    };
  }
  if (status === "completed") {
    return { ...base, status: "completed", error: null };
  }
  return { ...base, status: "running", error: null };
}

interface ToolDetailContext {
  snapshot: ACPToolSnapshot;
  firstLocation: string | undefined;
  textContent: string | undefined;
  rawInput: Record<string, unknown> | null;
  rawOutput: Record<string, unknown> | null;
}

function mapToolDetail(snapshot: ACPToolSnapshot): ToolCallDetail {
  const ctx: ToolDetailContext = {
    snapshot,
    firstLocation: snapshot.locations?.[0]?.path,
    textContent: extractToolText(snapshot.content),
    rawInput: readRecord(snapshot.rawInput),
    rawOutput: readRecord(snapshot.rawOutput),
  };
  switch (snapshot.kind) {
    case "read":
      return mapReadDetail(ctx);
    case "edit":
    case "delete":
      return mapEditDetail(ctx, snapshot.kind === "delete");
    case "search":
      return mapSearchDetail(ctx);
    case "execute":
      return mapExecuteDetail(ctx);
    case "fetch":
      return mapFetchDetail(ctx);
    default:
      return {
        type: "unknown",
        input: snapshot.rawInput ?? null,
        output: snapshot.rawOutput ?? null,
      };
  }
}

function mapReadDetail(ctx: ToolDetailContext): ToolCallDetail {
  return {
    type: "read",
    filePath:
      ctx.firstLocation ??
      readString(ctx.rawInput, ["path", "filePath", "file"]) ??
      ctx.snapshot.title,
    content: ctx.textContent ?? readString(ctx.rawOutput, ["content", "text"]),
    offset: readNumber(ctx.rawInput, ["offset", "line"]),
    limit: readNumber(ctx.rawInput, ["limit"]),
  };
}

function mapEditDetail(ctx: ToolDetailContext, isDelete: boolean): ToolCallDetail {
  return {
    type: "edit",
    filePath:
      ctx.firstLocation ??
      readString(ctx.rawInput, ["path", "filePath", "file"]) ??
      ctx.snapshot.title,
    oldString: readString(ctx.rawInput, ["oldText", "oldString"]),
    newString: isDelete ? "" : readString(ctx.rawInput, ["newText", "newString"]),
    unifiedDiff: ctx.textContent ?? undefined,
  };
}

function mapSearchDetail(ctx: ToolDetailContext): ToolCallDetail {
  const filePaths = ctx.snapshot.locations?.map((location) => location.path);
  return {
    type: "search",
    query: readString(ctx.rawInput, ["query", "pattern"]) ?? ctx.snapshot.title,
    toolName: "search",
    content: ctx.textContent ?? readString(ctx.rawOutput, ["content", "text"]),
    // Omit empty filePaths so the shape matches live ACP streamHistory items.
    ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
  };
}

function mapExecuteDetail(ctx: ToolDetailContext): ToolCallDetail {
  // Match live ACP streamHistory shell detail: command + output (Grok stores
  // current_dir on rawOutput only; streamHistory omits cwd/exitCode).
  const output =
    ctx.textContent ??
    readString(ctx.rawOutput, ["output", "text", "output_for_prompt"]) ??
    (typeof ctx.rawOutput?.output_for_prompt === "string"
      ? ctx.rawOutput.output_for_prompt
      : undefined);
  return {
    type: "shell",
    command:
      buildShellCommand(ctx.rawInput) ??
      readString(ctx.rawInput, ["command"]) ??
      ctx.snapshot.title,
    output,
  };
}

function mapFetchDetail(ctx: ToolDetailContext): ToolCallDetail {
  return {
    type: "fetch",
    url: readString(ctx.rawInput, ["url"]) ?? ctx.snapshot.title,
    prompt: readString(ctx.rawInput, ["prompt"]),
    result: ctx.textContent ?? readString(ctx.rawOutput, ["result", "text", "content"]),
    code: readNumber(ctx.rawOutput, ["status", "code"]),
  };
}

function contentBlockToText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as ContentBlock & { type?: string; text?: string };
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "resource_link":
      return (
        (block as { title?: string; uri?: string }).title ?? (block as { uri?: string }).uri ?? ""
      );
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      if (typeof block.text === "string") return block.text;
      return "";
  }
}

function extractToolText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const text = contentBlockToText(item.content);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function buildShellCommand(record: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  const command = readString(record, ["command"]);
  const args = Array.isArray(record.args)
    ? record.args.filter((value): value is string => typeof value === "string")
    : [];
  if (!command) return undefined;
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  return readString(record, ["message", "error"]) ?? "Tool call failed";
}
