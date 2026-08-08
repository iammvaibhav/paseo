import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function workspaceRecord(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_1",
    projectId: "project-1",
    cwd: "/Users/vaibhav/paseo",
    kind: "directory",
    displayName: "paseo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

interface AutoNameHarness {
  autoName: WorkspaceAutoName;
  upserted: PersistedWorkspaceRecord[];
  generateWorkspaceName: ReturnType<typeof vi.fn>;
}

function createHarness(initial: PersistedWorkspaceRecord[] = []): AutoNameHarness {
  const records = new Map(initial.map((record) => [record.workspaceId, record]));
  const upserted: PersistedWorkspaceRecord[] = [];
  const generateWorkspaceName = vi.fn(async () => ({ title: "Leaked title", branch: null }));
  const autoName = new WorkspaceAutoName({
    agentManager: { listAgents: () => [] } as unknown as AgentManager,
    workspaceRegistry: {
      get: async (workspaceId: string) => records.get(workspaceId) ?? null,
      upsert: async (record) => {
        records.set(record.workspaceId, record);
        upserted.push(record);
      },
    },
    workspaceGitService: {} as unknown as WorkspaceGitService,
    providerSnapshotManager: {} as unknown as ProviderSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: "test" }),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger: createTestLogger(),
    generateWorkspaceName,
  });
  return { autoName, upserted, generateWorkspaceName };
}

describe("WorkspaceAutoName machinery skip", () => {
  beforeEach(() => {
    // The auto-name run is deferred through setTimeout(..., 0); drive it
    // deterministically instead of waiting real time.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the deferred auto-name task and settle its async body. */
  async function runScheduled(): Promise<void> {
    await vi.runAllTimersAsync();
  }

  test("skips auto-naming when the first message is a <paseo-system> machinery envelope", async () => {
    const { autoName, upserted, generateWorkspaceName } = createHarness();
    const workspace = workspaceRecord();
    autoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: {
        prompt: "<paseo-system>\nFleet context snapshot:\n# Fleet map\n</paseo-system>",
      },
    });
    await runScheduled();
    expect(upserted).toEqual([]);
    expect(generateWorkspaceName).not.toHaveBeenCalled();
  });

  test("skips auto-naming for a worktree whose first message is a machinery envelope", async () => {
    const { autoName, upserted, generateWorkspaceName } = createHarness();
    const workspace = workspaceRecord();
    autoName.scheduleForWorktree(
      {
        workspace,
        firstAgentContext: {
          prompt: "<paseo-system>\nFleet digest: 1 event.\n</paseo-system>",
        },
      },
      {},
    );
    await runScheduled();
    expect(upserted).toEqual([]);
    expect(generateWorkspaceName).not.toHaveBeenCalled();
  });

  test("skips auto-naming for mission-control-labeled agents (commander)", async () => {
    const { autoName, upserted, generateWorkspaceName } = createHarness();
    const workspace = workspaceRecord();
    autoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Route this to the right host" },
      labels: { "paseo.mission-control": "commander" },
    });
    await runScheduled();
    expect(upserted).toEqual([]);
    expect(generateWorkspaceName).not.toHaveBeenCalled();
  });

  test("skips auto-naming for mission-control-labeled agents (verifier)", async () => {
    const { autoName, upserted, generateWorkspaceName } = createHarness();
    const workspace = workspaceRecord();
    autoName.scheduleForWorktree(
      {
        workspace,
        firstAgentContext: { prompt: "Audit the evidence" },
        labels: { "paseo.mission-control": "verifier" },
      },
      {},
    );
    await runScheduled();
    expect(upserted).toEqual([]);
    expect(generateWorkspaceName).not.toHaveBeenCalled();
  });

  test("still auto-names ordinary user work", async () => {
    const workspace = workspaceRecord();
    const { autoName, upserted, generateWorkspaceName } = createHarness([workspace]);
    autoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Fix login bug" },
    });
    await runScheduled();
    expect(generateWorkspaceName).toHaveBeenCalledTimes(1);
    expect(upserted.some((record) => record.title === "Leaked title")).toBe(true);
  });
});
