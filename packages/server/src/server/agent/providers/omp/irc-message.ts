import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;
type OmpIrcToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

const IRC_OPEN_TAG = "<irc>";
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/i;
const TASK_RESULT_ATTRIBUTE_PATTERN = /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g;
const OUTPUT_TAG_PATTERN = /<output>([\s\S]*?)<\/output>/i;
const INCOMING_IRC_HEADER_PATTERN =
  /^Incoming IRC message from agent\s+[`'"]?([^`'"\s()]+)[`'"]?(?:\s*\(reply to ([a-f0-9]+)\))?:\s*/im;

export interface OmpTaskResultInfo {
  id: string | null;
  agent: string | null;
  status: string | null;
  duration: string | null;
  output: string | null;
}

export interface OmpIrcPayload {
  from: string | null;
  replyTo: string | null;
  text: string;
  taskResult: OmpTaskResultInfo | null;
}

/** Check if a custom message or text is an incoming IRC message. */
export function isOmpIrcMessage(message: OmpCustomMessage, text: string): boolean {
  if (Reflect.get(message, "customType") === "irc:incoming") {
    return true;
  }
  return isIrcMessageText(text);
}

/** Check if text starts with the IRC message tag. */
export function isIrcMessageText(text: string): boolean {
  return text.trimStart().startsWith(IRC_OPEN_TAG);
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
  taskResult: OmpTaskResultInfo | null;
} {
  const taskMatch = rawBody.match(TASK_RESULT_TAG_PATTERN);
  if (!taskMatch) {
    return { cleanText: rawBody, taskResult: null };
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
  const taskId = attributes.id ?? from ?? null;
  const taskStatus = attributes.status ?? "completed";
  const duration = attributes.duration ?? null;
  const agentType = attributes.agent ?? null;

  const taskResult: OmpTaskResultInfo = {
    id: taskId,
    agent: agentType,
    status: taskStatus,
    duration,
    output,
  };

  const durationSuffix = duration ? ` (${duration})` : "";
  const formattedTask = `Task ${taskId ?? "result"} ${taskStatus}${durationSuffix}:\n\n${output}`;
  const cleanText = (
    rawBody.slice(0, taskMatch.index) +
    formattedTask +
    rawBody.slice(taskMatch.index! + taskMatch[0].length)
  ).trim();

  return { cleanText, taskResult };
}

/** Parse an incoming IRC message into a structured payload. */
export function parseOmpIrcMessage(message: OmpCustomMessage, text: string): OmpIrcPayload {
  const details = Reflect.get(message, "details");
  const detailsRecord =
    typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;

  let from =
    typeof detailsRecord?.from === "string" && detailsRecord.from.trim()
      ? detailsRecord.from.trim()
      : null;
  let replyTo =
    typeof detailsRecord?.replyTo === "string" && detailsRecord.replyTo.trim()
      ? detailsRecord.replyTo.trim()
      : null;

  const headerMatch = text.match(INCOMING_IRC_HEADER_PATTERN);
  if (headerMatch) {
    from = from ?? headerMatch[1]?.trim() ?? null;
    replyTo = replyTo ?? headerMatch[2]?.trim() ?? null;
  }

  const rawBody =
    typeof detailsRecord?.message === "string" && detailsRecord.message.trim()
      ? detailsRecord.message.trim()
      : stripIrcEnvelope(text);

  const { cleanText, taskResult } = parseTaskResultBlock(rawBody, from);

  return {
    from,
    replyTo,
    text: cleanText,
    taskResult,
  };
}

function buildIrcLabel(payload: OmpIrcPayload): string {
  const fromPart = payload.from ? `from ${payload.from}` : "peer";
  if (payload.taskResult) {
    const duration = payload.taskResult.duration ? ` (${payload.taskResult.duration})` : "";
    return `receive · ${fromPart} · task ${payload.taskResult.status ?? "completed"}${duration}`;
  }
  const firstLine =
    payload.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const preview = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
  return preview ? `receive · ${fromPart} · ${preview}` : `receive · ${fromPart}`;
}

function buildIrcCallId(message: OmpCustomMessage, text: string): string {
  const id = Reflect.get(message, "id");
  if (typeof id === "string" && id.trim()) {
    return `omp-irc:${id.trim()}`;
  }
  const digest = createHash("sha1").update(text.trim()).digest("hex").slice(0, 12);
  return `omp-irc:${digest}`;
}

/** Map an incoming OMP IRC custom message to a synthetic tool call item. */
export function mapOmpIrcMessageToToolCall(
  message: OmpCustomMessage,
  text: string,
): OmpIrcToolCallItem | null {
  if (!isOmpIrcMessage(message, text)) {
    return null;
  }

  const payload = parseOmpIrcMessage(message, text);
  return {
    type: "tool_call",
    callId: buildIrcCallId(message, text),
    name: "hub",
    status: "completed",
    detail: {
      type: "plain_text",
      label: buildIrcLabel(payload),
      text: payload.text,
      icon: "bot",
    },
    metadata: {
      synthetic: true,
      source: "omp_irc",
      ...(payload.from ? { from: payload.from } : {}),
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      ...(payload.taskResult ? { taskResult: payload.taskResult } : {}),
    },
    error: null,
  };
}
