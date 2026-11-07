import { describe, expect, test } from "vitest";
import { AGENT_MODE_IDS, splitAgentModeBlock } from "@getpaseo/protocol/agent-modes";
import { buildAgentModeBlock } from "./index.js";

describe("agent mode prompts", () => {
  // A mode without its prompt file throws ENOENT on the first message sent in
  // that mode, so every id must ship a non-empty file.
  test.each(AGENT_MODE_IDS)("%s has a prompt file", (id) => {
    const block = buildAgentModeBlock(id);
    const { modeId, body } = splitAgentModeBlock(`${block}hello`);
    expect(modeId).toBe(id);
    expect(body).toBe("hello");
    expect(block.length).toBeGreaterThan(`<paseo-mode name="${id}">\n\n</paseo-mode>\n\n`.length);
  });
});
