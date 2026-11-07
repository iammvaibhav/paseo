import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

const IRC_OPEN_TAG = "<irc>";
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/i;
const TASK_RESULT_ATTRIBUTE_PATTERN = /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g;
const OUTPUT_TAG_PATTERN = /<output>([\s\S]*?)<\/output>/i;
const INCOMING_IRC_HEADER_PATTERN =
  /^Incoming IRC message from agent\s+[`'"]?([^`'"\s()]+)[`'"]?(?:\s*\(reply to ([a-f0-9]+)\))?:\s*/im;

export interface ParsedIrcMessage {
  from: string | null;
  replyTo: string | null;
  text: string;
  label: string;
}

/** Check if text begins with the incoming IRC message tag. */
export function isIrcMessageText(text: unknown): text is string {
  return typeof text === "string" && text.trimStart().startsWith(IRC_OPEN_TAG);
}

function stripIrcEnvelope(text: string): string {
  let stripped = text.trim();
  stripped = stripped.replace(/^\s*<irc>\s*/i, "");
  stripped = stripped.replace(/^Incoming IRC message from[^\n]*:\s*/i, "");
  stripped = stripped.replace(/\n\s*Sent while waiting\/working[^\n]*/gi, "");
  stripped = stripped.replace(/\n\s*If response expected, reply via[^\n]*/gi, "");
  stripped = stripped.replace(/\s*<\/irc>\s*$/i, "");
  return stripped.trim();
}

function parseTaskResultBlock(
  rawBody: string,
  from: string | null,
): {
  cleanText: string;
  taskStatus: string | null;
  taskDuration: string | null;
} {
  const taskMatch = rawBody.match(TASK_RESULT_TAG_PATTERN);
  if (!taskMatch) {
    return { cleanText: rawBody, taskStatus: null, taskDuration: null };
  }

  const attrsStr = taskMatch[1] ?? "";
  const inner = taskMatch[2] ?? "";
  const attributes: Record<string, string> = {};
  for (const match of attrsStr.matchAll(TASK_RESULT_ATTRIBUTE_PATTERN)) {
    if (match[1] && match[2] !== undefined) {
      attributes[match[1]] = match[2].trim();
    }
  }

  const outputMatch = inner.match(OUTPUT_TAG_PATTERN);
  const output = outputMatch ? outputMatch[1]!.trim() : inner.trim();
  const taskId = attributes.id ?? from ?? "result";
  const taskStatus = attributes.status ?? "completed";
  const taskDuration = attributes.duration ?? null;

  const durationPart = taskDuration ? ` (${taskDuration})` : "";
  const formattedTask = `Task ${taskId} ${taskStatus}${durationPart}:\n\n${output}`;
  const cleanText = (
    rawBody.slice(0, taskMatch.index) +
    formattedTask +
    rawBody.slice(taskMatch.index! + taskMatch[0].length)
  ).trim();

  return { cleanText, taskStatus, taskDuration };
}

function buildIrcLabel(
  cleanText: string,
  from: string | null,
  taskStatus: string | null,
  taskDuration: string | null,
): string {
  const fromPart = from ? `from ${from}` : "peer";
  if (taskStatus) {
    const durationPart = taskDuration ? ` (${taskDuration})` : "";
    return `receive · ${fromPart} · task ${taskStatus}${durationPart}`;
  }
  const firstLine =
    cleanText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const preview = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
  return preview ? `receive · ${fromPart} · ${preview}` : `receive · ${fromPart}`;
}

/** Parse incoming IRC message text into clean text and metadata. */
export function parseIrcMessageText(text: string): ParsedIrcMessage {
  const headerMatch = text.match(INCOMING_IRC_HEADER_PATTERN);
  const from = headerMatch?.[1]?.trim() ?? null;
  const replyTo = headerMatch?.[2]?.trim() ?? null;

  const rawBody = stripIrcEnvelope(text);
  const { cleanText, taskStatus, taskDuration } = parseTaskResultBlock(rawBody, from);
  const label = buildIrcLabel(cleanText, from, taskStatus, taskDuration);

  return { from, replyTo, text: cleanText, label };
}

/** Convert raw IRC message text to a synthetic hub tool call timeline item. */
export function convertIrcMessageToTimelineToolCall(
  text: string,
  messageId?: string,
): ToolCallTimelineItem {
  const parsed = parseIrcMessageText(text);
  const callId = messageId ? `irc-${messageId}` : `irc-${Math.random().toString(36).slice(2, 10)}`;

  return {
    type: "tool_call",
    callId,
    name: "hub",
    status: "completed",
    detail: {
      type: "plain_text",
      label: parsed.label,
      text: parsed.text,
      icon: "bot",
    },
    metadata: {
      synthetic: true,
      source: "omp_irc",
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
    },
    error: null,
  };
}
