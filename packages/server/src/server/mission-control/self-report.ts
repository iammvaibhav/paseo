import { hasMissionControlLabels } from "./naming.js";

/**
 * Paragraph appended to every daemon agent's system prompt (via the
 * daemonAppendSystemPrompt path). Self-reporting is primary; the summarizer
 * is the backstop. One report per real milestone, never progress.
 */
export const MISSION_CONTROL_SELF_REPORT_PROMPT = `Mission Control self-reporting: use the report_milestone tool once per real milestone — you found the root cause, you fixed something, tests are green, you are blocked, or you changed approach. Never send progress updates. If you spawn provider-internal subagents, report their milestones for them. One report per minute; headlines under 120 characters.`;

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
