import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

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
      update: async (workspaceId, updater) => {
        const current = records.get(workspaceId);
        if (!current) {
          throw new Error(`workspace ${workspaceId} not found`);
        }
        const next = updater(current);
        records.set(workspaceId, next);
        upserted.push(next);
        return next;
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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

test("auto-name preserves workspace archival that lands during its metadata write", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const mutationStarted = deferred();
  const allowMutation = deferred();
  const updateEmitted = deferred();
  const workspaceRegistry = {
    update: async (_workspaceId, updater) => {
      mutationStarted.resolve();
      await allowMutation.promise;
      workspace = updater(workspace);
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "update">;
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry,
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => updateEmitted.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => ({ title: "generated", branch: null }),
  });

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await mutationStarted.promise;
  const archivedAt = "2026-08-08T00:01:00.000Z";
  workspace = { ...workspace, updatedAt: archivedAt, archivedAt };
  allowMutation.resolve();
  await updateEmitted.promise;

  expect(workspace).toMatchObject({
    title: "generated",
    archivedAt,
  });
});
