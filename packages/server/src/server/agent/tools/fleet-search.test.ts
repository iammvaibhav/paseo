import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

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
    return [...(this.rowsByAgent.get(agentId) ?? [])].sort((a, b) => b.seq - a.seq);
  }
}

interface CatalogHarnessOptions {
  records?: StoredAgentRecord[];
  timeline?: FakeTimelineStore;
  peerMatches?: Array<Record<string, unknown>>;
  offlinePeers?: boolean;
  unknownPeers?: boolean;
  /** This daemon's Mission Control host alias (fleet tool results replace "local"). */
  hostAlias?: string | null;
}

function createHarness(options: CatalogHarnessOptions = {}) {
  const timeline = options.timeline ?? new FakeTimelineStore();
  const records = options.records ?? [record({ id: "local-1", name: "Rusty", title: "Fix auth" })];
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
    seedTimelineFromItems: vi.fn(() => true),
  } as unknown as AgentManager;

  const peerMatches = options.peerMatches ?? [
    {
      host: "local",
      agentId: "peer-1",
      title: "Peer task",
      matchedIn: "identity",
      snippet: "peer matched line",
    },
  ];
  const client = {
    missionControlSearch: vi.fn(async () => ({
      requestId: "req-1",
      matches: peerMatches,
    })),
  } as unknown as DaemonClient;

  const statuses = options.offlinePeers
    ? [{ name: "macbook", state: "unreachable" as const, lastSeenAt: "2026-08-08T00:00:00.000Z" }]
    : [{ name: "macbook", state: "online" as const, lastSeenAt: null }];
  const peerManager = {
    getPeerStatus: (name: string) => statuses.find((s) => s.name === name) ?? null,
    getPeerStatuses: () =>
      statuses.map((s) => Object.assign({}, s, { name: s.name, url: `ws://${s.name}` })),
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;

  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage: { list: async () => records } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    workspaceRegistry: { list: async () => [] } as unknown as never,
    projectRegistry: { list: async () => [] } as unknown as never,
    missionControlService: { fetchEvents: () => [] } as unknown as never,
    serverId: "server-local",
    hostAlias: options.hostAlias ?? undefined,
    peerManager,
    logger: createTestLogger(),
  });

  return { catalog, client, peerManager };
}

describe("fleet_search tool", () => {
  test("runs the local tiered search and returns matches", async () => {
    const { catalog, client } = createHarness({
      records: [
        record({ id: "local-1", name: "Rusty", title: "Fix auth" }),
        record({ id: "local-2", name: "Mira", title: "Ship charts" }),
      ],
      peerMatches: [],
    });
    const result = await catalog.executeTool("fleet_search", {
      query: "auth",
      limit: 20,
      deep: false,
    });
    expect(result.structuredContent).toMatchObject({
      matches: [
        {
          host: "local",
          agentId: "local-1",
          name: "Rusty",
          title: "Fix auth",
          matchedIn: "identity",
        },
      ],
    });
    // Peer was queried but returned nothing.
    expect(client.missionControlSearch).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.matches).toHaveLength(1);
  });

  test("proxies to online peers, re-stamps host, merges and ranks", async () => {
    const { catalog, client } = createHarness({
      records: [record({ id: "local-1", name: "Rusty", title: "Task worker" })],
      peerMatches: [
        {
          host: "local",
          agentId: "peer-1",
          title: "Peer task",
          matchedIn: "identity",
          snippet: "peer matched line",
        },
        {
          host: "local",
          agentId: "peer-2",
          title: null,
          matchedIn: "transcript",
          snippet: "transcript line",
        },
      ],
    });
    const result = await catalog.executeTool("fleet_search", {
      query: "task",
      limit: 20,
    });
    expect(client.missionControlSearch).toHaveBeenCalledWith({
      query: "task",
      limit: 20,
      deep: false,
    });
    const matches = result.structuredContent.matches as Array<Record<string, unknown>>;
    expect(matches.map((match) => match.host)).toEqual(["local", "macbook", "macbook"]);
    expect(matches[1]).toMatchObject({ agentId: "peer-1", host: "macbook" });
    expect(matches[2]).toMatchObject({ agentId: "peer-2", host: "macbook" });
  });

  test("deep flag is forwarded to peers", async () => {
    const { catalog, client } = createHarness({ peerMatches: [] });
    await catalog.executeTool("fleet_search", {
      query: "deep-needle",
      limit: 5,
      deep: true,
    });
    expect(client.missionControlSearch).toHaveBeenCalledWith({
      query: "deep-needle",
      limit: 5,
      deep: true,
    });
  });

  test("skips offline peers instead of failing the search", async () => {
    const { catalog, client } = createHarness({ offlinePeers: true });
    const result = await catalog.executeTool("fleet_search", { query: "auth" });
    expect(client.missionControlSearch).not.toHaveBeenCalled();
    const matches = result.structuredContent.matches as Array<Record<string, unknown>>;
    expect(matches.map((match) => match.host)).toEqual(["local"]);
  });

  test("replaces the literal local host with the host alias in results", async () => {
    const { catalog, client } = createHarness({
      records: [record({ id: "local-1", name: "Rusty", title: "Fix auth" })],
      peerMatches: [],
      hostAlias: "work server",
    });
    const result = await catalog.executeTool("fleet_search", {
      query: "auth",
      limit: 20,
      deep: false,
    });
    const matches = result.structuredContent.matches as Array<Record<string, unknown>>;
    // The local match carries the alias; the peer was queried and returned none.
    expect(matches.map((match) => match.host)).toEqual(["work server"]);
    expect(matches[0]).toMatchObject({ agentId: "local-1", host: "work server" });
    expect(client.missionControlSearch).toHaveBeenCalledTimes(1);
  });

  test("caps the merged result fleet-wide", async () => {
    const peerMatches = Array.from({ length: 12 }, (_, index) => ({
      host: "local",
      agentId: `peer-${index}`,
      title: null,
      matchedIn: "identity",
      snippet: "s",
    }));
    const { catalog } = createHarness({
      records: Array.from({ length: 12 }, (_, index) =>
        record({ id: `local-${index}`, title: `local title ${index}` }),
      ),
      peerMatches,
    });
    const result = await catalog.executeTool("fleet_search", {
      query: "title",
      limit: 5,
    });
    const matches = result.structuredContent.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(5);
  });

  test("validates the schema: empty query rejected, limit capped at 50", async () => {
    const { catalog } = createHarness();
    await expect(catalog.executeTool("fleet_search", { query: "" })).rejects.toThrow();
    await expect(catalog.executeTool("fleet_search", { query: "x", limit: 100 })).rejects.toThrow();
  });
});
