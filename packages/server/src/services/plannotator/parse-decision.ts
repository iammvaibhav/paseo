const DECISIONS = new Set(["approved", "annotated", "dismissed", "block"] as const);
type Decision = "approved" | "annotated" | "dismissed" | "block";

export interface PlannotatorParsedDecision {
  decision: Decision;
  feedback: string;
  raw: unknown;
}

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && (DECISIONS as Set<string>).has(value);
}

/**
 * Parse stdout from `plannotator annotate --json`.
 * Known shapes (v0.22):
 *   {"decision":"approved"}
 *   {"decision":"annotated","feedback":"..."}
 *   {"decision":"block","reason":"..."}
 *   {"decision":"dismissed",...}
 */
export function parsePlannotatorStdout(stdout: string): PlannotatorParsedDecision | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // Process may print non-JSON lines before the decision; take the last JSON object line.
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.startsWith("{")) {
      continue;
    }
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      if (!isDecision(record.decision)) {
        continue;
      }
      const feedbackParts: string[] = [];
      if (typeof record.feedback === "string" && record.feedback.trim()) {
        feedbackParts.push(record.feedback.trim());
      }
      if (typeof record.reason === "string" && record.reason.trim()) {
        feedbackParts.push(record.reason.trim());
      }
      if (typeof record.message === "string" && record.message.trim()) {
        feedbackParts.push(record.message.trim());
      }
      return {
        decision: record.decision,
        feedback: feedbackParts.join("\n\n"),
        raw,
      };
    } catch {
      // try previous line
    }
  }

  return null;
}

function decisionHeader(path: string, decision: Decision): string {
  if (decision === "approved") {
    return `Plannotator review of \`${path}\`: **approved** (no changes requested).`;
  }
  if (decision === "dismissed") {
    return `Plannotator review of \`${path}\` was dismissed without feedback.`;
  }
  return `Plannotator review of \`${path}\`: **${decision}**.`;
}

/** Format a parsed decision into a prompt the agent can act on. */
export function formatPlannotatorFeedbackPrompt(input: {
  path: string;
  decision: PlannotatorParsedDecision["decision"];
  feedback: string;
}): string {
  const header = decisionHeader(input.path, input.decision);
  if (!input.feedback.trim()) {
    return header;
  }
  return `${header}\n\n${input.feedback.trim()}\n\nPlease address the feedback above.`;
}
