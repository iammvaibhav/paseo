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
 * - `completed` means conclusively done — everything asked, finished. Any
 *   doubt, cut short, still in discussion: report `inconclusive`, never
 *   `completed`.
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
 * The agent's current Mission Control identity, known at spawn time. Values
 * mirror the stored agent record fields the report_status tool updates:
 * title → record.title, description → record.shortDescription. Absent fields
 * mean "never set".
 */
export interface SelfReportIdentitySeed {
  title?: string | null;
  description?: string | null;
}

/**
 * The per-agent identity seed appended to the self-report paragraph: the
 * agent's CURRENT title/description (or an explicit "unset" note), so it can
 * compare-and-decide before its next report_status. Built per-agent at spawn,
 * because the append is built per-agent.
 */
export function buildSelfReportIdentitySeed(identity?: SelfReportIdentitySeed): string {
  const title = identity?.title?.trim();
  const description = identity?.description?.trim();
  if (!title && !description) {
    return (
      "Your current identity is unset: you have no title or description yet. " +
      "Your status reports should include a fresh description of what you are doing NOW, and refine title if it is a raw user prompt or spawn seed."
    );
  }
  const lines = ["Your current identity (persisted on your agent record):"];
  if (title) {
    lines.push(`- Title: ${title}`);
  }
  if (description) {
    lines.push(`- Description: ${description}`);
  }
  lines.push(
    "Include a fresh description on status reports so your current activity is up to date, and refine title if it is still a raw prompt or spawn seed.",
  );
  return lines.join("\n");
}

/**
 * The self-report paragraph for an agent's system prompt, or null when it must
 * be omitted: the kill-switch is off, or the agent is mission-control-labeled
 * (the Commander and monitors do not self-report). When included, the agent's
 * current identity (as known at spawn) is seeded right after the paragraph so
 * the agent can compare-and-decide; `currentIdentity` omitted or empty yields
 * an explicit "not set yet" note.
 */
export function buildSelfReportSystemPrompt(
  labels: Record<string, string>,
  enabled: boolean,
  currentIdentity?: SelfReportIdentitySeed,
): string | null {
  if (!enabled || hasMissionControlLabels(labels)) {
    return null;
  }
  return `${MISSION_CONTROL_SELF_REPORT_PROMPT}\n\n${buildSelfReportIdentitySeed(currentIdentity)}`;
}
