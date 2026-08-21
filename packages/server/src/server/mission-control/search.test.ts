import { describe, expect, test, vi } from "vitest";

import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem, AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  SEARCH_TIER1_THIN_THRESHOLD,
  SEARCH_TIER2_MAX_AGENTS_PER_HOST,
  SEARCH_TIER2_MAX_ITEMS_PER_AGENT,
  SEARCH_TIER2_MAX_ITEMS_PER_HOST,
  SEARCH_TIER2_WINDOW_DAYS,
  buildFleetHistoryAskBrief,
  extractSearchSnippet,
  matchesSearchQuery,
  mergeFleetSearchMatches,
  parseHistoryAskMatches,
  runFleetSearchHost,
  searchTier1,
  searchTier2,
  type FleetSearchHostDeps,
  type FleetSearchMatch,
} from "./search.js";

function record(overrides: Partial<StoredAgentRecord> & { id: string }): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: "omp",
    cwd: "/repo/app",
    labels: {},
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    lastStatus: "closed",
    ...overrides,
  } as StoredAgentRecord;
}

function selfReportEvent(agentId: string, headline: string): MissionControlEvent {
  return {
    id: `mce_${agentId}_1`,
    ts: "2026-08-01T00:00:00Z",
    seq: 1,
    agentId,
    agentTitle: "Worker",
    kind: "milestone",
    source: "self",
    severity: "info",
    headline,
  };
}

/** Fake timeline store mirroring the manager's in-memory timeline semantics. */
class FakeTimelineStore {
  private readonly rowsByAgent = new Map<string, AgentTimelineRow[]>();

  set(agentId: string, rows: AgentTimelineRow[]): void {
    this.rowsByAgent.set(agentId, rows);
  }

  has(agentId: string): boolean {
    return this.rowsByAgent.has(agentId);
  }

  items(agentId: string): AgentTimelineItem[] {
    return (this.rowsByAgent.get(agentId) ?? []).map((row) => row.item);
  }

  fetch(agentId: string): AgentTimelineRow[] {
    // Newest first, mirroring fetchTimeline({ direction: "tail" }).
    return [...(this.rowsByAgent.get(agentId) ?? [])].sort((a, b) => b.seq - a.seq);
  }
}

interface TestDepsOptions {
  records?: StoredAgentRecord[];
  events?: MissionControlEvent[];
  workspaces?: PersistedWorkspaceRecord[];
  projects?: PersistedProjectRecord[];
  timeline?: FakeTimelineStore;
  tier3?: FleetSearchHostDeps["tier3"];
}

function buildDeps(options: TestDepsOptions = {}): {
  deps: FleetSearchHostDeps;
  timeline: FakeTimelineStore;
} {
  const timeline = options.timeline ?? new FakeTimelineStore();
  const records = options.records ?? [
    record({ id: "agent-1", name: "Rusty", title: "Fix auth", shortDescription: "auth worker" }),
  ];
  const agentManager = {
    getAgent: vi.fn(() => null),
    getTimeline: (agentId: string) => timeline.items(agentId),
    fetchTimeline: (agentId: string) => ({
      epoch: "e1",
      direction: "tail",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
      hasOlder: false,
      hasNewer: false,
      rows: timeline.fetch(agentId),
    }),
    hasTimeline: (agentId: string) => timeline.has(agentId),
    seedTimelineForRehydrate: vi.fn(async () => false),
    seedTimelineFromItems: vi.fn(() => true),
  } as unknown as Pick<
    AgentManager,
    | "getAgent"
    | "getTimeline"
    | "fetchTimeline"
    | "hasTimeline"
    | "seedTimelineForRehydrate"
    | "seedTimelineFromItems"
  >;

  const deps: FleetSearchHostDeps = {
    agentManager,
    agentStorage: {
      list: async () => records,
    },
    missionControlService: {
      fetchEvents: () => options.events ?? [],
    },
    workspaceRegistry: {
      list: async () => options.workspaces ?? [],
    },
    projectRegistry: {
      list: async () => options.projects ?? [],
    },
    logger: createTestLogger(),
    serverId: "server-local",
    tier3: options.tier3 ?? null,
  };
  return { deps, timeline };
}

function userMessageRow(seq: number, text: string, timestamp: string): AgentTimelineRow {
  return { seq, timestamp, item: { type: "user_message", text } };
}

function assistantMessageRow(seq: number, text: string, timestamp: string): AgentTimelineRow {
  return { seq, timestamp, item: { type: "assistant_message", text } };
}

describe("matchesSearchQuery (substring + fuzzy)", () => {
  test("multi-token substring: every token must appear", () => {
    expect(matchesSearchQuery("auth worker", "Fix auth worker service")).toBe(true);
    expect(matchesSearchQuery("auth worker", "Fix auth")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(matchesSearchQuery("AUTH", "the auth service")).toBe(true);
  });

  test("fuzzy: edit-distance-1 token still matches", () => {
    expect(matchesSearchQuery("descritption", "living short description")).toBe(true);
    expect(matchesSearchQuery("gataway", "the gateway service")).toBe(true);
  });

  test("short tokens require a substring, not fuzz", () => {
    expect(matchesSearchQuery("abc", "abd")).toBe(false);
  });
});

describe("extractSearchSnippet", () => {
  test("returns the matched line trimmed", () => {
    const snippet = extractSearchSnippet(
      "first line\n  the matched auth line here  \nlast line",
      "auth",
    );
    expect(snippet).toBe("the matched auth line here");
  });

  test("caps long lines", () => {
    const snippet = extractSearchSnippet("x".repeat(500), "x");
    expect(snippet.length).toBeLessThanOrEqual(180);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("tier 1 — deterministic context", () => {
  test("matches agent identity (name/title/description)", async () => {
    const { deps } = buildDeps({
      records: [
        record({ id: "a1", name: "Rusty", title: "Fix auth", shortDescription: "auth worker" }),
        record({ id: "a2", name: "Mira", title: "Ship charts" }),
      ],
    });
    const matches = await searchTier1("auth", deps);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      host: "local",
      agentId: "a1",
      name: "Rusty",
      title: "Fix auth",
      matchedIn: "identity",
    });
    expect(matches[0]!.snippet).toContain("auth");
  });

  test("matches workspace/project names and project description", async () => {
    const { deps } = buildDeps({
      records: [
        record({ id: "a1", cwd: "/repo/alpha/app", workspaceId: "ws-1" }),
        record({ id: "a2", cwd: "/repo/beta" }),
      ],
      workspaces: [
        {
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: "/repo/alpha/app",
          kind: "worktree",
          displayName: "alpha-app",
          title: "Alpha App",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
        },
      ],
      projects: [
        {
          projectId: "proj-1",
          rootPath: "/repo/alpha",
          kind: "git",
          displayName: "alpha",
          customName: "Alpha",
          description: "the alpha service handles billing",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
        },
      ],
    });
    const byName = await searchTier1("Alpha App", deps);
    expect(byName.map((match) => match.agentId)).toEqual(["a1"]);
    const byDescription = await searchTier1("billing", deps);
    expect(byDescription.map((match) => match.agentId)).toEqual(["a1"]);
    // a2 has no workspace: never matches workspace/project text.
    expect(byDescription[0]!.snippet).toContain("billing");
  });

  test("matches report_status history (headline + detail + proof url)", async () => {
    const { deps } = buildDeps({
      records: [record({ id: "a1" }), record({ id: "a2" })],
      events: [
        {
          ...selfReportEvent("a1", "Deployed the webhook relay"),
          detail: "shipped pr #421 to prod",
          proof: [{ kind: "pr", url: "https://github.com/acme/paseo/pull/421" }],
        },
        selfReportEvent("a2", "Charts work"),
      ],
    });
    const matches = await searchTier1("relay", deps);
    expect(matches.map((match) => match.agentId)).toEqual(["a1"]);
    expect(matches[0]!.matchedIn).toBe("reports");
    const byPrUrl = await searchTier1("pull/421", deps);
    expect(byPrUrl.map((match) => match.agentId)).toEqual(["a1"]);
    expect(byPrUrl[0]!.snippet).toContain("pull/421");
  });

  test("matches the launch brief of an agent with a loaded timeline", async () => {
    const timeline = new FakeTimelineStore();
    timeline.set("a1", [
      userMessageRow(0, "Implement retries with backoff for the gateway", "2026-08-01T00:00:00Z"),
    ]);
    const { deps } = buildDeps({
      records: [record({ id: "a1" }), record({ id: "a2" })],
      timeline,
    });
    const matches = await searchTier1("backoff", deps);
    expect(matches.map((match) => match.agentId)).toEqual(["a1"]);
    expect(matches[0]!.matchedIn).toBe("brief");
  });

  test("identity beats brief beats reports when several fields match", async () => {
    const timeline = new FakeTimelineStore();
    timeline.set("a1", [
      userMessageRow(0, "Implement retries with backoff", "2026-08-01T00:00:00Z"),
    ]);
    const { deps } = buildDeps({
      records: [record({ id: "a1", name: "Backoff Bot", title: "Retry work" })],
      events: [selfReportEvent("a1", "backoff shipped")],
      timeline,
    });
    const matches = await searchTier1("backoff", deps);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedIn).toBe("identity");
    expect(matches[0]!.snippet).toContain("Backoff Bot");
  });

  test("excludes internal, mission-control, and history-ask agents", async () => {
    const { deps } = buildDeps({
      records: [
        record({ id: "worker", name: "Worker One", title: "Real work" }),
        record({ id: "internal", internal: true, name: "Sneaky", title: "hidden" }),
        record({
          id: "commander",
          labels: { "paseo.mission-control": "commander" },
          title: "Commander",
        }),
        record({ id: "ask", labels: { "paseo.history-ask": "1" }, title: "Ask agent" }),
      ],
    });
    expect((await searchTier1("hidden", deps)).map((match) => match.agentId)).toEqual([]);
    expect((await searchTier1("Commander", deps)).map((match) => match.agentId)).toEqual([]);
    expect((await searchTier1("Ask agent", deps)).map((match) => match.agentId)).toEqual([]);
    expect((await searchTier1("Worker One", deps)).map((match) => match.agentId)).toEqual([
      "worker",
    ]);
  });
});

describe("tier 2 — bounded transcript scan", () => {
  const cutoff = SEARCH_TIER2_WINDOW_DAYS;
  const fresh = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - (cutoff + 1) * 24 * 60 * 60 * 1000).toISOString();

  test("finds a PR URL that exists only inside a stored prompt body", async () => {
    const timeline = new FakeTimelineStore();
    timeline.set("a1", [
      userMessageRow(0, "Wire up the webhook receiver", fresh),
      userMessageRow(
        1,
        "Then check https://github.com/acme/paseo/pull/4825 for the regression",
        fresh,
      ),
      assistantMessageRow(2, "Done: backoff retries landed", fresh),
    ]);
    const { deps } = buildDeps({
      records: [
        record({ id: "a1", name: "Rusty", title: "Fix auth" }),
        record({ id: "a2", name: "Mira", title: "Ship charts" }),
      ],
      timeline,
    });
    // Tier 1 must not see the URL (identity/brief/reports are clean).
    const tier1 = await searchTier1("pull/4825", deps);
    expect(tier1).toHaveLength(0);

    const matches = await runFleetSearchHost({
      query: "pull/4825",
      deps,
    });
    expect(matches.map((match) => match.agentId)).toEqual(["a1"]);
    expect(matches[0]!).toMatchObject({ matchedIn: "transcript", host: "local" });
    expect(matches[0]!.snippet).toContain("pull/4825");
  });

  test("scans newest-first and stops at the per-agent item cap", async () => {
    const timeline = new FakeTimelineStore();
    // The match is the OLDEST row, so newest-first scanning hits it only after
    // the per-agent item cap has already stopped the scan.
    const rows: AgentTimelineRow[] = [userMessageRow(0, "needle-only-in-transcript", fresh)];
    for (let seq = 1; seq <= SEARCH_TIER2_MAX_ITEMS_PER_AGENT + 50; seq++) {
      rows.push(userMessageRow(seq, `unrelated filler ${seq}`, fresh));
    }
    timeline.set("a1", rows);
    const { deps } = buildDeps({ records: [record({ id: "a1" })], timeline });

    const tier2 = await searchTier2("needle-only-in-transcript", deps);
    expect(tier2.matches).toHaveLength(0);
    // Exactly the per-agent cap was inspected, then the scan stopped.
    expect(tier2.scannedItems).toBe(SEARCH_TIER2_MAX_ITEMS_PER_AGENT);
  });

  test("stops at the per-host item cap", async () => {
    const timeline = new FakeTimelineStore();
    const agents = [];
    const perAgent =
      Math.ceil(SEARCH_TIER2_MAX_ITEMS_PER_HOST / SEARCH_TIER2_MAX_AGENTS_PER_HOST) + 10;
    for (let index = 0; index < SEARCH_TIER2_MAX_AGENTS_PER_HOST; index++) {
      const agentId = `a${index}`;
      agents.push(record({ id: agentId }));
      const rows: AgentTimelineRow[] = [];
      // The match is the oldest row of the last scanned agent, so newest-first
      // scanning would need more than the host cap to reach it.
      if (index === SEARCH_TIER2_MAX_AGENTS_PER_HOST - 1) {
        rows.push(userMessageRow(0, "host-cap-needle", fresh));
      }
      for (let seq = 1; seq <= perAgent; seq++) {
        rows.push(userMessageRow(seq, `filler ${index}-${seq}`, fresh));
      }
      timeline.set(agentId, rows);
    }
    const { deps } = buildDeps({ records: agents, timeline });

    const tier2 = await searchTier2("host-cap-needle", deps);
    expect(tier2.matches).toHaveLength(0);
    expect(tier2.scannedItems).toBe(SEARCH_TIER2_MAX_ITEMS_PER_HOST);
  });

  test("skips agents with no activity in the 30-day window and archived-free stale records", async () => {
    const timeline = new FakeTimelineStore();
    timeline.set("old", [userMessageRow(0, "stale-needle", stale)]);
    const { deps } = buildDeps({
      records: [record({ id: "old", updatedAt: stale })],
      timeline,
    });
    const tier2 = await searchTier2("stale-needle", deps);
    expect(tier2.matches).toHaveLength(0);
    expect(tier2.scannedAgents).toBe(0);
  });

  test("skips agents whose timeline rows all predate the window", async () => {
    const timeline = new FakeTimelineStore();
    timeline.set("a1", [
      userMessageRow(0, "old needle inside rows", stale),
      userMessageRow(1, "even older", "2025-01-01T00:00:00Z"),
    ]);
    const { deps } = buildDeps({
      records: [record({ id: "a1" })],
      timeline,
    });
    const tier2 = await searchTier2("old needle", deps);
    expect(tier2.matches).toHaveLength(0);
  });
});

describe("tier 3 — History Ask (deep)", () => {
  test("runs only when deep and tiers 1-2 found nothing", async () => {
    const tier3 = { run: vi.fn(async () => []) };
    const { deps } = buildDeps({
      records: [record({ id: "a1", name: "Rusty", title: "Fix auth" })],
      tier3,
    });
    // Shallow: tier 3 never invoked.
    await runFleetSearchHost({ query: "nothing-matches-anywhere", deps });
    expect(tier3.run).not.toHaveBeenCalled();
    // Deep with a tier-1 hit: not invoked either.
    await runFleetSearchHost({ query: "auth", deps, deep: true });
    expect(tier3.run).not.toHaveBeenCalled();
    // Deep with nothing: invoked, rows stamped host "local".
    tier3.run.mockResolvedValue([
      {
        host: "",
        agentId: "agt_hist_1",
        title: "Implement webhooks",
        matchedIn: "transcript",
        snippet: "- [Implement webhooks](paseo://h/srv/agent/agt_hist_1) /repo/app",
      },
    ]);
    const matches = await runFleetSearchHost({ query: "webhooks", deps, deep: true });
    expect(tier3.run).toHaveBeenCalledTimes(1);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ host: "local", agentId: "agt_hist_1" });
  });

  test("skips tier 3 when deep but no runner is available", async () => {
    const { deps } = buildDeps({ records: [record({ id: "a1" })] });
    const matches = await runFleetSearchHost({ query: "zzz-nothing", deps, deep: true });
    expect(matches).toHaveLength(0);
  });

  test("buildFleetHistoryAskBrief carries the query and the citation contract", () => {
    const brief = buildFleetHistoryAskBrief("who fixed the gateway?", "server-abc");
    expect(brief).toContain("who fixed the gateway?");
    expect(brief).toContain("server-abc");
    expect(brief).toContain("paseo://h/<urlencoded-serverId>/agent/<urlencoded-agentId>");
    expect(brief).toContain("Never invent agent ids");
  });

  test("parseHistoryAskMatches maps markdown citations into rows", () => {
    const answer = [
      "Found 2 sessions:",
      "- [Implement webhooks](paseo://h/srv-1/agent/agt_1)",
      "  - cwd: /repo/app",
      "  - snippet: webhook receiver wired",
      "- [Fix gateway timeouts](paseo://h/srv-1/agent/agt_2)",
      "No other matches.",
    ].join("\n");
    const matches = parseHistoryAskMatches(answer, "srv-1");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      host: "",
      agentId: "agt_1",
      title: "Implement webhooks",
      matchedIn: "transcript",
    });
    expect(matches[0]!.snippet).toContain("webhook receiver wired");
    expect(matches[1]!.agentId).toBe("agt_2");
  });

  test("parseHistoryAskMatches ignores non-paseo links", () => {
    const matches = parseHistoryAskMatches(
      "[docs](https://example.com/x) [session](paseo://h/srv/agent/agt_9)",
      "srv",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.agentId).toBe("agt_9");
  });
});

describe("merge + rank (fleet-wide)", () => {
  test("identity matches outrank brief, reports, transcript", () => {
    const matches: FleetSearchMatch[] = [
      { host: "h1", agentId: "a1", title: null, matchedIn: "transcript", snippet: "t" },
      { host: "h1", agentId: "a1", title: null, matchedIn: "identity", snippet: "i" },
      { host: "h1", agentId: "a1", title: null, matchedIn: "reports", snippet: "r" },
      { host: "h1", agentId: "a1", title: null, matchedIn: "brief", snippet: "b" },
    ];
    const merged = mergeFleetSearchMatches(matches);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.matchedIn).toBe("identity");
    expect(merged[0]!.snippet).toBe("i");
  });

  test("keeps one row per (host, agentId) and ranks across hosts", () => {
    const matches: FleetSearchMatch[] = [
      { host: "h2", agentId: "a1", title: null, matchedIn: "transcript", snippet: "t" },
      { host: "h1", agentId: "a1", title: null, matchedIn: "reports", snippet: "r" },
      { host: "h1", agentId: "a1", title: null, matchedIn: "identity", snippet: "i" },
      { host: "h1", agentId: "a2", title: null, matchedIn: "identity", snippet: "i2" },
    ];
    const merged = mergeFleetSearchMatches(matches);
    expect(merged.map((match) => `${match.host}:${match.agentId}`)).toEqual([
      "h1:a1", // identity beats reports for the same host+agent; a1 < a2 on tie
      "h1:a2",
      "h2:a1", // different host is a different row
    ]);
  });

  test("caps the total", () => {
    const matches: FleetSearchMatch[] = [];
    for (let index = 0; index < 10; index++) {
      matches.push({
        host: "h1",
        agentId: `a${index}`,
        title: null,
        matchedIn: "identity",
        snippet: "i",
      });
    }
    expect(mergeFleetSearchMatches(matches, 3)).toHaveLength(3);
  });

  test("runs tier 2 when tier 1 is thin but non-empty", async () => {
    const timeline = new FakeTimelineStore();
    const records = [];
    for (let index = 0; index < SEARCH_TIER1_THIN_THRESHOLD; index++) {
      const agentId = `match${index}`;
      records.push(record({ id: agentId, name: `name-${index}` }));
    }
    records.push(record({ id: "transcript-only" }));
    // The needle is NOT in the launch brief (first user message) — tier 1
    // misses it; only the tier-2 transcript scan finds it.
    timeline.set("transcript-only", [
      userMessageRow(0, "start work", freshTimestamp()),
      assistantMessageRow(1, "finished: the thin-tier needle landed", freshTimestamp()),
    ]);
    const { deps } = buildDeps({ records, timeline });
    const matches = await runFleetSearchHost({ query: "thin-tier needle", deps });
    expect(matches.map((match) => match.agentId)).toContain("transcript-only");
    expect(matches.find((match) => match.agentId === "transcript-only")!.matchedIn).toBe(
      "transcript",
    );
  });

  test("skips tier 2 when tier 1 is not thin", async () => {
    const timeline = new FakeTimelineStore();
    const records = [];
    for (let index = 0; index < SEARCH_TIER1_THIN_THRESHOLD; index++) {
      records.push(record({ id: `t${index}`, title: `same-title-${index}` }));
    }
    timeline.set("t0", [userMessageRow(0, "transcript needle", freshTimestamp())]);
    const { deps } = buildDeps({ records, timeline });
    const matches = await runFleetSearchHost({ query: "same-title", deps });
    expect(matches.length).toBeGreaterThanOrEqual(SEARCH_TIER1_THIN_THRESHOLD);
    expect(matches.some((match) => match.matchedIn === "transcript")).toBe(false);
  });
});

function freshTimestamp(): string {
  return new Date(Date.now() - 60 * 1000).toISOString();
}
