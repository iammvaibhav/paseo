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
import { FleetIdIndex } from "./fleet-id-index.js";
import { applyMetaFromProposal, type MetaActionsDependencies } from "./meta-actions.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

/**
 * 04 — fleet_meta split e2e: the fleet_rename_agent_title tool round-trips
 * in-process — split tool call → pending proposal card → user approve → the
 * agent's TITLE changes — with a proposal metaPlan identical to what the old
 * fleet_meta alias builds for the same action (both tools registered on the
 * same catalog, both routed through the same approval gate).
 *
 * The daemon handle does not expose Mission Control (bootstrap-internal), so
 * the test wires its own MissionControlService + commander catalog around the
 * REAL daemon's agent manager/storage/registries — the exact wiring bootstrap
 * uses (metaFromProposal → applyMetaFromProposal) — and drives both tools
 * through it.
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
let catalog: ReturnType<typeof createPaseoToolCatalog>;
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
      const record = await daemon.agentStorage.get(agentId);
      return { agentId, archivedAt: new Date().toISOString(), record: record ?? null };
    },
    mkdirp: (dirPath) => mkdir(dirPath, { recursive: true }),
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
    hostAlias: null,
    peerManager: null,
    broadcast: vi.fn() as never,
    presence: createMissionControlPresenceSource({
      isAgentFocused: () => false,
      readStopOrigin: () => null,
    }),
    // Same wiring as bootstrap: approved meta-kind proposals apply through
    // applyMetaFromProposal over the real meta-actions deps.
    metaFromProposal: (proposal) => applyMetaFromProposal(metaActionsDeps(), proposal),
  });
  await service.start();

  catalog = createPaseoToolCatalog({
    agentManager: daemon.agentManager,
    agentStorage: daemon.agentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager as never,
    peerManager: null,
    callerAgentId: "commander-1",
    callerLabels: { [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE },
    serverId: "server-meta-split-e2e",
    hostAlias: null,
    missionControlService: service,
    fleetIdIndex: new FleetIdIndex({
      agentStorage: daemon.agentStorage,
      agentManager: daemon.agentManager,
      workspaceRegistry,
      projectRegistry,
      missionControlService: service,
      peerManager: null,
    }),
    workspaceRegistry,
    projectRegistry,
    logger,
  });
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
  test("split tool: proposal -> approve -> title changed (pending card contract)", async () => {
    const result = await catalog.executeTool("fleet_rename_agent_title", {
      agentId: AGENT_ID,
      title: "Runner Prime",
    });
    expect(result.structuredContent).toMatchObject({ ok: true, status: "pending" });
    const { proposalId } = result.structuredContent as { proposalId: string };
    expect(proposalId).toBeTruthy();

    const proposal = service.getProposal(proposalId);
    expect(proposal?.status).toBe("pending");
    // The metaPlan is exactly what the old fleet_meta carried for
    // rename_agent_title: action, resolved serverId, targetId, the agent's
    // NAME as targetLabel (names are the fleet label; titles are mutable),
    // and the new title.
    expect(proposal?.metaPlan).toEqual({
      action: "rename_agent_title",
      serverId: "local",
      targetId: AGENT_ID,
      targetLabel: "glowing-otter",
      newValue: "Runner Prime",
    });
    // M4 convention: agent-targeted proposals carry the real targetAgentId.
    expect(proposal?.targetAgentId).toBe(AGENT_ID);
    expect(proposal?.kind).toBe("meta");

    const approve = await service.respondProposal({ proposalId, action: "approve" });
    expect(approve).toEqual({ ok: true });

    const after = await daemon.agentStorage.get(AGENT_ID);
    expect(after?.title).toBe("Runner Prime");
    // Names are write-once — untouched.
    expect(after?.name).toBe("glowing-otter");
  });

  test("legacy fleet_meta alias builds the identical metaPlan and applies identically", async () => {
    // The legacy alias takes the fully-qualified plan the old fleet_meta
    // accepted; the split tool resolved the same fields itself.
    const legacyPlan = {
      action: "rename_agent_title",
      serverId: "local",
      targetId: AGENT_ID,
      targetLabel: "glowing-otter",
      newValue: "Runner Legacy",
    };
    const legacyResult = await catalog.executeTool("fleet_meta", { metaPlan: legacyPlan });
    expect(legacyResult.structuredContent).toMatchObject({ ok: true, status: "pending" });
    const legacyId = (legacyResult.structuredContent as { proposalId: string }).proposalId;

    // Same call through the SPLIT tool: identical proposal payloads.
    const splitResult = await catalog.executeTool("fleet_rename_agent_title", {
      agentId: AGENT_ID,
      title: "Runner Legacy",
    });
    const splitId = (splitResult.structuredContent as { proposalId: string }).proposalId;

    const legacyProposal = service.getProposal(legacyId);
    const splitProposal = service.getProposal(splitId);
    expect(legacyProposal?.metaPlan).toEqual(splitProposal?.metaPlan);
    expect(legacyProposal?.metaPlan).toEqual(legacyPlan);

    // The alias still applies through the same gate: approve -> title changed.
    const approve = await service.respondProposal({ proposalId: legacyId, action: "approve" });
    expect(approve).toEqual({ ok: true });
    const after = await daemon.agentStorage.get(AGENT_ID);
    expect(after?.title).toBe("Runner Legacy");
  });
});
