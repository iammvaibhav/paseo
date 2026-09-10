export function composeSystemPromptParts(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const prompt = parts
    .map((part) => part?.trim())
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");

  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Agent-launch env is "significant" when it carries anything beyond the
 * identity bookkeeping the daemon injects for every create
 * (`PASEO_AGENT_ID`/`PASEO_AGENT_CWD`). Those two are plumbing, not behavior:
 * a warm pool process that launched without a per-create env can serve any
 * create whose only env difference is the identity pair. Anything else in the
 * env is a behavioral dimension and must cold-start (env is launch-only in
 * omp — it cannot be re-targeted after spawn).
 */
export function hasSignificantLaunchEnv(env: Record<string, string> | undefined): boolean {
  if (!env) {
    return false;
  }
  return Object.keys(env).some((key) => key !== "PASEO_AGENT_ID" && key !== "PASEO_AGENT_CWD");
}
