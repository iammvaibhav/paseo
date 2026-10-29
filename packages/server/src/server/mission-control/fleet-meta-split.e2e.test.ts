import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { FleetIdIndex } from "./fleet-id-index.js";
import { applyRoutedMetaPlan, type MetaActionsDependencies } from "./meta-actions.js";
import { MissionControlService } from "./service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

/**
 * Meta tools e2e: the split meta tools apply in-process against the REAL
 * daemon's agent manager/storage/registries, for an agent caller and a remote
 * MCP client alike. The daemon handle does not expose Mission Control
 * (bootstrap-internal), so the test wires its own MissionControlService with
 * the same metaApplyDirect wiring bootstrap uses.
 */
const TEMP_HOME_ROOT = await mkdtemp(join(tmpdir(), "paseo-meta-split-e2e-"));
const PASEOS_HOME = join(TEMP_HOME_ROOT, ".paseo");
const STATIC_DIR = await mkdtemp(join(tmpdir(), "paseo-meta-split-e2e-static-"));

const projectsPath = join(PASEOS_HOME, "projects", "projects.json");
const workspacesPath = join(PASEOS_HOME, "projects", "workspaces.json");

const EXP_ROOT = join(PASEOS_HOME, "experiments");
const EXP_WS_CWD = join(EXP_ROOT, "e2e-throwaway");
const EXP_WS_ID = "wks_5a5a5a5a5a5a5a5a";
const AGENT_ID = "6f4d5e7a-8b9c-4def-8a01-2b3c4d5e6f70";

let logger: ReturnType<typeof pino>;
let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
let projectRegistry: FileBackedProjectRegistry;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let service: MissionControlService;
let catalog: PaseoToolCatalog;
let mcpCatalog: PaseoToolCatalog;
const archiveAgentSpy = vi.fn();
let experimentsProjectId: string;

async function seedAgent(): Promise<StoredAgentRecord> {
  const now = new Date().toISOString();
  const record: StoredAgentRecord = {
    id: AGENT_ID,
    cwd: EXP_WS_CWD,
    workspaceId: EXP_WS_ID,
    createdAt: now,
    updatedAt: now,
    title: "Worker Alpha",
    name: "glowing-otter",
    shortDescription: "throwaway e2e agent",
    provider: "claude",
    labels: {},
    lastStatus: "closed",
  };
  await daemon.agentStorage.upsert(record);
  return record;
}

beforeAll(async () => {
  logger = createTestLogger();
  await mkdir(join(PASEOS_HOME, "projects"), { recursive: true });
  await mkdir(EXP_WS_CWD, { recursive: true });
  await writeFile(join(PASEOS_HOME, "server-id"), "server-meta-split-e2e");

  const config: PaseoDaemonConfig = {
    listen: "127.0.0.1:0",
    paseoHome: PASEOS_HOME,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir: STATIC_DIR,
    mcpDebug: false,
    agentClients: createTestAgentClients(),
    agentStoragePath: join(PASEOS_HOME, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    relayPublicUseTls: true,
    appBaseUrl: "https://app.paseo.sh",
    voiceLlmProvider: null,
    voiceLlmProviderExplicit: false,
    voiceLlmModel: null,
  };
  daemon = await createPaseoDaemon(config, logger, {});
  await daemon.start();

  // Same persisted files the daemon's own registries read; this test's
  // instances seed them, and the catalog/service below use THESE instances.
  projectRegistry = new FileBackedProjectRegistry(projectsPath, logger);
  workspaceRegistry = new FileBackedWorkspaceRegistry(workspacesPath, logger);
  await projectRegistry.initialize();
  await workspaceRegistry.initialize();

  const experimentsProject = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: EXP_ROOT,
    kind: "non_git",
    displayName: "experiments",
    timestamp: new Date().toISOString(),
  });
  experimentsProjectId = experimentsProject.projectId;
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: EXP_WS_ID,
      projectId: experimentsProjectId,
      cwd: EXP_WS_CWD,
      kind: "directory",
      displayName: "e2e-throwaway",
      title: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  await seedAgent();

  const metaActionsDeps = (): MetaActionsDependencies => ({
    serverId: "server-meta-split-e2e",
    hostName: "e2e-host",
    hostAlias: null,
    logger,
    agentManager: daemon.agentManager,
    agentStorage: daemon.agentStorage,
    workspaceRegistry,
    projectRegistry,
    archiveWorkspace: async (workspaceId) => ({
      archivedAgentIds: [],
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    }),
    archiveAgent: async (agentId) => {
      archiveAgentSpy(agentId);
      const record = await daemon.agentStorage.get(agentId);
      return { agentId, archivedAt: new Date().toISOString(), record: record ?? null };
    },
    mkdirp: (dirPath) => mkdir(dirPath, { recursive: true }),
    ensureGitRepository: async () => undefined,
    emitStoredAgentUpdate: async () => undefined,
    peerManager: null,
  });

  service = new MissionControlService({
    paseoHome: PASEOS_HOME,
    logger,
    agentManager: daemon.agentManager,
    agentStorage: daemon.agentStorage,
    daemonConfigStore: { get: () => ({}) } as never,
    serverId: "server-meta-split-e2e",
    hostName: "e2e-host",
    peerManager: null,
    broadcast: vi.fn() as never,
    metaApplyDirect: (plan) => applyRoutedMetaPlan(metaActionsDeps(), plan, "mcp-direct"),
  });
  await service.start();

  const fleetIdIndex = new FleetIdIndex({
    agentStorage: daemon.agentStorage,
    agentManager: daemon.agentManager,
    workspaceRegistry,
    projectRegistry,
    peerManager: null,
  });
  const catalogFor = (callerLabels: Record<string, string>) =>
    createPaseoToolCatalog({
      agentManager: daemon.agentManager,
      agentStorage: daemon.agentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager as never,
      peerManager: null,
      callerAgentId: "worker-1",
      callerLabels,
      serverId: "server-meta-split-e2e",
      hostAlias: null,
      missionControlService: service,
      fleetIdIndex,
      workspaceRegistry,
      projectRegistry,
      logger,
    });
  catalog = catalogFor({});
  // A remote /mcp/fleet client, labeled exactly as bootstrap builds it.
  mcpCatalog = catalogFor({ "paseo.mcp-client": "grok-bot" });
});

afterAll(async () => {
  await workspaceRegistry.remove(EXP_WS_ID).catch(() => undefined);
  await projectRegistry.remove(experimentsProjectId).catch(() => undefined);
  await daemon.agentStorage.remove(AGENT_ID).catch(() => undefined);
  await service.stop().catch(() => undefined);
  await rm(EXP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await daemon.stop().catch(() => undefined);
  await rm(TEMP_HOME_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(STATIC_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("04 fleet_rename_agent_title in-process daemon round-trip", () => {
  test("an agent caller's rename applies directly; names stay write-once", async () => {
    const result = await catalog.executeTool("fleet_rename_agent_title", {
      agentId: AGENT_ID,
      title: "Runner Prime",
    });
    expect(result.structuredContent).toMatchObject({ ok: true, status: "applied" });
    const after = await daemon.agentStorage.get(AGENT_ID);
    expect(after?.title).toBe("Runner Prime");
    expect(after?.name).toBe("glowing-otter");
  });
});

describe("remote MCP clients", () => {
  test("a rename and a destructive archive apply directly", async () => {
    const rename = await mcpCatalog.executeTool("fleet_rename_agent_title", {
      agentId: AGENT_ID,
      title: "Runner MCP",
    });
    expect(rename.structuredContent).toMatchObject({ ok: true, status: "applied" });
    expect((await daemon.agentStorage.get(AGENT_ID))?.title).toBe("Runner MCP");

    const preview = await mcpCatalog.executeTool("fleet_archive_agent", {
      agentId: AGENT_ID,
      dryRun: true,
    });
    expect(preview.structuredContent).toMatchObject({
      ok: true,
      status: "dry_run",
      wouldArchive: { action: "archive_agent", agents: [{ id: AGENT_ID, blockers: [] }] },
    });
    expect(archiveAgentSpy).not.toHaveBeenCalled();

    const archive = await mcpCatalog.executeTool("fleet_archive_agent", { agentId: AGENT_ID });
    expect(archive.structuredContent).toMatchObject({ ok: true, status: "applied" });
    expect(archiveAgentSpy).toHaveBeenCalledWith(AGENT_ID);
  });
});
