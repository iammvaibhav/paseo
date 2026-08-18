import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hasMissionControlLabels } from "./naming.js";

/**
 * The self-reporting paragraph appended to every daemon agent's system prompt
 * (via the daemonAppendSystemPrompt path). Shipped as a repo markdown file
 * (self-report-prompt.md) and bundled into the server dist beside this module
 * at build time (see packages/server/package.json build:lib) — the same
 * mechanism commander-prompt.md uses. Self-reporting is the sole status
 * channel; no summarizer backstop exists.
 *
 * Rules (docs/mission-control.md, Status reporting):
 * - Report at major steps only: root cause found, fix landed, tests green,
 *   blocked, direction changed, done. Silence between milestones.
 * - Send `completed` only when everything asked is conclusively done; send
 *   `blocked` when stuck (a Commander-thread card); `kind` flavors the card.
 *   `working`/`inconclusive` still parse for legacy clients but are never
 *   advertised to agents.
 * - Claims of completion should carry proofs; verifiers demand proof otherwise.
 * - Prefer hub-wait over `sleep`/timeout polling loops.
 * - The agent owns its title + description; both ride on report_status
 *   (see the paragraph for the full rules).
 */
export const MISSION_CONTROL_SELF_REPORT_PROMPT = readBundledSelfReportPrompt();

function readBundledSelfReportPrompt(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "self-report-prompt.md"),
    "utf8",
  ).trim();
}

/**
 * The self-report paragraph for an agent's system prompt, or null when it must
 * be omitted: the kill-switch is off, or the agent is mission-control-labeled
 * (the Commander and monitors do not self-report).
 *
 * The paragraph is static — it never embeds the agent's title/description.
 * The identity seed used to be appended here per-agent, which made the
 * composed daemon append prompt (and therefore the OMP warm-pool key) differ
 * per agent and thrash the pool. The agent still owns its title/description;
 * they ride on report_status and the feed, not the system prompt.
 */
export function buildSelfReportSystemPrompt(
  labels: Record<string, string>,
  enabled: boolean,
): string | null {
  if (!enabled || hasMissionControlLabels(labels)) {
    return null;
  }
  return MISSION_CONTROL_SELF_REPORT_PROMPT;
}
