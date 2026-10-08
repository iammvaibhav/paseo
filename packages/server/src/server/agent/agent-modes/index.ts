import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAgentModeBlock, type AgentModeId } from "@getpaseo/protocol/agent-modes";
import type { AgentPromptInput } from "../agent-sdk-types.js";

// Editable instruction text, one markdown file per mode. Copied beside this
// module into dist by the server build. Read on every injection (a few hundred
// bytes) so an edited file applies to the next message without a restart.
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export function buildAgentModeBlock(id: AgentModeId): string {
  return formatAgentModeBlock(id, readFileSync(join(PROMPTS_DIR, `${id}.md`), "utf8"));
}

/**
 * Whether a prompt is a user message that may carry the mode block. Machinery
 * envelopes (`<paseo-system>`) and slash commands (which providers parse from
 * the first character) never do.
 */
export function canCarryAgentModeBlock(prompt: AgentPromptInput): boolean {
  const firstText =
    typeof prompt === "string"
      ? prompt
      : (prompt.find((block): block is { type: "text"; text: string } => block.type === "text")
          ?.text ?? "");
  const trimmed = firstText.trimStart();
  return !trimmed.startsWith("/") && !trimmed.startsWith("<paseo-system>");
}

export function prependToPrompt(prompt: AgentPromptInput, prefix: string): AgentPromptInput {
  if (typeof prompt === "string") {
    return prefix + prompt;
  }
  const index = prompt.findIndex((block) => block.type === "text");
  if (index === -1) {
    return [{ type: "text", text: prefix.trimEnd() }, ...prompt];
  }
  const block = prompt[index] as { type: "text"; text: string };
  return prompt.map((entry, i) => (i === index ? { ...block, text: prefix + block.text } : entry));
}
