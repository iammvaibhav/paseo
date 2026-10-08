import { describe, expect, it } from "vitest";

import {
  convertIrcMessageToTimelineToolCall,
  isIrcMessageText,
  parseIrcMessageText,
} from "./irc-message";

const SAMPLE_TASK_RESULT = [
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

const SAMPLE_PLAIN = [
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

describe("isIrcMessageText", () => {
  it("returns true for strings starting with <irc>", () => {
    expect(isIrcMessageText(SAMPLE_TASK_RESULT)).toBe(true);
    expect(isIrcMessageText("  \n<irc>text</irc>")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isIrcMessageText("hello")).toBe(false);
    expect(isIrcMessageText("what is <irc>?")).toBe(false);
    expect(isIrcMessageText(null)).toBe(false);
    expect(isIrcMessageText(undefined)).toBe(false);
  });
});

describe("parseIrcMessageText", () => {
  it("parses task results cleanly without raw tags", () => {
    const parsed = parseIrcMessageText(SAMPLE_TASK_RESULT);
    expect(parsed.from).toBe("PolishIntegrate");
    expect(parsed.replyTo).toBe("1589897060cfaba5");
    expect(parsed.label).toBe("receive · from PolishIntegrate · task completed (6m10s)");
    expect(parsed.text).toBe(
      'Task PolishIntegrate completed (6m10s):\n\n{\n  "status": "complete"\n}',
    );
  });

  it("parses plain messages cleanly without boilerplate", () => {
    const parsed = parseIrcMessageText(SAMPLE_PLAIN);
    expect(parsed.from).toBe("PolishReview");
    expect(parsed.label).toBe(
      "receive · from PolishReview · PolishReview verdict: FAIL (blocking defects found).",
    );
    expect(parsed.text).toBe(
      "PolishReview verdict: FAIL (blocking defects found).\n1. pills vertical placement in tile.tsx renders TilePills below streamFrame.",
    );
  });
});

describe("convertIrcMessageToTimelineToolCall", () => {
  it("converts raw IRC text to a synthetic hub tool call", () => {
    const toolCall = convertIrcMessageToTimelineToolCall(SAMPLE_TASK_RESULT, "msg-123");
    expect(toolCall).toEqual({
      type: "tool_call",
      callId: "irc-msg-123",
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
      },
      error: null,
    });
  });
});
