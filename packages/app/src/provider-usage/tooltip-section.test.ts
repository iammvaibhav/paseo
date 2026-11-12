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

function providerIds(providers: ProviderUsage[]): string[] {
  return providers.map((provider) => provider.providerId);
}

describe("matchProviderUsage", () => {
  const providers = [
    usage({ providerId: "omp-grok-build", displayName: "OMP · Grok Build" }),
    usage({ providerId: "omp-claude", displayName: "OMP · Claude" }),
    usage({ providerId: "omp-antigravity", displayName: "OMP · Antigravity" }),
    usage({
      providerId: "omp-opencode-zen",
      groupId: "omp-opencode-zen",
      displayName: "OMP · OpenCode Zen",
    }),
    usage({
      providerId: "omp-opencode-go",
      groupId: "omp-opencode-go",
      displayName: "OMP · OpenCode Go",
    }),
    usage({ providerId: "claude", displayName: "Claude" }),
    usage({ providerId: "grok", displayName: "Grok" }),
  ];

  it("matches non-OMP providers exactly", () => {
    expect(providerIds(matchProviderUsage(providers, "claude"))).toEqual(["claude"]);
  });

  it("matches native Grok Build CLI sessions", () => {
    expect(providerIds(matchProviderUsage(providers, "grok", "grok-4.5"))).toEqual(["grok"]);
  });

  it("picks OMP Claude limits for Claude Fable models on OMP agents", () => {
    expect(providerIds(matchProviderUsage(providers, "omp", "anthropic/claude-fable-5"))).toEqual([
      "omp-claude",
    ]);
    expect(providerIds(matchProviderUsage(providers, "omp", "Claude Fable 5"))).toEqual([
      "omp-claude",
    ]);
  });

  it("picks Grok Build limits for Grok models on OMP agents", () => {
    expect(providerIds(matchProviderUsage(providers, "omp", "xai/grok-4.5"))).toEqual([
      "omp-grok-build",
    ]);
    expect(providerIds(matchProviderUsage(providers, "omp", "Grok 4.5"))).toEqual([
      "omp-grok-build",
    ]);
  });

  it("returns every account in the matched provider group", () => {
    const withAccounts = [
      // No bare single-account card: multi-account daemons suffix every id.
      ...providers.filter((entry) => entry.providerId !== "omp-grok-build"),
      usage({
        providerId: "omp-grok-build:second",
        groupId: "omp-grok-build",
        accountEmail: "second@example.com",
        displayName: "OMP · Grok Build",
      }),
      usage({
        providerId: "omp-grok-build:first",
        groupId: "omp-grok-build",
        accountEmail: "first@example.com",
        displayName: "OMP · Grok Build",
      }),
    ];
    expect(
      matchProviderUsage(withAccounts, "omp", "grok-build/grok-4.5").map(
        (provider) => provider.accountEmail,
      ),
    ).toEqual(["second@example.com", "first@example.com"]);
  });

  it("falls back to provider id prefixes for old daemons", () => {
    const legacyAccounts = [
      usage({ providerId: "grok-build:first", displayName: "Grok Build" }),
      usage({ providerId: "grok-build:second", displayName: "Grok Build" }),
    ];
    expect(providerIds(matchProviderUsage(legacyAccounts, "grok-build"))).toEqual([
      "grok-build:first",
      "grok-build:second",
    ]);
  });

  it("falls back to native Grok usage when OMP Grok Build cards are missing", () => {
    const withoutOmpGrokBuild = providers.filter((entry) => entry.providerId !== "omp-grok-build");
    expect(providerIds(matchProviderUsage(withoutOmpGrokBuild, "omp", "grok-4.5"))).toEqual([
      "grok",
    ]);
  });

  it("does not show another family when Grok cards are missing", () => {
    const withoutGrokCards = providers.filter(
      (entry) => entry.providerId !== "omp-grok-build" && entry.providerId !== "grok",
    );
    expect(matchProviderUsage(withoutGrokCards, "omp", "Grok 4.5")).toEqual([]);
  });

  it("picks Antigravity limits for Gemini models", () => {
    expect(
      providerIds(matchProviderUsage(providers, "omp", "google-antigravity/gemini-3.6-flash")),
    ).toEqual(["omp-antigravity"]);
  });

  it("picks OpenCode Zen limits for opencode-zen models on native opencode agents", () => {
    expect(
      providerIds(matchProviderUsage(providers, "opencode", "opencode-zen/kimi-k2.5")),
    ).toEqual(["omp-opencode-zen"]);
  });

  it("picks OpenCode Go limits for opencode-go models on OMP agents", () => {
    expect(
      providerIds(matchProviderUsage(providers, "omp", "opencode-go/deepseek-v4-flash")),
    ).toEqual(["omp-opencode-go"]);
  });

  it("defaults bare opencode models to OpenCode Zen", () => {
    expect(providerIds(matchProviderUsage(providers, "opencode", "opencode/big-pickle"))).toEqual([
      "omp-opencode-zen",
    ]);
  });
});
