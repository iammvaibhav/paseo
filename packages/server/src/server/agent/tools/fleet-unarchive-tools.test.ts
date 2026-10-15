import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { MissionControlService } from "../../mission-control/service.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const WORKSPACE_ID = "wks_0123456789abcdef";
const OTHER_WORKSPACE_ID = "wks_fedcba9876543210";
const AGENT_ID = "00000000-0000-4000-8000-00000000a001";
const SIBLING_ID = "00000000-0000-4000-8000-00000000a002";
const VERIFIER_ID = "00000000-0000-4000-8000-00000000a003";
const HISTORY_ASK_ID = "00000000-0000-4000-8000-00000000a004";
const OTHER_WORKSPACE_AGENT_ID = "00000000-0000-4000-8000-00000000a005";
const ACTIVE_ID = "00000000-0000-4000-8000-00000000a006";

interface WorkspaceStub {
  workspaceId: string;
  projectId: string;
  cwd: string;
  archivedAt: string | null;
}

function createHarness(
  options: { workspaceArchived?: boolean; restoreError?: Error; peerManager?: PeerManager } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-unarchive-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const agentManager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
  const archivedAt = options.workspaceArchived ? "2026-10-01T00:00:00.000Z" : null;
  const projectId = "prj_0123456789abcdef";
  const workspaces: Record<string, WorkspaceStub> = {
    [WORKSPACE_ID]: { workspaceId: WORKSPACE_ID, projectId, cwd: root, archivedAt },
    [OTHER_WORKSPACE_ID]: { workspaceId: OTHER_WORKSPACE_ID, projectId, cwd: root, archivedAt },
  };
  const restoreWorkspace = vi.fn(async (workspaceId: string) => {
    if (options.restoreError) {
      throw options.restoreError;
    }
    workspaces[workspaceId]!.archivedAt = null;
  });
  const emitStoredAgentUpdate = vi.fn(async (_record: StoredAgentRecord) => undefined);
  const createProposal = vi.fn();
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage: storage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    workspaceRegistry: {
      get: async (workspaceId: string) => workspaces[workspaceId] ?? null,
      list: async () => Object.values(workspaces),
      upsert: async () => undefined,
    } as never,
    restoreWorkspace,
    emitStoredAgentUpdate,
    ...(options.peerManager ? { peerManager: options.peerManager } : {}),
    // A remote MCP client: Commander identity plus the mcp-client label.
    callerAgentId: "commander-1",
    callerLabels: { "paseo.mission-control": "commander", "paseo.mcp-client": "grok-bot" },
    serverId: "host-a",
    hostAlias: "Personal",
    missionControlService: {
      getCentralConfig: () => ({ commanderToWorkerMode: "queue" }),
      approvals: { createProposal },
    } as unknown as MissionControlService,
    logger,
  });

  async function createArchivedAgent(
    agentId: string,
    input: { workspaceId?: string; labels?: Record<string, string>; archived?: boolean } = {},
  ) {
    await agentManager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: input.workspaceId ?? WORKSPACE_ID,
      ...(input.labels ? { labels: input.labels } : {}),
    });
    if (input.archived !== false) {
      await agentManager.archiveAgent(agentId);
    }
    await agentManager.closeAgent(agentId);
  }

  async function archivedAtOf(agentId: string) {
    return (await storage.get(agentId))?.archivedAt ?? null;
  }

  async function cleanup() {
    await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }

  return {
    catalog,
    agentManager,
    restoreWorkspace,
    emitStoredAgentUpdate,
    createProposal,
    createArchivedAgent,
    archivedAtOf,
    cleanup,
  };
}

describe("fleet_unarchive_agent", () => {
  test("restores an archived agent for an MCP client without a proposal, and fleet_send_prompt then runs it", async () => {
    const harness = createHarness();
    try {
      await harness.createArchivedAgent(AGENT_ID);

      const result = await harness.catalog.executeTool("fleet_unarchive_agent", {
        agentId: AGENT_ID,
      });

      expect(result.structuredContent).toMatchObject({
        ok: true,
        host: "Personal",
        agentId: AGENT_ID,
        unarchived: true,
      });
      expect(result.structuredContent).not.toHaveProperty("restoredWorkspaceId");
      expect(await harness.archivedAtOf(AGENT_ID)).toBeNull();
      // Unarchiving starts no provider; clients learn of it from the stored record.
      expect(harness.agentManager.getAgent(AGENT_ID)).toBeNull();
      expect(harness.emitStoredAgentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: AGENT_ID, archivedAt: null }),
      );

      // Mode omitted → the fleet default (queue here).
      const send = await harness.catalog.executeTool("fleet_send_prompt", {
        agentId: AGENT_ID,
        prompt: "pick this back up",
      });
      expect(send.structuredContent).toMatchObject({
        success: true,
        deliveryMode: "queue",
        runStarted: true,
      });
      expect(harness.createProposal).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  test("brings the agent's archived workspace back and leaves its other agents archived", async () => {
    const harness = createHarness({ workspaceArchived: true });
    try {
      await harness.createArchivedAgent(AGENT_ID);
      await harness.createArchivedAgent(SIBLING_ID);

      const result = await harness.catalog.executeTool("fleet_unarchive_agent", {
        agentId: AGENT_ID,
        host: "local",
      });

      expect(result.structuredContent).toMatchObject({
        ok: true,
        unarchived: true,
        restoredWorkspaceId: WORKSPACE_ID,
      });
      expect(harness.restoreWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(await harness.archivedAtOf(AGENT_ID)).toBeNull();
      expect(await harness.archivedAtOf(SIBLING_ID)).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("leaves the agent archived when its workspace cannot be restored", async () => {
    const harness = createHarness({
      workspaceArchived: true,
      restoreError: new Error(
        "The archived workspace directory no longer exists and cannot be recreated.",
      ),
    });
    try {
      await harness.createArchivedAgent(AGENT_ID);

      const result = await harness.catalog.executeTool("fleet_unarchive_agent", {
        agentId: AGENT_ID,
      });

      expect(result.structuredContent).toMatchObject({
        ok: false,
        agentId: AGENT_ID,
        error: "The archived workspace directory no longer exists and cannot be recreated.",
      });
      expect(await harness.archivedAtOf(AGENT_ID)).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("names the peer when it runs there, and tells the caller to update a peer without the tool", async () => {
    const missionControlToolsExecute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        name: "fleet_unarchive_agent",
        structuredContent: { ok: true, host: "MacBook", agentId: AGENT_ID, unarchived: true },
      })
      .mockResolvedValueOnce({
        ok: false,
        name: "fleet_unarchive_agent",
        error: 'Tool "fleet_unarchive_agent" is not on the Commander allowlist',
      });
    const client = { missionControlToolsExecute } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: (name: string) => (name === "macbook" ? { name, state: "online" } : null),
      getPeerStatuses: () => [{ name: "macbook", state: "online", lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "macbook" ? client : null),
    } as unknown as PeerManager;
    const harness = createHarness({ peerManager });
    try {
      const restored = await harness.catalog.executeTool("fleet_unarchive_agent", {
        agentId: AGENT_ID,
        host: "macbook",
      });
      expect(restored.structuredContent).toMatchObject({
        ok: true,
        host: "macbook",
        agentId: AGENT_ID,
        unarchived: true,
      });

      const outdated = await harness.catalog.executeTool("fleet_unarchive_agent", {
        agentId: AGENT_ID,
        host: "macbook",
      });
      expect(outdated.structuredContent).toMatchObject({
        ok: false,
        host: "macbook",
        error: 'Host "macbook" does not have fleet_unarchive_agent; update Paseo there.',
      });
    } finally {
      await harness.cleanup();
    }
  });
});

describe("fleet_unarchive_workspace", () => {
  test("restores the workspace and its archived agents, not machinery or other workspaces", async () => {
    const harness = createHarness({ workspaceArchived: true });
    try {
      await harness.createArchivedAgent(AGENT_ID);
      await harness.createArchivedAgent(SIBLING_ID);
      await harness.createArchivedAgent(VERIFIER_ID, {
        labels: { "paseo.mission-control": "verifier" },
      });
      await harness.createArchivedAgent(HISTORY_ASK_ID, { labels: { "paseo.history-ask": "1" } });
      await harness.createArchivedAgent(OTHER_WORKSPACE_AGENT_ID, {
        workspaceId: OTHER_WORKSPACE_ID,
      });
      await harness.createArchivedAgent(ACTIVE_ID, { archived: false });

      const result = await harness.catalog.executeTool("fleet_unarchive_workspace", {
        workspaceId: WORKSPACE_ID,
      });

      expect(result.structuredContent).toMatchObject({
        ok: true,
        host: "Personal",
        workspaceId: WORKSPACE_ID,
        restoredWorkspace: true,
        unarchivedAgentIds: expect.arrayContaining([AGENT_ID, SIBLING_ID]),
      });
      expect(result.structuredContent).toHaveProperty("unarchivedAgentIds.length", 2);
      expect(harness.restoreWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(await harness.archivedAtOf(AGENT_ID)).toBeNull();
      expect(await harness.archivedAtOf(SIBLING_ID)).toBeNull();
      expect(await harness.archivedAtOf(VERIFIER_ID)).not.toBeNull();
      expect(await harness.archivedAtOf(HISTORY_ASK_ID)).not.toBeNull();
      expect(await harness.archivedAtOf(OTHER_WORKSPACE_AGENT_ID)).not.toBeNull();
      expect(harness.createProposal).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  test("asks for host when an archived workspace is on no host the index knows", async () => {
    const harness = createHarness();
    try {
      const result = await harness.catalog.executeTool("fleet_unarchive_workspace", {
        workspaceId: "wks_00000000000000aa",
      });

      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: expect.stringMatching(/pass host/),
      });
    } finally {
      await harness.cleanup();
    }
  });
});
