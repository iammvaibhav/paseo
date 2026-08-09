import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import type { MissionControlService } from "../../mission-control/service.js";
import type { MissionControlRunRecord } from "../../mission-control/run-records.js";
import type { WorkspaceRollup } from "../../mission-control/rollups.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

function runRecord(overrides: Partial<MissionControlRunRecord> = {}): MissionControlRunRecord {
  return {
    id: "mcr_agent-1_1",
    agentId: "agent-1",
    agentName: "Rusty",
    agentTitle: "Rusty",
    hostAlias: "local",
    serverId: "server-1",
    workspaceId: "ws-1",
    workspaceTitle: "mission-control",
    projectId: "proj-1",
    projectName: "paseo",
    runEpoch: 1,
    startedAt: "2026-08-09T09:00:00.000Z",
    endedAt: "2026-08-09T10:00:00.000Z",
    outcome: "finished",
    brief: "Ship run records for M6",
    reports: [],
    verdict: null,
    proofs: [],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  } as MissionControlRunRecord;
}

function workspaceRollup(records: MissionControlRunRecord[]): WorkspaceRollup {
  return {
    kind: "workspace",
    workspaceId: "ws-1",
    workspaceTitle: "mission-control",
    projectId: "proj-1",
    projectName: "paseo",
    updatedAt: records[0]?.updatedAt ?? "2026-08-09T10:00:00.000Z",
    runs: records.map((record) => ({
      agentId: record.agentId,
      agentName: record.agentName,
      endedAt: record.endedAt,
      outcome: record.outcome,
      brief: record.brief,
      decisions: [],
      open: ["awaiting verdict"],
      verdict: record.verdict?.summary ?? null,
    })),
  };
}

interface HarnessOptions {
  missionControlService?: Partial<MissionControlService>;
  records?: MissionControlRunRecord[];
}

function createHarness(options: HarnessOptions = {}) {
  const records = options.records ?? [runRecord()];
  const missionControlService = {
    getRunRecords: vi.fn(() => records),
    getAgentRunRecords: vi.fn((agentId: string, limit = 5) =>
      records.filter((record) => record.agentId === agentId).slice(0, limit),
    ),
    getWorkspaceRollup: vi.fn((workspaceId: string) =>
      workspaceId === "ws-1" ? workspaceRollup(records) : null,
    ),
    getProjectRollup: vi.fn(() => null),
    hindsightRecall: vi.fn(async (query: string, limit = 5) => ({
      ok: true as const,
      matches: [
        {
          id: "mem-1",
          text: `Rusty: ${query}`,
          context: null,
          occurredStart: null,
          documentId: "paseo-run:agent-1:1",
          tags: ["host:local", "agent:Rusty"],
          bank: "paseo-fleet",
          sessionId: null,
          entities: null,
          metadata: null,
          attribution: {
            agentId: "agent-1",
            agentName: "Rusty",
            agentTitle: "Rusty",
            workspaceId: "ws-1",
          },
        },
      ].slice(0, limit),
    })),
    ...options.missionControlService,
  } as unknown as MissionControlService;

  const agentManager = { getAgent: vi.fn(() => null) } as unknown as AgentManager;
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage: { list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    workspaceRegistry: { list: async () => [] } as unknown as never,
    projectRegistry: { list: async () => [] } as unknown as never,
    missionControlService,
    serverId: "server-local",
    peerManager: {
      getPeerStatus: () => null,
      getPeerStatuses: () => [],
      getPeerClient: () => null,
    } as unknown as PeerManager,
    logger: createTestLogger(),
  });

  return { catalog, missionControlService };
}

describe("M6 Commander context tools", () => {
  test("fleet_recall returns recall matches over the fleet bank", async () => {
    const { catalog, missionControlService } = createHarness();
    const result = await catalog.executeTool("fleet_recall", { query: "auth bug", limit: 3 });
    const content = result.structuredContent as {
      ok: boolean;
      matches: Array<{
        text: string;
        documentId: string;
        bank: string;
        sessionId: string | null;
        entities: string[] | null;
        attribution?: {
          agentId: string;
          agentName: string;
          agentTitle: string;
          workspaceId: string | null;
        };
      }>;
    };
    expect(content.ok).toBe(true);
    expect(content.matches[0].text).toBe("Rusty: auth bug");
    expect(content.matches[0].documentId).toBe("paseo-run:agent-1:1");
    // The source-bank tag and omp-style session attribution pass through.
    expect(content.matches[0].bank).toBe("paseo-fleet");
    expect(content.matches[0].sessionId).toBeNull();
    expect(content.matches[0].attribution).toEqual({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      workspaceId: "ws-1",
    });
    expect(missionControlService.hindsightRecall).toHaveBeenCalledWith("auth bug", 3);
  });

  test("fleet_recall degrades to memory unavailable when the bank is unreachable", async () => {
    const { catalog } = createHarness({
      missionControlService: {
        hindsightRecall: vi.fn(async () => ({
          ok: false as const,
          reason: "memory unavailable" as const,
          error: "timeout",
        })),
      },
    });
    const result = await catalog.executeTool("fleet_recall", { query: "anything" });
    expect(result.structuredContent).toEqual({
      ok: false,
      reason: "memory unavailable",
      error: "timeout",
    });
  });

  test("fleet_context with agentId returns that agent's run records", async () => {
    const records = [
      runRecord({ id: "mcr_agent-1_2", runEpoch: 2, endedAt: "2026-08-09T12:00:00.000Z" }),
      runRecord(),
      runRecord({ id: "mcr_agent-9_1", agentId: "agent-9", agentName: "Quill" }),
    ];
    const { catalog } = createHarness({ records });
    const result = await catalog.executeTool("fleet_context", { agentId: "agent-1" });
    const content = result.structuredContent as {
      runRecords: Array<{ agentId: string }>;
      workspaceRollup?: unknown;
      projectRollup?: unknown;
    };
    expect(content.runRecords.map((record) => record.agentId)).toEqual(["agent-1", "agent-1"]);
    expect(content.workspaceRollup).toBeUndefined();
  });

  test("fleet_context with workspaceId returns the rollup plus the workspace's records", async () => {
    const { catalog } = createHarness();
    const result = await catalog.executeTool("fleet_context", { workspaceId: "ws-1" });
    const content = result.structuredContent as {
      runRecords: Array<{ workspaceId: string }>;
      workspaceRollup: { kind: string; workspaceTitle: string };
    };
    expect(content.workspaceRollup.kind).toBe("workspace");
    expect(content.workspaceRollup.workspaceTitle).toBe("mission-control");
    expect(content.runRecords.every((record) => record.workspaceId === "ws-1")).toBe(true);
  });

  test("fleet_context with no args returns the most recent records fleet-wide", async () => {
    const { catalog } = createHarness();
    const result = await catalog.executeTool("fleet_context", {});
    const content = result.structuredContent as { runRecords: unknown[] };
    expect(content.runRecords.length).toBeGreaterThan(0);
  });

  test("fleet_recall without mission control degrades, never throws", async () => {
    const bare = createPaseoToolCatalog({
      agentManager: { getAgent: vi.fn(() => null) } as unknown as AgentManager,
      agentStorage: { list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      workspaceRegistry: { list: async () => [] } as unknown as never,
      projectRegistry: { list: async () => [] } as unknown as never,
      serverId: "server-local",
      logger: createTestLogger(),
    });
    const result = await bare.executeTool("fleet_recall", { query: "anything" });
    expect(result.structuredContent).toEqual({ ok: false, reason: "memory unavailable" });
    const context = await bare.executeTool("fleet_context", {});
    expect((context.structuredContent as { ok: boolean }).ok).toBe(false);
  });

  test("both tools are registered in the catalog", () => {
    const { catalog } = createHarness();
    expect(catalog.getTool("fleet_recall")?.name).toBe("fleet_recall");
    expect(catalog.getTool("fleet_context")?.name).toBe("fleet_context");
  });

  test("fleet_recall rejects an empty query at the schema boundary", async () => {
    const { catalog } = createHarness();
    await expect(catalog.executeTool("fleet_recall", { query: "" })).rejects.toThrow();
  });
});
