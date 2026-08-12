import { describe, expect, test } from "vitest";

import {
  PARENT_AGENT_ID_LABEL,
  SELECTION_ASK_LABEL,
  SELECTION_ASK_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { buildSelectionAskLabels, buildSelectionAskPrompt } from "./selection-ask.js";

describe("buildSelectionAskPrompt", () => {
  test("formats single-line selection prompt correctly", () => {
    const prompt = buildSelectionAskPrompt({
      selection: "const x = 10;",
      question: "What does this variable do?",
    });

    expect(prompt).toBe(
      `This is a side ask from a selection in the parent chat. Only answer and make no changes unless the user asks to.\n\n> const x = 10;\n\n....\nWhat does this variable do?`,
    );
  });

  test("formats multiline selection prompt with > prefix on each line", () => {
    const prompt = buildSelectionAskPrompt({
      selection: "function foo() {\n  return 42;\n}",
      question: "Can you explain this function?",
    });

    expect(prompt).toBe(
      `This is a side ask from a selection in the parent chat. Only answer and make no changes unless the user asks to.\n\n> function foo() {\n>   return 42;\n> }\n\n....\nCan you explain this function?`,
    );
  });
});

describe("buildSelectionAskLabels", () => {
  test("returns record with parent agent id, selection ask flag, and source agent id labels", () => {
    const labels = buildSelectionAskLabels({ sourceAgentId: "agent-parent-123" });

    expect(labels).toEqual({
      [PARENT_AGENT_ID_LABEL]: "agent-parent-123",
      [SELECTION_ASK_LABEL]: "1",
      [SELECTION_ASK_SOURCE_LABEL]: "agent-parent-123",
    });
  });
});
