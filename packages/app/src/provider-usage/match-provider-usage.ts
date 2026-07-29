import type { ProviderUsage } from "./types";

function normalizeUsageKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

const OMP_MODEL_RULES: ReadonlyArray<{ providerId: string; needles: readonly string[] }> = [
  {
    providerId: "omp-claude",
    needles: ["anthropic", "claude", "fable", "opus", "sonnet", "haiku"],
  },
  {
    providerId: "omp-antigravity",
    needles: ["antigravity", "gemini", "google"],
  },
  {
    providerId: "omp-cursor",
    needles: ["cursor"],
  },
  {
    providerId: "omp-codex",
    needles: ["codex", "openai", "gpt-"],
  },
  {
    providerId: "omp-grok-build",
    needles: ["grok-build"],
  },
  {
    providerId: "omp",
    needles: ["grok", "xai", "supergrok"],
  },
];

const OMP_VENDOR_TO_PROVIDER: Record<string, string> = {
  anthropic: "omp-claude",
  "google-antigravity": "omp-antigravity",
  google: "omp-antigravity",
  cursor: "omp-cursor",
  openai: "omp-codex",
  "openai-codex": "omp-codex",
  xai: "omp",
  "xai-oauth": "omp",
};

function findUsageById(candidates: ProviderUsage[], providerId: string): ProviderUsage | null {
  return candidates.find((usage) => normalizeUsageKey(usage.providerId) === providerId) ?? null;
}

function pickOmpUsageForModel(candidates: ProviderUsage[], modelKey: string): ProviderUsage | null {
  if (!modelKey) return null;

  for (const rule of OMP_MODEL_RULES) {
    if (!rule.needles.some((needle) => modelKey.includes(needle))) continue;
    const matched = findUsageById(candidates, rule.providerId);
    if (matched) return matched;
    // grok-build may only have the SuperGrok card available.
    if (rule.providerId === "omp-grok-build") {
      return findUsageById(candidates, "omp");
    }
  }

  const slash = modelKey.indexOf("/");
  if (slash > 0) {
    const vendor = modelKey.slice(0, slash);
    const mapped = OMP_VENDOR_TO_PROVIDER[vendor];
    if (mapped) return findUsageById(candidates, mapped);
  }

  return null;
}

/**
 * Resolve which usage card belongs to the active agent.
 *
 * OMP agents all have provider id `omp`, but the quota service expands one card per
 * authenticated OMP backend (`omp`, `omp-claude`, `omp-antigravity`, …). Prefer the
 * backend implied by the active model id, then fall back to the exact provider id.
 */
export function matchProviderUsage(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined,
  activeModelId?: string | null,
): ProviderUsage | null {
  if (providers.length === 0) return null;

  const providerKey = normalizeUsageKey(activeProviderId);
  const modelKey = normalizeUsageKey(activeModelId);

  const exact = providerKey
    ? (providers.find((usage) => normalizeUsageKey(usage.providerId) === providerKey) ?? null)
    : null;

  // Non-OMP providers keep the simple exact match.
  if (providerKey && providerKey !== "omp") {
    return exact;
  }

  // OMP: choose by model family first so Claude Fable shows Claude limits, not SuperGrok.
  if (providerKey === "omp" || modelKey.includes("/") || modelKey.length > 0) {
    const ompCandidates = providers.filter((usage) =>
      normalizeUsageKey(usage.providerId).startsWith("omp"),
    );
    if (ompCandidates.length > 0) {
      const byModel = pickOmpUsageForModel(ompCandidates, modelKey);
      if (byModel) return byModel;
      if (exact) return exact;
      return ompCandidates[0] ?? null;
    }
  }

  return exact;
}
