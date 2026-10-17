import { beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage, resetSnapshot } from "./usage.js";

const usageJson = JSON.stringify({
  reports: [
    {
      provider: "openai-codex",
      metadata: { email: "team@example.com", planType: "team" },
      limits: [
        {
          id: "openai-codex:primary",
          label: "5 hours",
          scope: { provider: "openai-codex", windowId: "5h", shared: true },
          window: { id: "5h", label: "5 hours", resetsAt: Date.parse("2026-10-06T00:00:00Z") },
          amount: { used: 25, limit: 100, usedFraction: 0.25, unit: "percent" },
        },
      ],
    },
    {
      provider: "openai-codex",
      metadata: { email: "me@example.com", planType: "go" },
      limits: [
        {
          id: "openai-codex:primary",
          label: "30 days",
          window: { id: "30d", label: "30 days" },
          amount: { used: 1, limit: 100, unit: "percent" },
        },
      ],
    },
    {
      provider: "cursor",
      metadata: { email: "me@example.com" },
      limits: [
        {
          id: "cursor:usd:individual-api",
          label: "Other Models",
          window: { id: "monthly", label: "Monthly" },
          amount: { used: 5, limit: 20, remaining: 15, unit: "usd" },
        },
        {
          id: "cursor:usd:individual-auto",
          label: "Cursor Models",
          window: { id: "monthly", label: "Monthly" },
          amount: { used: 0.15, usedFraction: 0.0015, unit: "percent" },
        },
      ],
    },
    { provider: "opencode-go", metadata: { planType: "OpenCode Go" }, limits: [] },
  ],
});

describe("omp usage source", () => {
  beforeEach(() => resetSnapshot());

  it("reports one account per OMP login and shares one omp run across fetches", async () => {
    const runUsage = vi.fn(async () => usageJson);
    const now = () => 1_000;

    const accounts = await discover({ kind: "global" }, { runUsage, now });

    expect(accounts.map((account) => account.label)).toEqual([
      "Codex · team@example.com",
      "Codex · me@example.com",
      "Cursor · me@example.com",
      "OpenCode Go",
    ]);
    expect(new Set(accounts.map((account) => account.key)).size).toBe(4);
    await Promise.all(
      accounts.map((account) =>
        fetchUsage(account.input as { provider: string; identity: string }, { runUsage, now }),
      ),
    );
    expect(runUsage).toHaveBeenCalledTimes(1);
  });

  it("maps percent limits to windows and money limits to balances", async () => {
    const deps = { runUsage: async () => usageJson, now: () => 1_000 };

    await expect(
      fetchUsage({ provider: "openai-codex", identity: "TEAM@example.com" }, deps),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "team",
      windows: [
        {
          id: "openai-codex:primary",
          label: "5 hours",
          shortLabel: "5h",
          summary: true,
          usedPct: 25,
          resetsAt: "2026-10-06T00:00:00.000Z",
        },
      ],
    });
    const cursor = await fetchUsage({ provider: "cursor", identity: "me@example.com" }, deps);
    expect(cursor).toMatchObject({
      balances: [{ id: "cursor:usd:individual-api", used: 5, limit: 20, remaining: 15 }],
      windows: [{ label: "Cursor Models · Monthly", shortLabel: "mo" }],
    });
    expect(cursor.status === "available" && cursor.windows[0]?.usedPct).toBeCloseTo(0.15);
  });

  it("only reports the login that serves an OMP session's model", async () => {
    const deps = { runUsage: async () => usageJson, now: () => 1_000 };
    const session = { kind: "session" as const, env: {} };

    await expect(
      discover({ ...session, provider: "omp", model: "cursor/auto" }, deps),
    ).resolves.toHaveLength(1);
    await expect(
      discover({ ...session, provider: "codex", model: "cursor/auto" }, deps),
    ).resolves.toEqual([]);
  });

  it("reports no accounts without omp and fails a fetch for a vanished login", async () => {
    await expect(
      discover({ kind: "global" }, { runUsage: async () => Promise.reject(new Error("ENOENT")) }),
    ).resolves.toEqual([]);
    await expect(
      fetchUsage(
        { provider: "anthropic", identity: "gone@example.com" },
        { runUsage: async () => usageJson, now: () => 1_000 },
      ),
    ).rejects.toThrow("no longer reports");
  });
});
