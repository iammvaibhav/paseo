import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { applyMetaPlan, type MetaActionsDependencies } from "./meta-actions.js";

/**
 * M5 dev-stack e2e receipt: the promote_workspace action applied end-to-end
 * via the SERVICE FUNCTION (applyMetaPlan) against a real daemon — never the
 * UI. A daemon boots with the real registries + agent manager; a throwaway
 * experiments workspace with two stored agents is seeded; promote runs; the
 * before/after record JSON is captured as the receipt; the artifacts are
 * cleaned up.
 *
 * Default home: fresh temp dir (CI-safe, auto-cleaned). Set PASEO_E2E_HOME to
 * boot against a specific home (e.g. the dev stack's .dev/paseo-home) for a
 * live dev-home receipt; the test then removes ONLY the artifacts it created.
 */
const DEV_HOME = process.env.PASEO_E2E_HOME;
const TEMP_HOME_ROOT = DEV_HOME ? null : await mkdtemp(join(tmpdir(), "paseo-m5-e2e-"));
const PASEOS_HOME = DEV_HOME ?? join(TEMP_HOME_ROOT!, ".paseo");
const STATIC_DIR = await mkdtemp(join(tmpdir(), "paseo-m5-e2e-static-"));

// The daemon's PaseoDaemon handle does not expose the registries; construct
// file-backed instances on the same store so the executor sees identical
// records (the service function is the only writer in this test).
const projectsPath = join(PASEOS_HOME, "projects", "projects.json");
const workspacesPath = join(PASEOS_HOME, "projects", "workspaces.json");

const EXP_ROOT = join(PASEOS_HOME, "experiments");
const EXP_WS_CWD = join(EXP_ROOT, "e2e-throwaway");
const EXP_WS_ID = "wks_m5_e2e";
const AGENT_IDS = ["agent-m5-e2e-a", "agent-m5-e2e-b"];

let logger: ReturnType<typeof pino>;
let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
let projectRegistry: FileBackedProjectRegistry;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let deps: MetaActionsDependencies;
let experimentsProjectId: string;

async function seedStoredAgent(agentId: string): Promise<StoredAgentRecord> {
  const now = new Date().toISOString();
  const record: StoredAgentRecord = {
    id: agentId,
    cwd: EXP_WS_CWD,
    workspaceId: EXP_WS_ID,
    createdAt: now,
    updatedAt: now,
    title: `E2E worker ${agentId}`,
    name: agentId === AGENT_IDS[0] ? "glowing-otter" : "curious-crab",
    shortDescription: "throwaway e2e agent",
    labels: {},
    lastStatus: "closed",
  };
  await daemon.agentStorage.upsert(record);
  return record;
}

async function readAgentJson(agentId: string): Promise<unknown> {
  const record = await daemon.agentStorage.get(agentId);
  if (!record) {
    throw new Error(`agent ${agentId} missing after ${record}`);
  }
  return record;
}

beforeAll(async () => {
  logger = pino({ level: "silent" });
  await mkdir(join(PASEOS_HOME, "projects"), { recursive: true });
  await mkdir(EXP_WS_CWD, { recursive: true });
  await writeFile(join(PASEOS_HOME, "server-id"), "server-m5-e2e");

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

  projectRegistry = new FileBackedProjectRegistry(projectsPath, logger);
  workspaceRegistry = new FileBackedWorkspaceRegistry(workspacesPath, logger);
  await projectRegistry.initialize();
  await workspaceRegistry.initialize();

  // Seed: experiments project at <home>/experiments (displayName fallback so
  // dev stacks outside ~/experiments still resolve), throwaway workspace in
  // it, two stored agents. The allocated project id is the one the workspace
  // must belong to.
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
  for (const agentId of AGENT_IDS) {
    await seedStoredAgent(agentId);
  }

  deps = {
    serverId: "server-m5-e2e",
    hostName: "e2e-host",
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
      const archived: StoredAgentRecord = {
        ...(record ?? {
          id: agentId,
          cwd: EXP_WS_CWD,
          workspaceId: EXP_WS_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          title: agentId,
          labels: {},
          lastStatus: "closed",
        }),
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await daemon.agentStorage.upsert(archived);
      return { agentId, archivedAt: archived.archivedAt!, record: archived };
    },
    emitStoredAgentUpdate: async () => undefined,
    mkdirp: (dirPath) => mkdir(dirPath, { recursive: true }),
  };
});

afterAll(async () => {
  // Cleanup: remove ONLY the artifacts this test created.
  await workspaceRegistry.remove(EXP_WS_ID).catch(() => undefined);
  await projectRegistry.remove(experimentsProjectId).catch(() => undefined);
  await projectRegistry
    .remove(`prj_${resolve(EXP_WS_CWD).replace(/[/:]/g, "_")}`)
    .catch(() => undefined);
  for (const agentId of AGENT_IDS) {
    await daemon.agentStorage.remove(agentId).catch(() => undefined);
  }
  await rm(EXP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await daemon.stop().catch(() => undefined);
  if (!DEV_HOME) {
    await rm(TEMP_HOME_ROOT!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(STATIC_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe("promote_workspace dev-stack e2e (service function, no UI)", () => {
  test("creates a project, moves the workspace + agents, records intact", async () => {
    const beforeProject = await projectRegistry.get(experimentsProjectId);
    const beforeWorkspace = await workspaceRegistry.get(EXP_WS_ID);
    const beforeAgents = await Promise.all(AGENT_IDS.map(readAgentJson));

    const result = await applyMetaPlan(deps, {
      action: "promote_workspace",
      targetId: EXP_WS_ID,
      newValue: "e2e-promoted",
      serverId: "server-m5-e2e",
    });
    expect(result.ok).toBe(true);

    const afterWorkspace = await workspaceRegistry.get(EXP_WS_ID);
    const afterAgents = await Promise.all(AGENT_IDS.map(readAgentJson));
    const promoted = (await projectRegistry.list()).find(
      (candidate) => candidate.rootPath === EXP_WS_CWD && !candidate.archivedAt,
    );

    // Receipt: before/after record JSON (project, workspace, agents).
    const receipt = {
      home: PASEOS_HOME,
      action: "promote_workspace",
      before: {
        experimentsProject: beforeProject,
        workspace: beforeWorkspace,
        agents: beforeAgents,
      },
      after: {
        promotedProject: promoted,
        workspace: afterWorkspace,
        agents: afterAgents,
      },
      assertions: {
        projectCreated: Boolean(promoted),
        workspaceMoved: afterWorkspace?.projectId === promoted?.projectId,
        agentsMoved: afterAgents.every(
          (agent) => (agent as StoredAgentRecord).workspaceId === EXP_WS_ID,
        ),
        experimentsProjectUntouched:
          (await projectRegistry.get(experimentsProjectId))?.archivedAt === null,
      },
    };
    const receiptPath =
      process.env.M5_E2E_RECEIPT ?? join(PASEOS_HOME, "..", "m5-promote-receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    console.log("M5_E2E_RECEIPT_WRITTEN", receiptPath);

    expect(promoted).toBeDefined();
    expect(afterWorkspace?.projectId).toBe(promoted!.projectId);
    expect(afterWorkspace?.cwd).toBe(EXP_WS_CWD);
    for (const agent of afterAgents) {
      expect((agent as StoredAgentRecord).workspaceId).toBe(EXP_WS_ID);
      expect((agent as StoredAgentRecord).name).toBe(
        (
          beforeAgents.find(
            (before) => (before as StoredAgentRecord).id === (agent as StoredAgentRecord).id,
          ) as StoredAgentRecord
        ).name,
      );
    }
    // The experiments project itself is untouched.
    expect((await projectRegistry.get(experimentsProjectId))?.archivedAt).toBeNull();
  });

  test("create_project mkdir -p the destination before registering (no models-error failure mode)", async () => {
    // A nested destination that does NOT exist anywhere yet: the exact shape
    // of the reported bug (record registered, no directory on disk).
    const createdRoot = join(PASEOS_HOME, "created-by-meta", "deep", "test");
    await rm(createdRoot, { recursive: true, force: true });
    await expect(access(createdRoot)).rejects.toThrow();

    const result = await applyMetaPlan(deps, {
      action: "create_project",
      destination: createdRoot,
      newValue: "meta-created",
      serverId: "server-m5-e2e",
    });
    expect(result.ok).toBe(true);

    // The fix: the root directory exists on disk right after apply, BEFORE
    // any provider/model resolution touches it — so opening the project can
    // never hit the missing-cwd models error for new projects.
    await expect(access(createdRoot)).resolves.toBeUndefined();

    const created = (await projectRegistry.list()).find(
      (candidate) => candidate.rootPath === createdRoot && !candidate.archivedAt,
    );
    expect(created).toBeDefined();
    expect(created?.displayName).toBe("meta-created");
    expect(created?.kind).toBe("non_git");

    // Cleanup: remove exactly what this test created.
    await projectRegistry.remove(created!.projectId).catch(() => undefined);
    await rm(join(PASEOS_HOME, "created-by-meta"), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
});
