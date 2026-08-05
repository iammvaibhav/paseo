import { describe, expect, it } from "vitest";
import { matchProviderUsage } from "./match-provider-usage";
import type { ProviderUsage } from "./types";

function usage(
  partial: Partial<ProviderUsage> & Pick<ProviderUsage, "providerId" | "displayName">,
): ProviderUsage {
  return {
    status: "available",
    planLabel: null,
    windows: [{ id: "w", label: "W", usedPct: 10, remainingPct: 90 }],
    balances: [],
    details: [],
    error: null,
    ...partial,
  };
}

describe("matchProviderUsage", () => {
  const providers = [
    usage({ providerId: "omp", displayName: "OMP · SuperGrok" }),
    usage({ providerId: "omp-claude", displayName: "OMP · Claude" }),
    usage({ providerId: "omp-antigravity", displayName: "OMP · Antigravity" }),
    usage({ providerId: "claude", displayName: "Claude" }),
    usage({ providerId: "grok", displayName: "Grok" }),
  ];

  it("matches non-OMP providers exactly", () => {
    expect(matchProviderUsage(providers, "claude")?.providerId).toBe("claude");
  });

  it("matches native Grok Build CLI sessions", () => {
    expect(matchProviderUsage(providers, "grok", "grok-4.5")?.providerId).toBe("grok");
  });

  it("picks OMP Claude limits for Claude Fable models on OMP agents", () => {
    expect(matchProviderUsage(providers, "omp", "anthropic/claude-fable-5")?.providerId).toBe(
      "omp-claude",
    );
    expect(matchProviderUsage(providers, "omp", "Claude Fable 5")?.providerId).toBe("omp-claude");
  });

  it("picks SuperGrok limits for Grok models on OMP agents", () => {
    expect(matchProviderUsage(providers, "omp", "xai/grok-4.5")?.providerId).toBe("omp");
    expect(matchProviderUsage(providers, "omp", "Grok 4.5")?.providerId).toBe("omp");
  });

  it("picks Grok Build OMP card when present", () => {
    const withGrokBuild = [
      ...providers,
      usage({ providerId: "omp-grok-build", displayName: "OMP · Grok Build" }),
    ];
    expect(matchProviderUsage(withGrokBuild, "omp", "grok-build/grok-4.5")?.providerId).toBe(
      "omp-grok-build",
    );
  });

  it("falls back to native Grok usage when OMP SuperGrok card is missing", () => {
    const withoutOmpSuperGrok = providers.filter((entry) => entry.providerId !== "omp");
    expect(matchProviderUsage(withoutOmpSuperGrok, "omp", "grok-build/grok-4.5")?.providerId).toBe(
      "grok",
    );
    expect(matchProviderUsage(withoutOmpSuperGrok, "omp", "grok-4.5")?.providerId).toBe("grok");
    expect(matchProviderUsage(withoutOmpSuperGrok, "omp", "xai/grok-4.5")?.providerId).toBe("grok");
  });

  it("does not show Claude usage for Grok models when SuperGrok cards are missing", () => {
    const withoutGrokCards = providers.filter(
      (entry) => entry.providerId !== "omp" && entry.providerId !== "grok",
    );
    expect(matchProviderUsage(withoutGrokCards, "omp", "grok-build/grok-4.5")).toBeNull();
    expect(matchProviderUsage(withoutGrokCards, "omp", "Grok 4.5")).toBeNull();
  });

  it("picks Antigravity limits for Gemini/Antigravity models", () => {
    expect(
      matchProviderUsage(providers, "omp", "google-antigravity/gemini-3.6-flash")?.providerId,
    ).toBe("omp-antigravity");
  });
});
