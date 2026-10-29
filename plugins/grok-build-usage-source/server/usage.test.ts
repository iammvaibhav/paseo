import { describe, expect, it, vi } from "vitest";
import { discover, fetchUsage, type OmpRunner } from "./usage.js";

function ompWith(list: string, tokens: Record<string, string>): OmpRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.includes("--list")) return list;
    const account = args[args.indexOf("--account") + 1];
    return `${tokens[account ?? ""] ?? ""}\n`;
  };
  return Object.assign(run, { calls });
}

function billing(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("grok build usage source", () => {
  it("reports every OMP Grok Build login as its own account", async () => {
    const runOmp = ompWith("1. alice@example.com\n2. bob@example.com\n", {});

    const accounts = await discover({ kind: "global" }, { runOmp });

    expect(accounts.map((account) => account.label)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(new Set(accounts.map((account) => account.key)).size).toBe(2);
    // Case differences in the listed identity do not change the account.
    const [upper] = await discover(
      { kind: "global" },
      { runOmp: ompWith("1. ALICE@example.com\n", {}) },
    );
    expect(upper?.key).toBe(accounts[0]?.key);
  });

  it("reports nothing for sessions that do not run a Grok Build model", async () => {
    const runOmp = ompWith("1. alice@example.com\n", {});
    const session = { kind: "session" as const, env: {} };

    await expect(
      discover({ ...session, provider: "omp", model: "anthropic/claude-opus" }, { runOmp }),
    ).resolves.toEqual([]);
    await expect(
      discover({ ...session, provider: "codex", model: "grok-build/grok-4" }, { runOmp }),
    ).resolves.toEqual([]);
    await expect(
      discover({ ...session, provider: "omp", model: "grok-build/grok-4" }, { runOmp }),
    ).resolves.toHaveLength(1);
  });

  it("fetches with the token of the listed account even after the order changes", async () => {
    const runOmp = ompWith("1. bob@example.com\n2. alice@example.com\n", {
      "1": "bob-token",
      "2": "alice-token",
    });
    const fetchApi = billing({
      config: {
        creditUsagePercent: 42,
        isUnifiedBillingUser: true,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-10T00:00:00Z" },
      },
    });

    const report = await fetchUsage({ identity: "alice@example.com" }, { runOmp, fetchApi });

    expect(runOmp.calls).toContainEqual(["token", "grok-build", "--account", "2"]);
    expect(vi.mocked(fetchApi).mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer alice-token",
    });
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Grok Build",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 42,
          remainingPct: 58,
          resetsAt: "2026-10-10T00:00:00Z",
        },
      ],
    });
  });

  it("treats an omitted usage percent as nothing used yet", async () => {
    const runOmp = ompWith("1. alice@example.com\n", { "1": "token" });
    const report = await fetchUsage(
      { identity: "alice@example.com" },
      { runOmp, fetchApi: billing({ config: {} }) },
    );

    expect(report).toMatchObject({ status: "available", windows: [{ usedPct: 0 }] });
  });

  it("reports a rejected token as unavailable and a vanished login as an error", async () => {
    const runOmp = ompWith("1. alice@example.com\n", { "1": "token" });

    await expect(
      fetchUsage({ identity: "alice@example.com" }, { runOmp, fetchApi: billing({}, 401) }),
    ).resolves.toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "omp" },
    });
    await expect(
      fetchUsage({ identity: "carol@example.com" }, { runOmp, fetchApi: billing({}) }),
    ).rejects.toThrow("no longer listed");
  });
});
