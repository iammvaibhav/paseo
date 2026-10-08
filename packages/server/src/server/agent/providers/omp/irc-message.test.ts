import { describe, expect, test } from "vitest";

import { isOmpIrcMessage, mapOmpIrcMessageToToolCall, parseOmpIrcMessage } from "./irc-message.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

function createCustomMessage(input: {
  content: string;
  customType?: string;
  details?: Record<string, unknown>;
  id?: string;
}): OmpCustomMessage {
  return {
    role: "custom",
    content: input.content,
    ...(input.customType ? { customType: input.customType } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.id ? { id: input.id } : {}),
  } as OmpCustomMessage;
}

const SAMPLE_TASK_RESULT_CONTENT = [
  "<irc>",
  "Incoming IRC message from agent `PolishIntegrate` (reply to 1589897060cfaba5):",
  "",
  '<task-result id="PolishIntegrate" agent="task" status="completed" duration="6m10s">',
  '<meta lines="28" size="1.8KB" />',
  "<output>",
  "{",
  '  "status": "complete"',
  "}",
  "</output>",
  "</task-result>",
  'If response expected, reply via hub ( op: "send" , to: "PolishIntegrate" ); may finish current step first. No one replies on your behalf.',
  "</irc>",
].join("\n");

const SAMPLE_PLAIN_CONTENT = [
  "<irc>",
  "Incoming IRC message from agent `PolishReview`:",
  "",
  "PolishReview verdict: FAIL (blocking defects found).",
  "1. pills vertical placement in tile.tsx renders TilePills below streamFrame.",
  "",
  "Sent while waiting/working. Active interruptible wait stopped early for immediate reading.",
  "",
  'If response expected, reply via `hub` (`op: "send"`, `to: "PolishReview"`); may finish current step first. No one replies on your behalf.',
  "</irc>",
].join("\n");

describe("OMP IRC message detection", () => {
  test("detects custom messages with irc:incoming customType", () => {
    const msg = createCustomMessage({
      content: "plain text",
      customType: "irc:incoming",
    });
    expect(isOmpIrcMessage(msg, "plain text")).toBe(true);
  });

  test("detects text that starts with <irc>", () => {
    const msg = createCustomMessage({ content: SAMPLE_PLAIN_CONTENT });
    expect(isOmpIrcMessage(msg, SAMPLE_PLAIN_CONTENT)).toBe(true);
    expect(isOmpIrcMessage(msg, "   \n<irc>hello</irc>")).toBe(true);
  });

  test("returns false for regular prompts and unrelated custom messages", () => {
    const msg = createCustomMessage({ content: "hello world" });
    expect(isOmpIrcMessage(msg, "hello world")).toBe(false);
    expect(isOmpIrcMessage(msg, "what is an <irc> channel?")).toBe(false);
  });
});

describe("OMP IRC message parsing", () => {
  test("extracts sender from details and cleans task-result XML tags", () => {
    const msg = createCustomMessage({
      content: SAMPLE_TASK_RESULT_CONTENT,
      customType: "irc:incoming",
      details: {
        id: "15898adaa04fabba",
        from: "PolishIntegrate",
        message: [
          '<task-result id="PolishIntegrate" agent="task" status="completed" duration="6m10s">',
          '<meta lines="28" size="1.8KB" />',
          "<output>",
          "{",
          '  "status": "complete"',
          "}",
          "</output>",
          "</task-result>",
        ].join("\n"),
      },
    });

    const parsed = parseOmpIrcMessage(msg, SAMPLE_TASK_RESULT_CONTENT);
    expect(parsed.from).toBe("PolishIntegrate");
    expect(parsed.replyTo).toBe("1589897060cfaba5");
    expect(parsed.taskResult).toEqual({
      id: "PolishIntegrate",
      agent: "task",
      status: "completed",
      duration: "6m10s",
      output: '{\n  "status": "complete"\n}',
    });
    expect(parsed.text).toBe(
      'Task PolishIntegrate completed (6m10s):\n\n{\n  "status": "complete"\n}',
    );
  });

  test("extracts sender and cleans boilerplate from raw text without details", () => {
    const msg = createCustomMessage({ content: SAMPLE_PLAIN_CONTENT });
    const parsed = parseOmpIrcMessage(msg, SAMPLE_PLAIN_CONTENT);

    expect(parsed.from).toBe("PolishReview");
    expect(parsed.text).toBe(
      "PolishReview verdict: FAIL (blocking defects found).\n1. pills vertical placement in tile.tsx renders TilePills below streamFrame.",
    );
    expect(parsed.taskResult).toBeNull();
  });

  test("parses task-result attributes with typographic quotes", () => {
    const content = [
      "<irc>",
      "Incoming IRC message from agent TestWorker:",
      "",
      "<task-result id=“WorkerA” agent=“scout” status=“completed” duration=“12s”>",
      "<output>found 3 files</output>",
      "</task-result>",
      "</irc>",
    ].join("\n");

    const msg = createCustomMessage({ content });
    const parsed = parseOmpIrcMessage(msg, content);

    expect(parsed.from).toBe("TestWorker");
    expect(parsed.taskResult).toEqual({
      id: "WorkerA",
      agent: "scout",
      status: "completed",
      duration: "12s",
      output: "found 3 files",
    });
    expect(parsed.text).toBe("Task WorkerA completed (12s):\n\nfound 3 files");
  });
});

describe("OMP IRC tool call mapping", () => {
  test("maps task-result IRC messages to a synthetic hub tool call", () => {
    const msg = createCustomMessage({
      content: SAMPLE_TASK_RESULT_CONTENT,
      customType: "irc:incoming",
      id: "irc-msg-1",
      details: {
        id: "15898adaa04fabba",
        from: "PolishIntegrate",
      },
    });

    const item = mapOmpIrcMessageToToolCall(msg, SAMPLE_TASK_RESULT_CONTENT);
    expect(item).toEqual({
      type: "tool_call",
      callId: "omp-irc:irc-msg-1",
      name: "hub",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "receive · from PolishIntegrate · task completed (6m10s)",
        text: 'Task PolishIntegrate completed (6m10s):\n\n{\n  "status": "complete"\n}',
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "PolishIntegrate",
        replyTo: "1589897060cfaba5",
        taskResult: {
          id: "PolishIntegrate",
          agent: "task",
          status: "completed",
          duration: "6m10s",
          output: '{\n  "status": "complete"\n}',
        },
      },
      error: null,
    });
  });

  test("maps plain IRC messages to a synthetic hub tool call with message preview", () => {
    const msg = createCustomMessage({
      content: SAMPLE_PLAIN_CONTENT,
      customType: "irc:incoming",
    });

    const item = mapOmpIrcMessageToToolCall(msg, SAMPLE_PLAIN_CONTENT);
    expect(item).toMatchObject({
      type: "tool_call",
      name: "hub",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "receive · from PolishReview · PolishReview verdict: FAIL (blocking defects found).",
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "PolishReview",
      },
      error: null,
    });
    expect(item?.callId).toMatch(/^omp-irc:[a-f0-9]{12}$/);
  });

  test("returns null for non-IRC custom messages", () => {
    const msg = createCustomMessage({
      content: "plain text",
      customType: "advisor",
    });
    expect(mapOmpIrcMessageToToolCall(msg, "plain text")).toBeNull();
  });
});
