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
  ];

  it("matches non-OMP providers exactly", () => {
    expect(matchProviderUsage(providers, "claude")?.providerId).toBe("claude");
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

  it("picks Antigravity limits for Gemini/Antigravity models", () => {
    expect(
      matchProviderUsage(providers, "omp", "google-antigravity/gemini-3.6-flash")?.providerId,
    ).toBe("omp-antigravity");
  });
});
