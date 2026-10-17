/**
 * Agent modes, shown to users as **Approach**: how an agent works (build it
 * yourself, orchestrate, plan first, …). Separate from the provider **Mode**
 * (`modeId`: permissions/sandbox, shown as access). Ids are wire and storage
 * values and never change; only labels are display text.
 *
 * The mode's instructions never enter the system prompt. The daemon prepends
 * a `<paseo-mode>` block to the next user message after the mode is set or
 * changed, so switching mid-chat keeps the provider's prompt cache and starts
 * no work on its own. The instruction text lives in editable markdown files on
 * the daemon (`packages/server/src/server/agent/agent-modes/prompts/<id>.md`);
 * this module carries only what clients and routers need.
 */

export const AGENT_MODE_IDS = [
  "solo",
  "orchestrator",
  "plan",
  "research",
  "review",
  "debug",
] as const;

export type AgentModeId = (typeof AGENT_MODE_IDS)[number];

export const DEFAULT_AGENT_MODE_ID: AgentModeId = "solo";

export interface AgentModeDefinition {
  id: AgentModeId;
  label: string;
  /** One line. Shown in the picker and used as the routing classifier's criterion. */
  description: string;
}

export const AGENT_MODES: readonly AgentModeDefinition[] = [
  {
    id: "solo",
    label: "Build",
    description: "A bounded task the agent completes itself, without sub-agents.",
  },
  {
    id: "orchestrator",
    label: "Orchestrate",
    description:
      "A large multi-part task with independent slices: decompose, delegate to sub-agents, integrate.",
  },
  {
    id: "plan",
    label: "Plan",
    description:
      "A design choice or risky change: investigate, propose a plan, and wait for approval before editing.",
  },
  {
    id: "research",
    label: "Research",
    description:
      "A question, investigation, or comparison: read-only, report findings with evidence, change nothing.",
  },
  {
    id: "review",
    label: "Review",
    description: "Review a PR, branch, diff, or change and report findings by severity.",
  },
  {
    id: "debug",
    label: "Debug",
    description:
      "A bug, failure, or flaky behavior: reproduce first, find the root cause, fix, show before and after.",
  },
];

export function isAgentModeId(value: unknown): value is AgentModeId {
  return typeof value === "string" && (AGENT_MODE_IDS as readonly string[]).includes(value);
}

export function getAgentModeDefinition(id: string | null | undefined): AgentModeDefinition | null {
  return AGENT_MODES.find((mode) => mode.id === id) ?? null;
}

const AGENT_MODE_BLOCK_PATTERN = /^<paseo-mode name="([a-z-]+)">\n[\s\S]*?\n<\/paseo-mode>\n\n?/;

/** The block the daemon prepends to a user message. Ends with a blank line. */
export function formatAgentModeBlock(id: AgentModeId, instructions: string): string {
  return `<paseo-mode name="${id}">\n${instructions.trim()}\n</paseo-mode>\n\n`;
}

/**
 * Split a leading `<paseo-mode>` block off a user message. Clients render the
 * body plus a mode chip; summarizers and title generators use the body only.
 */
export function splitAgentModeBlock(text: string): { modeId: AgentModeId | null; body: string } {
  const match = AGENT_MODE_BLOCK_PATTERN.exec(text);
  if (!match) {
    return { modeId: null, body: text };
  }
  const modeId = isAgentModeId(match[1]) ? match[1] : null;
  return { modeId, body: text.slice(match[0].length) };
}
