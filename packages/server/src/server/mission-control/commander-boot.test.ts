import { existsSync, rmSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { expandUserPath } from "../path-utils.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";
import {
  commanderHomeCwd,
  ensureCommanderOnBoot,
  resetCommander,
  spawnCommander,
  archiveOrphanCommanderWorkspaces,
  migrateLegacyCommanderHomeWorkspaces,
  resolveOrCreateCommanderWorkspace,
  commanderHomeWorkspaceTitle,
  computeCommanderBuildHash,
  remapLegacyCommanderCreateCwd,
  COMMANDER_TOOL_ALLOWLIST,
  COMMANDER_HASH_LABEL_KEY,
  type EnsureCommanderOnBootInput,
} from "./commander-boot.js";
import type { FleetContextDependencies } from "./context.js";

const HOME_CWD = expandUserPath("~");
// A synthetic daemon paseo home for tests: the Commander's reserved home is
// `<paseoHome>/commander` (never the real `~/.paseo` — the dev stack's
// overridden PASEO_HOME must not touch the production home).
const TEST_PASEO_HOME = "/tmp/mc-test-paseo-home";
// The reserved Commander home (`<paseoHome>/commander`).
const COMMANDER_HOME_CWD = commanderHomeCwd(TEST_PASEO_HOME);

function createWorkspaceRecord(
  overrides: Partial<PersistedWorkspaceRecord> & { workspaceId: string },
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: overrides.workspaceId,
    projectId: "project-home",
    cwd: HOME_CWD,
    kind: "directory",
    displayName: "home",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

interface WorkspaceRegistryHarness {
  list: () => Promise<PersistedWorkspaceRecord[]>;
  upsert: (record: PersistedWorkspaceRecord) => Promise<void>;
  archive: (workspaceId: string, archivedAt: string) => Promise<void>;
  records: Map<string, PersistedWorkspaceRecord>;
  createCommanderWorkspace: (cwd: string, title: string) => Promise<{ workspaceId: string }>;
}

function workspaceRegistryHarness(
  initial: PersistedWorkspaceRecord[] = [],
): WorkspaceRegistryHarness {
  const records = new Map(initial.map((workspace) => [workspace.workspaceId, workspace]));
  let sequence = 0;
  const createCommanderWorkspace: WorkspaceRegistryHarness["createCommanderWorkspace"] = async (
    cwd,
    title,
  ) => {
    sequence += 1;
    const workspaceId = `wks_home_${sequence}`;
    records.set(
      workspaceId,
      createWorkspaceRecord({ workspaceId, cwd, title, createdAt: new Date().toISOString() }),
    );
    return { workspaceId };
  };
  return {
    list: async () => Array.from(records.values()),
    upsert: async (record) => {
      records.set(record.workspaceId, record);
    },
    archive: async (workspaceId, archivedAt) => {
      const existing = records.get(workspaceId);
      if (existing) {
        records.set(workspaceId, { ...existing, archivedAt, updatedAt: archivedAt });
      }
    },
    records,
    createCommanderWorkspace,
  };
}

function minimalLaunchContext(): FleetContextDependencies {
  const daemonConfigStore = {
    get: () => ({ missionControl: {} }) as ReturnType<DaemonConfigStore["get"]>,
  };
  return {
    agentManager: { listAgents: () => [] } as unknown as Pick<AgentManager, "listAgents">,
    agentStorage: { list: async () => [] } as unknown as Pick<AgentStorage, "list">,
    workspaceRegistry: {
      list: async () => [],
    } as unknown as FleetContextDependencies["workspaceRegistry"],
    projectRegistry: {
      list: async () => [],
    } as unknown as FleetContextDependencies["projectRegistry"],
    providerSnapshotManager: {
      listProviders: async () => [],
      listRegisteredProviderIds: () => ["codex"],
    } as unknown as Pick<ProviderSnapshotManager, "listProviders" | "listRegisteredProviderIds">,
    peerManager: null,
    daemonConfigStore,
    serverId: "server-local",
    hostName: "mac-work",
    logger: createTestLogger(),
  };
}

function bootInput(
  overrides: Partial<EnsureCommanderOnBootInput> = {},
): EnsureCommanderOnBootInput {
  const createAgent = vi.fn().mockResolvedValue({
    snapshot: { id: "commander-new" },
    liveSnapshot: { id: "commander-new" },
    background: true,
    initialPromptStarted: true,
    initialPromptError: null,
  });
  const workspaceHarness = workspaceRegistryHarness();
  return {
    logger: createTestLogger(),
    publishEvent: vi.fn(),
    agentManager: {
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
      archiveSnapshot: vi.fn(async () => ({ id: "commander-1" })),
    } as unknown as AgentManager,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as unknown as AgentStorage,
    providerSnapshotManager: {
      listRegisteredProviderIds: () => ["codex"],
    } as unknown as Pick<ProviderSnapshotManager, "listRegisteredProviderIds">,
    createAgent: createAgent as EnsureCommanderOnBootInput["createAgent"],
    centralConfig: () => ({
      commanderHost: null,
      commanderModel: null,
      commanderInstructions: "",
      verifierModel: null,
      verifierConcurrency: 3,
      evaluationScope: "commander",
      mode: "ask",
      retentionDays: 30,
      namingTheme: "mixed",
      hideAgentNames: false,
      defaultDispatchHost: null,
      silenceNudgeSeconds: 120,
      statusNudgeSeconds: 300,
      escalateSeconds: 300,
    }),
    launchContext: minimalLaunchContext(),
    paseoHome: TEST_PASEO_HOME,
    hostName: "mac-work",
    hostAlias: null,
    workspaceRegistry: workspaceHarness,
    createCommanderWorkspace: workspaceHarness.createCommanderWorkspace,
    ...overrides,
  };
}

/** Explicitly designate this host so the test exercises the ensure logic. */
function designatedCentralConfig(): MissionControlCentralConfig {
  return {
    commanderHost: "mac-work",
    commanderModel: null,
    commanderInstructions: "",
    verifierModel: null,
    verifierConcurrency: 3,
    evaluationScope: "commander",
    mode: "ask",
    retentionDays: 30,
    namingTheme: "mixed",
    hideAgentNames: false,
    defaultDispatchHost: null,
    silenceNudgeSeconds: 120,
    statusNudgeSeconds: 300,
    escalateSeconds: 300,
  };
}

describe("ensureCommanderOnBoot", () => {
  test("designation is required: null commanderHost ensures NO host", async () => {
    const input = bootInput();
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("designation is required: unset commanderHost ensures NO host", async () => {
    const input = bootInput({
      centralConfig: () => ({
        commanderHost: undefined,
        commanderModel: null,
        commanderInstructions: "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: null,
        silenceNudgeSeconds: 120,
        statusNudgeSeconds: 300,
        escalateSeconds: 300,
      }),
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("the explicitly designated host ensures the Commander exactly once, stamped with its home workspace", async () => {
    const input = bootInput({
      centralConfig: designatedCentralConfig,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("commander-new");
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.labels).toEqual({
      "paseo.mission-control": "commander",
      [COMMANDER_HASH_LABEL_KEY]: computeCommanderBuildHash(),
    });
    expect(createCall.title).toBe("Commander");
    expect(createCall.config.systemPromptMode).toBe("replace");
    expect(createCall.config.toolAllowlist).toEqual([...COMMANDER_TOOL_ALLOWLIST]);
    // First message = world snapshot (headed by WORLD_SNAPSHOT_MARKER), not the system prompt.
    expect(createCall.initialPrompt).toContain("# Fleet state as of ");
    expect(createCall.initialPrompt).toContain("Fleet map");
    expect(createCall.config.systemPrompt).not.toContain("Fleet map");
    // The Commander is stamped with (and creates exactly one) home workspace
    // in the reserved home (`<paseoHome>/commander`).
    expect(createCall.workspaceId).toBe("wks_home_1");
    expect(createCall.cwd).toBe(COMMANDER_HOME_CWD);
    expect(createCall.config.cwd).toBe(COMMANDER_HOME_CWD);
    const workspaceHarness = input.workspaceRegistry as WorkspaceRegistryHarness;
    expect(workspaceHarness.records.get("wks_home_1")).toMatchObject({
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
  });

  test('designation by the explicit "local" value ensures the local host', async () => {
    const input = bootInput({
      centralConfig: () => ({
        ...designatedCentralConfig(),
        commanderHost: "local",
      }),
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
    expect(input.createAgent).toHaveBeenCalledTimes(1);
  });

  test("honors the central commanderModel override", async () => {
    const input = bootInput({
      centralConfig: () => ({
        ...designatedCentralConfig(),
        commanderModel: "fast-omp/fast-model",
      }),
    });
    await ensureCommanderOnBoot(input);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.provider).toBe("fast-omp");
    expect(createCall.config.model).toBe("fast-model");
  });

  test("does not create a second Commander when one is live", async () => {
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [
          {
            id: "commander-1",
            labels: {
              "paseo.mission-control": "commander",
              [COMMANDER_HASH_LABEL_KEY]: computeCommanderBuildHash(),
            },
          },
        ],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => ({ id: "commander-1" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
        get: async () => ({
          id: "commander-1",
          labels: {
            "paseo.mission-control": "commander",
            [COMMANDER_HASH_LABEL_KEY]: computeCommanderBuildHash(),
          },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("does not create when an unarchived Commander record exists", async () => {
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentStorage: {
        list: async () => [
          {
            id: "commander-stored",
            labels: {
              "paseo.mission-control": "commander",
              [COMMANDER_HASH_LABEL_KEY]: computeCommanderBuildHash(),
            },
            archivedAt: null,
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
        get: async () => ({
          id: "commander-stored",
          labels: {
            "paseo.mission-control": "commander",
            [COMMANDER_HASH_LABEL_KEY]: computeCommanderBuildHash(),
          },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(result.agentId).toBe("commander-stored");
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("creates when only an archived Commander record exists", async () => {
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentStorage: {
        list: async () => [
          {
            id: "commander-archived",
            labels: { "paseo.mission-control": "commander" },
            archivedAt: "2026-01-01T00:00:00Z",
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
  });

  test("does nothing on a host that is not the designated commander host", async () => {
    const input = bootInput({
      centralConfig: () => ({
        commanderHost: "other-host",
        commanderModel: null,
        commanderInstructions: "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: null,
        silenceNudgeSeconds: 120,
        statusNudgeSeconds: 300,
        escalateSeconds: 300,
      }),
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("matches designation by host alias", async () => {
    const input = bootInput({
      hostAlias: "work server",
      centralConfig: () => ({
        commanderHost: "work server",
        commanderModel: null,
        commanderInstructions: "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: null,
        silenceNudgeSeconds: 120,
        statusNudgeSeconds: 300,
        escalateSeconds: 300,
      }),
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
  });

  test("defers when no provider is registered", async () => {
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      providerSnapshotManager: {
        listRegisteredProviderIds: () => [],
      } as unknown as Pick<ProviderSnapshotManager, "listRegisteredProviderIds">,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("does nothing when missionControl.enabled is false on this host", async () => {
    const daemonConfigStore = {
      get: () => ({ missionControl: { enabled: false } }) as ReturnType<DaemonConfigStore["get"]>,
    };
    const input = bootInput({
      launchContext: { ...minimalLaunchContext(), daemonConfigStore },
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("keeps a live Commander whose build hash matches the current build", async () => {
    const currentHash = computeCommanderBuildHash();
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [
          {
            id: "commander-1",
            labels: {
              "paseo.mission-control": "commander",
              [COMMANDER_HASH_LABEL_KEY]: currentHash,
            },
          },
        ],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => ({ id: "commander-1" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
        get: async () => ({
          id: "commander-1",
          labels: {
            "paseo.mission-control": "commander",
            [COMMANDER_HASH_LABEL_KEY]: currentHash,
          },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(result.agentId).toBe("commander-1");
    expect(input.createAgent).not.toHaveBeenCalled();
    expect(input.agentManager.archiveAgent).not.toHaveBeenCalled();
  });

  test("archives a live Commander whose build hash drifted and spawns a fresh one", async () => {
    const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [
          {
            id: "commander-stale",
            labels: {
              "paseo.mission-control": "commander",
              [COMMANDER_HASH_LABEL_KEY]: "stale-hash",
            },
          },
        ],
        getAgent: () => ({
          id: "commander-stale",
          labels: { "paseo.mission-control": "commander" },
        }),
        archiveAgent,
        archiveSnapshot: vi.fn(async () => ({ id: "commander-stale" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
        get: async () => ({
          id: "commander-stale",
          labels: {
            "paseo.mission-control": "commander",
            [COMMANDER_HASH_LABEL_KEY]: "stale-hash",
          },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("commander-new");
    expect(archiveAgent).toHaveBeenCalledWith("commander-stale");
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.labels[COMMANDER_HASH_LABEL_KEY]).toBe(computeCommanderBuildHash());
    // Spawn-first swap: the fresh Commander must be live before the stale one
    // is archived, so a failed spawn keeps the old one running.
    expect(vi.mocked(input.createAgent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(archiveAgent).mock.invocationCallOrder[0],
    );
  });

  test("archives a pre-hash Commander (no stored hash) and spawns fresh", async () => {
    const archiveSnapshot = vi.fn(async () => ({ id: "commander-legacy" }));
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot,
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [
          {
            id: "commander-legacy",
            labels: { "paseo.mission-control": "commander" },
            archivedAt: null,
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
        get: async () => ({
          id: "commander-legacy",
          labels: { "paseo.mission-control": "commander" },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("commander-new");
    expect(archiveSnapshot).toHaveBeenCalledWith("commander-legacy", expect.any(String));
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    // Spawn-first swap: create before archive (drift recreate keeps the old
    // Commander live until the fresh one is up).
    expect(vi.mocked(input.createAgent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(archiveSnapshot).mock.invocationCallOrder[0],
    );
  });

  test("keeps the stale Commander and emits a Needs-you card when the drifted recreate fails", async () => {
    const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const createAgent = vi.fn().mockRejectedValue(new Error("Provider claude is disabled"));
    const publishEvent = vi.fn();
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [
          {
            id: "commander-stale",
            labels: {
              "paseo.mission-control": "commander",
              [COMMANDER_HASH_LABEL_KEY]: "stale-hash",
            },
          },
        ],
        getAgent: () => ({
          id: "commander-stale",
          labels: { "paseo.mission-control": "commander" },
        }),
        archiveAgent,
        archiveSnapshot: vi.fn(async () => ({ id: "commander-stale" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
        get: async () => ({
          id: "commander-stale",
          labels: {
            "paseo.mission-control": "commander",
            [COMMANDER_HASH_LABEL_KEY]: "stale-hash",
          },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
      createAgent: createAgent as EnsureCommanderOnBootInput["createAgent"],
      publishEvent,
    });
    const result = await ensureCommanderOnBoot(input);
    // The stale Commander is kept — the fleet never loses its Commander.
    expect(result).toEqual({ created: false, agentId: "commander-stale" });
    expect(archiveAgent).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    // The actual spawn error surfaces as a Needs-you card on the old agent.
    expect(publishEvent).toHaveBeenCalledWith({
      agentId: "commander-stale",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Commander recreate failed — Provider claude is disabled",
    });
  });

  test("migrates a legacy home-dir commander workspace on boot and provisions the reserved home", async () => {
    // The pre-M2 world: a commander workspace rooted at the old home (`~` —
    // the live collision where a user project at `~` surfaced the Commander)
    // with a live commander agent inside it.
    const legacy = createWorkspaceRecord({
      workspaceId: "wks_legacy",
      cwd: HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([legacy]);
    const legacyRecord = {
      id: "commander-legacy",
      labels: { "paseo.mission-control": "commander" },
      workspaceId: "wks_legacy",
      archivedAt: null as string | null,
      lastStatus: "closed",
      config: { provider: "codex", cwd: "/repo" },
    };
    const archiveSnapshot = vi.fn(async (agentId: string, archivedAt: string) => {
      legacyRecord.archivedAt = archivedAt;
      return { id: agentId };
    });
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      agentManager: {
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot,
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [legacyRecord],
        get: async () => (legacyRecord.archivedAt ? null : legacyRecord),
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    // The legacy workspace AND its commander agent are retired in one
    // migration (cascade), then the drift-recreate machinery spawns fresh.
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("commander-new");
    expect(harness.records.get("wks_legacy")?.archivedAt).not.toBeNull();
    expect(archiveSnapshot).toHaveBeenCalledWith("commander-legacy", expect.any(String));
    // The fresh Commander is provisioned cleanly in the reserved home.
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.workspaceId).toBe("wks_home_1");
    expect(createCall.cwd).toBe(COMMANDER_HOME_CWD);
    expect(createCall.config.cwd).toBe(COMMANDER_HOME_CWD);
    expect(harness.records.get("wks_home_1")).toMatchObject({
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
  });
});

describe("resetCommander", () => {
  test("spawns a fresh Commander first, then archives the current one", async () => {
    const archiveSnapshot = vi.fn(async () => ({ id: "commander-1" }));
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot,
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [
          {
            id: "commander-1",
            labels: { "paseo.mission-control": "commander" },
            archivedAt: null,
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
        get: async () => ({
          id: "commander-1",
          labels: { "paseo.mission-control": "commander" },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
    });
    const result = await resetCommander(input);
    expect(result).toEqual({ ok: true, agentId: "commander-new" });
    expect(archiveSnapshot).toHaveBeenCalledWith("commander-1", expect.any(String));
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.labels[COMMANDER_HASH_LABEL_KEY]).toBe(computeCommanderBuildHash());
    expect(createCall.initialPrompt).toContain("# Fleet state as of ");
    // Spawn-first swap: the fresh Commander is live before the current one is
    // archived, so a failed spawn keeps the old one.
    expect(vi.mocked(input.createAgent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(archiveSnapshot).mock.invocationCallOrder[0],
    );
  });

  test("spawns fresh without archiving when no Commander exists", async () => {
    const input = bootInput({ centralConfig: designatedCentralConfig });
    const result = await resetCommander(input);
    expect(result).toEqual({ ok: true, agentId: "commander-new" });
    expect(input.agentManager.archiveAgent).not.toHaveBeenCalled();
    expect(input.createAgent).toHaveBeenCalledTimes(1);
  });

  test("refuses reset when NO host is designated", async () => {
    const input = bootInput();
    const result = await resetCommander(input);
    expect(result).toEqual({
      ok: false,
      error: "No Commander host designated — pick one in Mission Control settings",
    });
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("fails on a host that is not the designated commander host", async () => {
    const input = bootInput({
      centralConfig: () => ({
        commanderHost: "other-host",
        commanderModel: null,
        commanderInstructions: "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: null,
        silenceNudgeSeconds: 120,
        statusNudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    });
    const result = await resetCommander(input);
    expect(result.ok).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("keeps the current Commander and emits a Needs-you card when the reset spawn fails", async () => {
    const archiveSnapshot = vi.fn(async () => ({ id: "commander-1" }));
    const createAgent = vi.fn().mockRejectedValue(new Error("Provider claude is disabled"));
    const publishEvent = vi.fn();
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      agentManager: {
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot,
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [
          {
            id: "commander-1",
            labels: { "paseo.mission-control": "commander" },
            archivedAt: null,
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
        get: async () => ({
          id: "commander-1",
          labels: { "paseo.mission-control": "commander" },
          archivedAt: null,
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        }),
      } as unknown as AgentStorage,
      createAgent: createAgent as EnsureCommanderOnBootInput["createAgent"],
      publishEvent,
    });
    const result = await resetCommander(input);
    expect(result).toEqual({ ok: false, error: "Provider claude is disabled" });
    // The current Commander survives a failed reset — nothing is archived.
    expect(archiveSnapshot).not.toHaveBeenCalled();
    expect(input.agentManager.archiveAgent).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    // The actual spawn error surfaces as a Needs-you card on the old agent.
    expect(publishEvent).toHaveBeenCalledWith({
      agentId: "commander-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Commander recreate failed — Provider claude is disabled",
    });
  });
});

describe("resolveOrCreateCommanderWorkspace", () => {
  test("provisions one home workspace with the stable host-derived title when none exists", async () => {
    const harness = workspaceRegistryHarness();
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: null,
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_home_1");
    expect(harness.records.size).toBe(1);
    expect(harness.records.get("wks_home_1")).toMatchObject({
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
  });

  test("creates the reserved home directory seam when provisioning a fresh workspace", async () => {
    const harness = workspaceRegistryHarness();
    const ensureCommanderHomeDir = vi.fn();
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      ensureCommanderHomeDir,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: null,
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_home_1");
    expect(ensureCommanderHomeDir).toHaveBeenCalledTimes(1);
  });

  test("does not create the reserved home directory when reusing an existing workspace", async () => {
    const existing = createWorkspaceRecord({
      workspaceId: "wks_existing",
      cwd: COMMANDER_HOME_CWD,
      title: "Commander (mac-work)",
    });
    const harness = workspaceRegistryHarness([existing]);
    const ensureCommanderHomeDir = vi.fn();
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      ensureCommanderHomeDir,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: null,
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_existing");
    expect(ensureCommanderHomeDir).not.toHaveBeenCalled();
  });

  test("reuses the existing non-archived home workspace and never provisions a second record", async () => {
    const existing = createWorkspaceRecord({
      workspaceId: "wks_existing",
      cwd: COMMANDER_HOME_CWD,
      title: "Commander (mac-work)",
    });
    const harness = workspaceRegistryHarness([existing]);
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: null,
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_existing");
    expect(harness.records.size).toBe(1);
    expect(harness.records.get("wks_existing")?.title).toBe("Commander (mac-work)");
  });

  test("stabilizes a reused home workspace whose title is still the <paseo-system> marker", async () => {
    const existing = createWorkspaceRecord({
      workspaceId: "wks_leaky",
      cwd: COMMANDER_HOME_CWD,
      title: "<paseo-system>",
    });
    const harness = workspaceRegistryHarness([existing]);
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: "work server",
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_leaky");
    expect(harness.records.get("wks_leaky")?.title).toBe("Commander (work server)");
    expect(harness.records.size).toBe(1);
  });

  test("reuses the alias in the stable title when one is set", async () => {
    const harness = workspaceRegistryHarness();
    const workspaceId = await resolveOrCreateCommanderWorkspace({
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
      paseoHome: TEST_PASEO_HOME,
      hostName: "mac-work",
      hostAlias: "work server",
      logger: createTestLogger(),
    });
    expect(workspaceId).toBe("wks_home_1");
    expect(harness.records.get("wks_home_1")?.title).toBe("Commander (work server)");
  });
});

describe("archiveOrphanCommanderWorkspaces", () => {
  const SELF_HEAL_INPUT = {
    paseoHome: TEST_PASEO_HOME,
    hostName: "mac-work",
    hostAlias: null,
  };

  function storedAgent(workspaceId: string | undefined, archivedAt: string | null = null) {
    return {
      id: `agent-${workspaceId ?? "none"}`,
      cwd: "/Users/vaibhav",
      workspaceId,
      archivedAt,
    } as unknown as { id: string; workspaceId?: string; archivedAt: string | null };
  }

  test("archives a <paseo-system>-titled home workspace with no live agent", async () => {
    const orphan = createWorkspaceRecord({
      workspaceId: "wks_orphan",
      cwd: COMMANDER_HOME_CWD,
      title: "<paseo-system>",
    });
    const harness = workspaceRegistryHarness([orphan]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: { list: async () => [] } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(1);
    expect(harness.records.get("wks_orphan")?.archivedAt).not.toBeNull();
  });

  test("archives a stable-titled 'Commander (host)' home workspace when orphaned", async () => {
    const orphan = createWorkspaceRecord({
      workspaceId: "wks_stable_orphan",
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([orphan]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: { list: async () => [] } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(1);
    expect(harness.records.get("wks_stable_orphan")?.archivedAt).not.toBeNull();
  });

  test("never archives a stable-titled home workspace while its Commander lives", async () => {
    const live = createWorkspaceRecord({
      workspaceId: "wks_stable_live",
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([live]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: {
        list: async () => [storedAgent(live.workspaceId)],
      } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(0);
    expect(harness.records.get("wks_stable_live")?.archivedAt).toBeNull();
  });

  test("leaves a <paseo-system> home workspace alone when an unarchived agent references it", async () => {
    const live = createWorkspaceRecord({
      workspaceId: "wks_live",
      cwd: COMMANDER_HOME_CWD,
      title: "<paseo-system>",
    });
    const harness = workspaceRegistryHarness([live]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: {
        list: async () => [storedAgent(live.workspaceId)],
      } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(0);
    expect(harness.records.get("wks_live")?.archivedAt).toBeNull();
  });

  test("leaves a <paseo-system> home workspace alone when only an ARCHIVED agent references it", async () => {
    // A workspace whose commander was archived on reset is still an orphan and
    // must be archived — archived agents do not keep a workspace "live".
    const orphan = createWorkspaceRecord({
      workspaceId: "wks_orphan2",
      cwd: COMMANDER_HOME_CWD,
      title: "<paseo-system>",
    });
    const harness = workspaceRegistryHarness([orphan]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: {
        list: async () => [storedAgent(orphan.workspaceId, "2026-01-01T00:00:00.000Z")],
      } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(1);
    expect(harness.records.get("wks_orphan2")?.archivedAt).not.toBeNull();
  });

  test("leaves real workspaces alone: other titles, other cwds, already archived", async () => {
    const realTitle = createWorkspaceRecord({
      workspaceId: "wks_real_title",
      cwd: HOME_CWD,
      title: "My real work",
    });
    const otherCwd = createWorkspaceRecord({
      workspaceId: "wks_other_cwd",
      cwd: "/Users/vaibhav/paseo",
      title: "<paseo-system>",
    });
    const alreadyArchived = createWorkspaceRecord({
      workspaceId: "wks_archived",
      title: "<paseo-system>",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const harness = workspaceRegistryHarness([realTitle, otherCwd, alreadyArchived]);
    const archived = await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: harness,
      agentStorage: { list: async () => [] } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    });
    expect(archived).toBe(0);
    expect(harness.records.get("wks_real_title")?.archivedAt).toBeNull();
    expect(harness.records.get("wks_other_cwd")?.archivedAt).toBeNull();
    // Already archived stays archived, untouched.
    expect(harness.records.get("wks_archived")?.archivedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("is idempotent: a second run archives nothing", async () => {
    const orphan = createWorkspaceRecord({
      workspaceId: "wks_orphan",
      cwd: COMMANDER_HOME_CWD,
      title: "<paseo-system>",
    });
    const harness = workspaceRegistryHarness([orphan]);
    const input = {
      workspaceRegistry: harness,
      agentStorage: { list: async () => [] } as unknown as Pick<AgentStorage, "list">,
      ...SELF_HEAL_INPUT,
      logger: createTestLogger(),
    };
    expect(await archiveOrphanCommanderWorkspaces(input)).toBe(1);
    expect(await archiveOrphanCommanderWorkspaces(input)).toBe(0);
  });
});

describe("migrateLegacyCommanderHomeWorkspaces", () => {
  const MIGRATION_INPUT = {
    paseoHome: TEST_PASEO_HOME,
    hostName: "mac-work",
    hostAlias: null,
  };

  function storedAgentRecord(
    agentId: string,
    workspaceId: string,
    archivedAt: string | null = null,
  ) {
    return { id: agentId, workspaceId, archivedAt } as unknown as {
      id: string;
      workspaceId?: string;
      archivedAt: string | null;
    };
  }

  test("archives a legacy commander workspace at the old home, cascading to its agents", async () => {
    const legacy = createWorkspaceRecord({
      workspaceId: "wks_legacy",
      cwd: HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([legacy]);
    const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const archiveSnapshot = vi.fn(async () => ({ id: "agent-stored" }));
    const migrated = await migrateLegacyCommanderHomeWorkspaces({
      workspaceRegistry: harness,
      agentManager: {
        getAgent: (agentId: string) => (agentId === "agent-live" ? { id: agentId } : null),
        archiveAgent,
        archiveSnapshot,
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [
          storedAgentRecord("agent-live", "wks_legacy"),
          storedAgentRecord("agent-stored", "wks_legacy"),
          storedAgentRecord("agent-other-ws", "wks_elsewhere"),
          storedAgentRecord("agent-archived", "wks_legacy", "2026-01-01T00:00:00.000Z"),
        ],
      } as unknown as Pick<AgentStorage, "list">,
      ...MIGRATION_INPUT,
      logger: createTestLogger(),
    });
    expect(migrated).toBe(1);
    expect(harness.records.get("wks_legacy")?.archivedAt).not.toBeNull();
    // Cascade: the live agent goes through the manager, the stored-only one
    // through archiveSnapshot; other workspaces and archived agents untouched.
    expect(archiveAgent).toHaveBeenCalledWith("agent-live");
    expect(archiveSnapshot).toHaveBeenCalledWith("agent-stored", expect.any(String));
    expect(archiveAgent).not.toHaveBeenCalledWith("agent-other-ws");
    expect(archiveSnapshot).not.toHaveBeenCalledWith("agent-archived", expect.any(String));
  });

  test("is idempotent: the same legacy workspace is archived exactly once", async () => {
    const legacy = createWorkspaceRecord({
      workspaceId: "wks_legacy",
      cwd: HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([legacy]);
    const input = {
      workspaceRegistry: harness,
      agentManager: {
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => ({ id: "agent" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
      } as unknown as Pick<AgentStorage, "list">,
      ...MIGRATION_INPUT,
      logger: createTestLogger(),
    };
    expect(await migrateLegacyCommanderHomeWorkspaces(input)).toBe(1);
    expect(await migrateLegacyCommanderHomeWorkspaces(input)).toBe(0);
    expect(harness.records.get("wks_legacy")?.archivedAt).not.toBeNull();
  });

  test("never touches non-commander workspaces", async () => {
    const userWork = createWorkspaceRecord({
      workspaceId: "wks_user_home",
      cwd: HOME_CWD,
      title: "My real work",
    });
    const commanderElsewhere = createWorkspaceRecord({
      workspaceId: "wks_elsewhere",
      cwd: "/Users/vaibhav/paseo",
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const archivedLegacy = createWorkspaceRecord({
      workspaceId: "wks_archived_legacy",
      cwd: HOME_CWD,
      title: "<paseo-system>",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const harness = workspaceRegistryHarness([userWork, commanderElsewhere, archivedLegacy]);
    const migrated = await migrateLegacyCommanderHomeWorkspaces({
      workspaceRegistry: harness,
      agentManager: {
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => ({ id: "agent" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
      } as unknown as Pick<AgentStorage, "list">,
      ...MIGRATION_INPUT,
      logger: createTestLogger(),
    });
    expect(migrated).toBe(0);
    expect(harness.records.get("wks_user_home")?.archivedAt).toBeNull();
    expect(harness.records.get("wks_elsewhere")?.archivedAt).toBeNull();
    expect(harness.records.get("wks_archived_legacy")?.archivedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("never matches the new reserved home", async () => {
    const currentHome = createWorkspaceRecord({
      workspaceId: "wks_current",
      cwd: COMMANDER_HOME_CWD,
      title: commanderHomeWorkspaceTitle("mac-work", null),
    });
    const harness = workspaceRegistryHarness([currentHome]);
    const migrated = await migrateLegacyCommanderHomeWorkspaces({
      workspaceRegistry: harness,
      agentManager: {
        getAgent: () => null,
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => ({ id: "agent" })),
      } as unknown as AgentManager,
      agentStorage: {
        list: async () => [],
      } as unknown as Pick<AgentStorage, "list">,
      ...MIGRATION_INPUT,
      logger: createTestLogger(),
    });
    expect(migrated).toBe(0);
    expect(harness.records.get("wks_current")?.archivedAt).toBeNull();
  });
});

describe("spawnCommander workspace reuse", () => {
  test("a reset respawn reuses the existing home workspace — no second record, same workspaceId", async () => {
    const existing = createWorkspaceRecord({
      workspaceId: "wks_home",
      cwd: COMMANDER_HOME_CWD,
      title: "Commander (mac-work)",
    });
    const harness = workspaceRegistryHarness([existing]);
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
    });
    const first = await spawnCommander(input);
    expect(first.agentId).toBe("commander-new");
    const second = await spawnCommander(input);
    expect(second.agentId).toBe("commander-new");
    expect(input.createAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(input.createAgent).mock.calls[0][0];
    const secondCall = vi.mocked(input.createAgent).mock.calls[1][0];
    expect(firstCall.workspaceId).toBe("wks_home");
    expect(secondCall.workspaceId).toBe("wks_home");
    expect(harness.records.size).toBe(1);
  });

  test("a respawn with no existing home workspace provisions exactly one, reused on the second spawn", async () => {
    const harness = workspaceRegistryHarness();
    const input = bootInput({
      centralConfig: designatedCentralConfig,
      workspaceRegistry: harness,
      createCommanderWorkspace: harness.createCommanderWorkspace,
    });
    await spawnCommander(input);
    await spawnCommander(input);
    expect(input.createAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(input.createAgent).mock.calls[0][0];
    const secondCall = vi.mocked(input.createAgent).mock.calls[1][0];
    expect(firstCall.workspaceId).toBe("wks_home_1");
    expect(secondCall.workspaceId).toBe(firstCall.workspaceId);
    expect(harness.records.size).toBe(1);
  });
});

describe("remapLegacyCommanderCreateCwd", () => {
  const REMAP_INPUT = { paseoHome: TEST_PASEO_HOME };

  test("redirects a commander-labeled create with the legacy `~` sentinel to the reserved home", () => {
    const remapped = remapLegacyCommanderCreateCwd({
      labels: { "paseo.mission-control": "commander" },
      requestedCwd: HOME_CWD,
      ...REMAP_INPUT,
    });
    expect(remapped).toBe(COMMANDER_HOME_CWD);
  });

  test("creates the reserved home directory when redirecting", () => {
    const reservedHome = remapLegacyCommanderCreateCwd({
      labels: { "paseo.mission-control": "commander" },
      requestedCwd: HOME_CWD,
      ...REMAP_INPUT,
    });
    expect(reservedHome).toBe(COMMANDER_HOME_CWD);
    // The mkdir side effect targets the synthetic test home, never the real
    // `~/.paseo` — the daemon's own home is off-limits to the dev stack.
    expect(existsSync(COMMANDER_HOME_CWD)).toBe(true);
    rmSync(COMMANDER_HOME_CWD, { recursive: true, force: true });
  });

  test("leaves a non-commander create at its requested cwd", () => {
    const cwd = remapLegacyCommanderCreateCwd({
      labels: { project: "payments" },
      requestedCwd: "/Users/vaibhav",
      ...REMAP_INPUT,
    });
    expect(cwd).toBe("/Users/vaibhav");
  });

  test("leaves a commander-labeled create with an explicit cwd untouched", () => {
    const cwd = remapLegacyCommanderCreateCwd({
      labels: { "paseo.mission-control": "commander" },
      requestedCwd: COMMANDER_HOME_CWD,
      ...REMAP_INPUT,
    });
    expect(cwd).toBe(COMMANDER_HOME_CWD);
  });
});

describe("Commander build-hash contract", () => {
  test("the tool allowlist pins exactly the twenty-five tools (the Commander's full catalog surface)", () => {
    // The hash covers prompt + allowlist, so a tool landing here without the
    // paseo-tools registration (or vice versa) must fail this pin — the
    // allowlist is the Commander's full catalog surface. The legacy fleet_meta
    // alias is deliberately NOT on the allowlist (04 meta split — the 11 flat
    // per-action tools replace it; the alias stays registered for MCP).
    expect([...COMMANDER_TOOL_ALLOWLIST]).toEqual([
      "fleet_list_agents",
      "fleet_list_models",
      "fleet_list_inventory",
      "fleet_create_agent",
      "fleet_send_prompt",
      "fleet_get_agent_activity",
      "fleet_search",
      "tag_message",
      "clarify",
      "post_answer",
      "fleet_rename_project",
      "fleet_rename_workspace",
      "fleet_rename_agent_title",
      "fleet_archive_project",
      "fleet_archive_workspace",
      "fleet_archive_agent",
      "fleet_create_project",
      "fleet_move_agent",
      "fleet_promote_workspace",
      "fleet_adopt_agent",
      "fleet_release_agent",
      "fleet_recall",
      "fleet_context",
      "fleet_agent_status",
      "fleet_monitor",
    ]);
  });

  test("the build hash derives from prompt + allowlist and is stable for the current build", () => {
    const hash = computeCommanderBuildHash();
    // Deterministic: same build, same hash — twice.
    expect(computeCommanderBuildHash()).toBe(hash);
    // The hash input includes the shipped prompt (not just the allowlist), so
    // a contract edit moves the hash and the drift auto-recreate re-spawns.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
