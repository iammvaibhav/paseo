import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  ensureCommanderOnBoot,
  COMMANDER_TOOL_ALLOWLIST,
  type EnsureCommanderOnBootInput,
} from "./commander-boot.js";
import type { FleetContextDependencies } from "./context.js";

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
  return {
    logger: createTestLogger(),
    agentManager: {
      listAgents: () => [],
    } as unknown as AgentManager,
    agentStorage: {
      list: async () => [],
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
      nudgeSeconds: 120,
      escalateSeconds: 300,
    }),
    launchContext: minimalLaunchContext(),
    hostName: "mac-work",
    hostAlias: null,
    ...overrides,
  };
}

describe("ensureCommanderOnBoot", () => {
  test("creates the Commander when this host is designated (null commanderHost = self-designate)", async () => {
    const input = bootInput();
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
    expect(input.createAgent).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.labels).toEqual({ "paseo.mission-control": "commander" });
    expect(createCall.title).toBe("Commander");
    expect(createCall.config.systemPromptMode).toBe("replace");
    expect(createCall.config.toolAllowlist).toEqual([...COMMANDER_TOOL_ALLOWLIST]);
    // First message = context pack snapshot, not the system prompt.
    expect(createCall.initialPrompt).toContain("Fleet context snapshot:");
    expect(createCall.initialPrompt).toContain("Fleet map");
    expect(createCall.config.systemPrompt).not.toContain("Fleet map");
  });

  test("honors the central commanderModel override", async () => {
    const input = bootInput({
      centralConfig: () => ({
        commanderHost: null,
        commanderModel: "fast-omp/fast-model",
        commanderInstructions: "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: null,
        nudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    });
    await ensureCommanderOnBoot(input);
    const createCall = vi.mocked(input.createAgent).mock.calls[0][0];
    expect(createCall.provider).toBe("fast-omp");
    expect(createCall.config.model).toBe("fast-model");
  });

  test("does not create a second Commander when one is live", async () => {
    const input = bootInput({
      agentManager: {
        listAgents: () => [{ id: "commander-1", labels: { "paseo.mission-control": "commander" } }],
      } as unknown as AgentManager,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("does not create when an unarchived Commander record exists", async () => {
    const input = bootInput({
      agentStorage: {
        list: async () => [
          {
            id: "commander-stored",
            labels: { "paseo.mission-control": "commander" },
            archivedAt: null,
            lastStatus: "closed",
            config: { provider: "codex", cwd: "/repo" },
          },
        ],
      } as unknown as AgentStorage,
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(false);
    expect(input.createAgent).not.toHaveBeenCalled();
  });

  test("creates when only an archived Commander record exists", async () => {
    const input = bootInput({
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
        nudgeSeconds: 120,
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
        nudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    });
    const result = await ensureCommanderOnBoot(input);
    expect(result.created).toBe(true);
  });

  test("defers when no provider is registered", async () => {
    const input = bootInput({
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
});
