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
  isRefreshing = false,
): HostProviderUsageReport {
  return {
    serverId,
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
      readyReport("host-a", "2026-08-18T08:00:00.000Z", [older]),
      readyReport("host-b", "2026-08-18T07:45:00.000Z", [fresher]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.displayName).toBe("fresh");
  });

  it("keeps refreshing cache and responsive-host data when another host fails", () => {
    const accountOneOld = usage({
      providerId: "grok:one-old",
      groupId: "grok",
      accountEmail: "one@example.com",
      displayName: "old",
    });
    const accountOneFresh = {
      ...accountOneOld,
      providerId: "grok:one-fresh",
      displayName: "fresh",
    };
    const accountTwo = usage({
      providerId: "grok:two",
      groupId: "grok",
      accountEmail: "two@example.com",
      displayName: "second account",
    });

    const merged = mergeProviderUsageReports([
      readyReport("host-a", "2026-08-18T07:00:00.000Z", [accountOneOld, accountTwo]),
      readyReport("host-b", "2026-08-18T08:00:00.000Z", [accountOneFresh], true),
      { serverId: "host-c", view: { kind: "error", message: "offline" } },
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
