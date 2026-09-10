import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("restores provider subagents from history after a daemon restart resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-subagents-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const agentId = "00000000-0000-4000-8000-000000000303";

  class ProviderChildHistorySession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = {
      supportsStreaming: false,
      supportsSessionPersistence: true,
      supportsSessionListing: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    } as const;
    constructor(private readonly cwd: string) {}
    async run() {
      return { sessionId: agentId, finalText: "", timeline: [] };
    }
    async startTurn() {
      return { turnId: "turn-1" };
    }
    subscribe() {
      return () => undefined;
    }
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "provider_subagent",
        provider: "codex",
        event: {
          type: "upsert",
          id: "restored-child",
          title: "Restored child",
          status: "completed",
        },
      };
    }
    async getRuntimeInfo() {
      return { provider: this.provider, sessionId: agentId, model: null, modeId: null };
    }
    async getAvailableModes() {
      return [];
    }
    async getCurrentMode() {
      return null;
    }
    async setMode() {}
    getPendingPermissions() {
      return [];
    }
    async respondToPermission() {}
    describePersistence() {
      return { provider: this.provider, sessionId: "codex-session-1" };
    }
    async interrupt() {}
    async close() {}
  }

  const client: AgentClient = {
    provider: "codex",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: true,
      supportsSessionListing: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    createSession: async (config: AgentSessionConfig): Promise<AgentSession> =>
      new ProviderChildHistorySession(config.cwd),
    resumeSession: async (
      _handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> => new ProviderChildHistorySession(overrides?.cwd ?? root),
    fetchCatalog: async () => ({ models: [], modes: [] }),
    isAvailable: async () => true,
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(agentId);

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });

    expect(manager.listProviderSubagents(agentId)).toEqual([
      expect.objectContaining({
        id: "restored-child",
        parentAgentId: agentId,
        title: "Restored child",
        status: "completed",
      }),
    ]);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
