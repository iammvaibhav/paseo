import { describe, expect, it } from "vitest";
import {
  cleanProviderUsageDisplayName,
  groupProviderUsage,
  mergeProviderUsageReports,
  type HostProviderUsageReport,
} from "./sidebar-menu-data";
import type { ProviderUsage } from "./types";

function usage(
  partial: Partial<ProviderUsage> & Pick<ProviderUsage, "providerId" | "displayName">,
): ProviderUsage {
  return {
    status: "available",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
    ...partial,
  };
}

function readyReport(
  serverId: string,
  fetchedAt: string,
  providers: ProviderUsage[],
  enabledProviderIds: readonly string[] | null,
  isRefreshing = false,
): HostProviderUsageReport {
  return {
    serverId,
    enabledProviderIds,
    view: {
      kind: "ready",
      payload: { fetchedAt, providers },
      isRefreshing,
    },
  };
}

describe("mergeProviderUsageReports", () => {
  it("deduplicates an account across hosts and keeps its freshest provider payload", () => {
    const older = usage({
      providerId: "omp-grok:one@example.com",
      groupId: "omp-grok",
      accountEmail: "one@example.com",
      displayName: "old",
      fetchedAt: "2026-08-18T07:00:00.000Z",
    });
    const fresher = usage({
      providerId: "another-host-id",
      groupId: "omp-grok",
      accountEmail: "one@example.com",
      displayName: "fresh",
      fetchedAt: "2026-08-18T07:30:00.000Z",
    });

    const merged = mergeProviderUsageReports([
      readyReport("host-a", "2026-08-18T08:00:00.000Z", [older], ["omp"]),
      readyReport("host-b", "2026-08-18T07:45:00.000Z", [fresher], ["omp"]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.displayName).toBe("fresh");
  });

  it("normalizes an old-daemon OMP card and deduplicates it against native metadata", () => {
    const oldDaemon = usage({
      providerId: "omp-codex:a@b",
      displayName: "OMP · Codex — a@b",
      fetchedAt: "2026-08-18T09:00:00.000Z",
    });
    const native = usage({
      providerId: "omp-codex",
      groupId: "omp-codex",
      accountEmail: "a@b",
      displayName: "OMP · Codex — a@b",
      fetchedAt: "2026-08-18T08:00:00.000Z",
      planLabel: "native",
    });

    const merged = mergeProviderUsageReports([
      readyReport("old-host", "2026-08-18T09:00:00.000Z", [oldDaemon], ["omp"]),
      readyReport("new-host", "2026-08-18T08:00:00.000Z", [native], ["omp"]),
    ]);

    expect(merged).toEqual([
      expect.objectContaining({
        providerId: "omp-codex",
        groupId: "omp-codex",
        accountEmail: "a@b",
        displayName: "Codex",
        planLabel: "native",
      }),
    ]);
  });

  it("filters native cards by the provider enabled on their host", () => {
    const claude = usage({ providerId: "claude", displayName: "Claude" });
    const codex = usage({ providerId: "codex", displayName: "Codex" });

    const merged = mergeProviderUsageReports([
      readyReport("host-a", "2026-08-18T08:00:00.000Z", [claude, codex], ["codex"]),
    ]);

    expect(merged.map((entry) => entry.providerId)).toEqual(["codex"]);
  });

  it("holds back every card from a host until its provider snapshot is loaded", () => {
    const heldOmp = usage({
      providerId: "omp-codex:a@b",
      displayName: "Codex — a@b",
    });
    const visibleOmp = usage({
      providerId: "omp-grok:c@d",
      displayName: "Grok — c@d",
    });

    const merged = mergeProviderUsageReports([
      readyReport("host-a", "2026-08-18T08:00:00.000Z", [heldOmp], null),
      readyReport("host-b", "2026-08-18T08:00:00.000Z", [visibleOmp], ["omp"]),
    ]);

    expect(merged.map((entry) => entry.providerId)).toEqual(["omp-grok:c@d"]);
  });

  it("keeps refreshing cache and responsive-host data when another host fails", () => {
    const accountOneOld = usage({
      providerId: "grok",
      groupId: "grok",
      accountEmail: "one@example.com",
      displayName: "old",
    });
    const accountOneFresh = {
      ...accountOneOld,
      displayName: "fresh",
    };
    const accountTwo = usage({
      providerId: "grok",
      groupId: "grok",
      accountEmail: "two@example.com",
      displayName: "second account",
    });

    const merged = mergeProviderUsageReports([
      readyReport("host-a", "2026-08-18T07:00:00.000Z", [accountOneOld, accountTwo], ["grok"]),
      readyReport("host-b", "2026-08-18T08:00:00.000Z", [accountOneFresh], ["grok"], true),
      {
        serverId: "host-c",
        enabledProviderIds: [],
        view: { kind: "error", message: "offline" },
      },
    ]);

    expect(merged.map((entry) => entry.displayName)).toEqual(["fresh", "second account"]);
    expect(merged[0]?.fetchedAt).toBe("2026-08-18T08:00:00.000Z");
  });
});

describe("provider usage groups", () => {
  it("cleans defensive OMP and email decoration and sorts chips by label", () => {
    const grok = usage({
      providerId: "omp-grok:one@example.com",
      groupId: "omp-grok",
      accountEmail: "one@example.com",
      displayName: "OMP · Grok Build — one@example.com",
    });
    const claude = usage({ providerId: "claude", displayName: "Claude" });

    expect(cleanProviderUsageDisplayName(grok)).toBe("Grok Build");
    expect(groupProviderUsage([grok, claude]).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "claude", label: "Claude" },
      { id: "omp-grok", label: "Grok Build" },
    ]);
  });
});
