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
  "grok-build": "omp-grok-build",
};

function findUsageById(candidates: ProviderUsage[], providerId: string): ProviderUsage | null {
  return candidates.find((usage) => normalizeUsageKey(usage.providerId) === providerId) ?? null;
}

function isGrokFamilyModel(modelKey: string): boolean {
  if (!modelKey) return false;
  return (
    modelKey.includes("grok-build") ||
    modelKey.includes("supergrok") ||
    modelKey.includes("xai") ||
    // Bare "grok" / "grok-4.5" / "Grok 4.5", but not unrelated models that happen
    // to contain those letters elsewhere.
    /(^|\/|[\s_-])grok([\s._-]|$)/.test(modelKey)
  );
}

/**
 * SuperGrok / Grok Build share the same xAI weekly credits. Prefer the OMP-expanded
 * cards when present, then the standalone Grok CLI (`~/.grok/auth.json`) card.
 */
function pickGrokFamilyUsage(
  candidates: ProviderUsage[],
  allProviders: ProviderUsage[],
): ProviderUsage | null {
  return (
    findUsageById(candidates, "omp-grok-build") ??
    findUsageById(candidates, "omp") ??
    findUsageById(allProviders, "grok")
  );
}

function pickOmpUsageForModel(
  candidates: ProviderUsage[],
  allProviders: ProviderUsage[],
  modelKey: string,
): ProviderUsage | null {
  if (!modelKey) return null;

  for (const rule of OMP_MODEL_RULES) {
    if (!rule.needles.some((needle) => modelKey.includes(needle))) continue;
    const matched = findUsageById(candidates, rule.providerId);
    if (matched) return matched;

    // Identified a Grok family model but the OMP SuperGrok/Grok Build cards are
    // missing (common when `omp usage` has no xai-oauth report). Fall back to
    // the native Grok CLI usage card instead of leaking into Claude/etc.
    if (rule.providerId === "omp-grok-build" || rule.providerId === "omp") {
      return pickGrokFamilyUsage(candidates, allProviders);
    }

    // Family was identified (Claude, Cursor, …) but that card is absent. Stop so
    // we do not return a different family's first card.
    return null;
  }

  const slash = modelKey.indexOf("/");
  if (slash > 0) {
    const vendor = modelKey.slice(0, slash);
    const mapped = OMP_VENDOR_TO_PROVIDER[vendor];
    if (mapped) {
      const matched = findUsageById(candidates, mapped);
      if (matched) return matched;
      if (mapped === "omp" || mapped === "omp-grok-build") {
        return pickGrokFamilyUsage(candidates, allProviders);
      }
      return null;
    }
  }

  if (isGrokFamilyModel(modelKey)) {
    return pickGrokFamilyUsage(candidates, allProviders);
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
    // Native Grok Build CLI sessions are provider id `grok`.
    if (providerKey === "grok") {
      return exact ?? pickGrokFamilyUsage(providers, providers);
    }
    return exact;
  }

  // OMP: choose by model family first so Claude Fable shows Claude limits, not SuperGrok.
  if (providerKey === "omp" || modelKey.includes("/") || modelKey.length > 0) {
    const ompCandidates = providers.filter((usage) =>
      normalizeUsageKey(usage.providerId).startsWith("omp"),
    );
    if (ompCandidates.length > 0 || isGrokFamilyModel(modelKey)) {
      const byModel = pickOmpUsageForModel(ompCandidates, providers, modelKey);
      if (byModel) return byModel;
      // Model identified a family with no usable card — do not invent another provider.
      if (modelKey) return exact;
      if (exact) return exact;
      return ompCandidates[0] ?? null;
    }
  }

  return exact;
}
