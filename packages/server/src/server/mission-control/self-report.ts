import { hasMissionControlLabels } from "./naming.js";

/**
 * Paragraph appended to every daemon agent's system prompt (via the
 * daemonAppendSystemPrompt path). Self-reporting is the sole status channel;
 * no summarizer backstop exists.
 *
 * Rules (docs/mission-control.md, Status reporting):
 * - Report at major steps only: root cause found, fix landed, tests green,
 *   blocked, direction changed, done. Silence between milestones.
 * - `completed` means conclusively done — everything asked, finished. Any
 *   doubt, cut short, still in discussion: report `inconclusive`, never
 *   `completed`.
 * - Claims of completion should carry proofs; verifiers demand proof otherwise.
 * - Prefer hub-wait over `sleep`/timeout polling loops.
 */
export const MISSION_CONTROL_SELF_REPORT_PROMPT = `Mission Control self-reporting: use the report_status tool at major steps only — root cause found, a fix landed, tests green, blocked, direction changed, done. Silence between milestones; never send progress updates. "completed" means conclusively done: everything asked, finished. Any doubt, cut short, or still in discussion → report "inconclusive", never "completed". Completion claims should carry proofs (files, urls, code/api excerpts). Prefer hub-wait over sleep/timeout polling loops. Headlines under 120 characters.`;

/**
 * The self-report paragraph for an agent's system prompt, or null when it must
 * be omitted: the kill-switch is off, or the agent is mission-control-labeled
 * (the Commander and monitors do not self-report).
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
