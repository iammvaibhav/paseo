import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";

const execFileAsync = promisify(execFile);

export const AI_REVIEW_MODE_ID = "ai-review";
export const AI_REVIEW_MODE = {
  id: AI_REVIEW_MODE_ID,
  label: "AI review",
  description: "Routes eligible permission requests through the host AI reviewer.",
  icon: "ShieldCheck",
  colorTier: "moderate",
} as const;

export const AI_REVIEW_TIMEOUT_MS = 8_000;

/** Actions that always require a human decision, regardless of model output. */
export const AI_REVIEW_DENYLIST: readonly RegExp[] = [
  /\brm\s+[^\n]*(?:-[^\n]*(?:r[^\n]*f|f[^\n]*r)|--recursive\b[^\n]*--force\b|--force\b[^\n]*--recursive\b)/i,
  /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(?:dd|mkfs(?:\.[a-z0-9]+)?)(?:\s|$|[./])/i,
  /(?:^|[\s/])(?:\.env\b|credentials?|secrets?|id_rsa|\.ssh)(?:[\s./'"]|$)/i,
  /(?:curl|wget|nc|ncat|socat)\b[^\n]*(?:https?|ftp):/i,
];

export const AiReviewDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "escalate"]),
  reason: z.string().trim().min(1).max(4000),
});
export type AiReviewDecision = z.infer<typeof AiReviewDecisionSchema>;

export function parseAiReviewDecision(raw: unknown): AiReviewDecision {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const jsonMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = jsonMatch ? jsonMatch[1].trim() : trimmed;
    value = JSON.parse(candidate);
  }
  return AiReviewDecisionSchema.parse(value);
}

export interface AiReviewerConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  policy?: string;
}

export interface AiReviewContext {
  goal: string;
  recentTurnSummary: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  gitDiffStat: string;
}

export interface AiReviewer {
  review(input: AiReviewContext, config: AiReviewerConfig): Promise<AiReviewDecision>;
}

export function permissionToolInput(request: AgentPermissionRequest): unknown {
  if (request.detail) return request.detail;
  if (request.input) return request.input;
  return request.metadata ?? null;
}

export function isAlwaysEscalate(input: AiReviewContext): boolean {
  const candidate = `${input.toolName}\n${JSON.stringify(input.toolInput)}`;
  return AI_REVIEW_DENYLIST.some((pattern) => pattern.test(candidate));
}

export function buildAiReviewerPrompt(input: AiReviewContext, policy: string): string {
  // All agent/provider content is data in explicit delimiters. It must never be
  // interpreted as reviewer instructions.
  return [
    "You are a permission reviewer. Return JSON only, matching this schema:",
    '{"decision":"allow|deny|escalate","reason":"short explanation"}',
    "Follow the policy below. Escalate uncertain or risky actions.",
    "\n<POLICY_DATA>",
    policy || "No additional policy configured.",
    "</POLICY_DATA>",
    "\n<AGENT_GOAL_DATA>",
    input.goal,
    "</AGENT_GOAL_DATA>",
    "\n<RECENT_TURN_SUMMARY_DATA>",
    input.recentTurnSummary,
    "</RECENT_TURN_SUMMARY_DATA>",
    "\n<TOOL_NAME_DATA>",
    input.toolName,
    "</TOOL_NAME_DATA>",
    "\n<TOOL_INPUT_DATA>",
    JSON.stringify(input.toolInput),
    "</TOOL_INPUT_DATA>",
    "\n<CWD_DATA>",
    input.cwd,
    "</CWD_DATA>",
    "\n<GIT_DIFF_STAT_DATA>",
    input.gitDiffStat,
    "</GIT_DIFF_STAT_DATA>",
  ].join("\n");
}

export async function readGitDiffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--stat"], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || "(clean or unavailable)";
  } catch {
    return "(unavailable)";
  }
}

export function withAiReviewTimeout<T>(
  promise: Promise<T>,
  timeoutMs = AI_REVIEW_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("AI reviewer timed out")), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export interface DefaultAiReviewerOptions {
  callModel?: (input: { prompt: string; provider?: string; model?: string }) => Promise<string>;
}

export function createDefaultAiReviewer(options?: DefaultAiReviewerOptions): AiReviewer {
  return {
    async review(input: AiReviewContext, config: AiReviewerConfig): Promise<AiReviewDecision> {
      const prompt = buildAiReviewerPrompt(input, config.policy ?? "");
      if (options?.callModel) {
        const raw = await options.callModel({
          prompt,
          provider: config.provider,
          model: config.model,
        });
        return parseAiReviewDecision(raw);
      }
      return {
        decision: "escalate",
        reason: "No AI reviewer model caller configured; escalating to user.",
      };
    },
  };
}
