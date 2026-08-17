import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  buildFleetMetaProposalInput,
  buildSplitMetaProposalInput,
  type SplitMetaLookupDependencies,
  type SplitMetaToolArgs,
  type SplitMetaToolDeps,
} from "./fleet-meta.js";
import type { MetaPeerManager } from "./meta-actions.js";
import { COMMANDER_ADOPTED_AT_LABEL, COMMANDER_TOOL_ALLOWLIST } from "./commander-contract.js";
import { formatShortId, type FleetIdResolution } from "./fleet-id-index.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { PeerManager } from "../peers/peer-manager.js";

/**
 * 04 — fleet_meta split tests: the 11 flat per-action tools build the SAME
 * metaPlan proposal payload the old fleet_meta built (zero protocol change),
 * refuse wrong id families and unknown ids with candidate-listing errors
 * (spec 03), and the allowlist drops fleet_meta in favor of the 11 names
 * while the COMPAT alias stays registered (paseo-tools keeps it).
 */

// ---------------------------------------------------------------------------
// Fixtures (realistic id families: prj_/wks_ + 16 hex, agent UUIDs)
// ---------------------------------------------------------------------------

const AGENT_LOCAL = "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a";
const AGENT_ADOPTED = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
const AGENT_PEER = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const AGENT_GHOST = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const WS_A = "wks_0a0a0a0a0a0a0a0a";
const WS_B = "wks_1b1b1b1b1b1b1b1b";
const WS_PEER = "wks_2c2c2c2c2c2c2c2c";
const WS_GHOST = "wks_3d3d3d3d3d3d3d3d";
const PRJ_EXP = "prj_3d3d3d3d3d3d3d3d";
const PRJ_OTHER = "prj_4e4e4e4e4e4e4e4e";

function storedAgent(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: AGENT_LOCAL,
    cwd: "/work/ws-a",
    workspaceId: WS_A,
    createdAt: now,
    updatedAt: now,
    title: "Worker A",
    name: "glowing-otter",
    labels: {},
    lastStatus: "closed",
    ...overrides,
  };
}

function workspace(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    workspaceId: WS_A,
    projectId: PRJ_EXP,
    cwd: "/home/me/experiments/ws-a",
    kind: "directory",
    displayName: "ws-a",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  const now = new Date().toISOString();
  return {
    projectId: PRJ_EXP,
    rootPath: "/home/me/experiments",
    kind: "non_git",
    displayName: "experiments",
    projectKey: null,
    customName: null,
    customIconRevision: null,
    description: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

function buildLookup(
  overrides: {
    projects?: PersistedProjectRecord[];
    workspaces?: PersistedWorkspaceRecord[];
    agents?: StoredAgentRecord[];
  } = {},
): SplitMetaLookupDependencies {
  const agents = new Map(
    (
      overrides.agents ?? [
        storedAgent(),
        storedAgent({
          id: AGENT_ADOPTED,
          name: "curious-crab",
          title: "Worker B",
          labels: { [COMMANDER_ADOPTED_AT_LABEL]: "2026-08-01T00:00:00.000Z" },
        }),
      ]
    ).map((record) => [record.id, record]),
  );
  const workspaces = overrides.workspaces ?? [
    workspace(),
    workspace({ workspaceId: WS_B, cwd: "/home/me/experiments/ws-b", displayName: "ws-b" }),
  ];
  const projects = overrides.projects ?? [project()];
  return {
    agentManager: {
      getAgent: () => null,
    },
    agentStorage: {
      get: async (agentId: string) => agents.get(agentId) ?? null,
      list: async () => [...agents.values()],
    },
    workspaceRegistry: {
      get: async (workspaceId: string) =>
        workspaces.find((record) => record.workspaceId === workspaceId) ?? null,
      list: async () => workspaces,
    },
    projectRegistry: {
      get: async (projectId: string) =>
        projects.find((record) => record.projectId === projectId) ?? null,
      list: async () => projects,
    },
  };
}

/** Fleet map: this daemon (server-local) + two peers "macbook" and "nuc". */
function fakePeerManager(): MetaPeerManager {
  return {
    getPeerStatus: (name: string) =>
      name === "macbook" || name === "nuc"
        ? { name, url: `tcp://${name}:6767`, state: "online" as const, lastSeenAt: null }
        : null,
    getPeerClient: () => null,
  };
}

/**
 * The fleet id index (02) as the daemon's catalog would resolve: local ids
 * live on this host, peer ids on "macbook", and the two ghost ids resolve as
 * "local" (stale-index shape) so the split builder's candidate-listing path
 * is exercised. Everything else is unknown with resolver guidance.
 */
const resolveFleetId = async (id: string): Promise<FleetIdResolution> => {
  const knownLocal = [AGENT_LOCAL, AGENT_ADOPTED, WS_A, WS_B, PRJ_EXP, PRJ_OTHER];
  const knownPeer: Record<string, FleetIdResolution> = {
    [AGENT_PEER]: { kind: "agent", host: "macbook" },
    [WS_PEER]: { kind: "workspace", host: "macbook" },
  };
  const staleLocal: Record<string, FleetIdResolution> = {
    [AGENT_GHOST]: { kind: "agent", host: "local" },
    [WS_GHOST]: { kind: "workspace", host: "local" },
  };
  if (knownLocal.includes(id)) {
    let kind: FleetIdResolution["kind"];
    if (id.startsWith("wks_")) {
      kind = "workspace";
    } else if (id.startsWith("prj_")) {
      kind = "project";
    } else {
      kind = "agent";
    }
    return { kind, host: "local" };
  }
  if (id in knownPeer) {
    return knownPeer[id];
  }
  if (id in staleLocal) {
    return staleLocal[id];
  }
  const kind = id.startsWith("wks_") || id.startsWith("prj_") ? "workspace" : "agent";
  return {
    kind: "unknown",
    guidance: `${kind} ${formatShortId(id)} not found on any reachable host. ${
      kind === "workspace"
        ? "Call fleet_list_inventory to resolve."
        : "Call fleet_list_agents to resolve."
    }`,
  };
};

function buildSplitDeps(
  overrides: { lookup?: SplitMetaLookupDependencies } = {},
): SplitMetaToolDeps {
  return {
    serverId: "server-local",
    hostAlias: null,
    peerManager: fakePeerManager(),
    lookup: overrides.lookup ?? buildLookup(),
    resolveFleetId,
    hostLabel: "local",
  };
}

// ---------------------------------------------------------------------------
// Allowlist (04): fleet_meta gone, the 11 flat tools in
// ---------------------------------------------------------------------------

describe("COMMANDER_TOOL_ALLOWLIST (04 meta split)", () => {
  test("lists all 11 split tools", () => {
    for (const tool of [
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
    ]) {
      expect(COMMANDER_TOOL_ALLOWLIST).toContain(tool);
    }
  });

  test("fleet_meta is REMOVED (the COMPAT alias stays registered for MCP/older callers, see paseo-tools)", () => {
    expect(COMMANDER_TOOL_ALLOWLIST).not.toContain("fleet_meta");
  });

  test("the read-only tools are untouched", () => {
    expect(COMMANDER_TOOL_ALLOWLIST).toContain("fleet_recall");
    expect(COMMANDER_TOOL_ALLOWLIST).toContain("fleet_context");
  });
});

// ---------------------------------------------------------------------------
// Per-tool argument validation (spec 03 error contract)
// ---------------------------------------------------------------------------

describe("buildSplitMetaProposalInput — id family + candidate errors (03)", () => {
  test("missing target id is refused per tool", async () => {
    const deps = buildSplitDeps();
    for (const { args } of SPLIT_TOOL_TABLE) {
      if (args.kind === "create-project") {
        continue;
      }
      await expect(
        buildSplitMetaProposalInput(deps, { ...args, targetId: undefined }),
      ).rejects.toThrow(`${args.action} requires a ${args.kind} id`);
    }
  });

  test("unknown workspace id lists live candidates + the resolver tool", async () => {
    const deps = buildSplitDeps();
    const error = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: WS_GHOST,
      newValue: "x",
    }).catch((caught: Error) => caught.message);
    expect(error).toContain("not found on this host");
    expect(error).toContain("This host has:");
    expect(error).toContain(formatShortId(WS_A));
    expect(error).toContain(formatShortId(WS_B));
    expect(error).toContain("Call fleet_list_inventory to resolve.");
  });

  test("unknown agent id lists nearest live candidates + the resolver tool", async () => {
    const deps = buildSplitDeps();
    const error = await buildSplitMetaProposalInput(deps, {
      action: "rename_agent_title",
      kind: "agent",
      targetId: AGENT_GHOST,
      newValue: "x",
    }).catch((caught: Error) => caught.message);
    expect(error).toContain("not found on this host");
    expect(error).toContain("Nearest:");
    expect(error).toContain("glowing-otter");
    expect(error).toContain("curious-crab");
    expect(error).toContain("Call fleet_list_agents(query) to resolve.");
  });

  test("wrong id family is refused with family guidance (03)", async () => {
    const deps = buildSplitDeps();
    // An AGENT id passed to a workspace tool: the index knows the family.
    const error = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: AGENT_LOCAL,
      newValue: "x",
    }).catch((caught: Error) => caught.message);
    expect(error).toContain(
      `workspace ${formatShortId(AGENT_LOCAL)} resolved as a agent id, not a workspace id`,
    );
    expect(error).toContain("Call fleet_list_agents or fleet_list_inventory to resolve.");
  });

  test("a host hint that names the wrong host is refused naming the actual host", async () => {
    const deps = buildSplitDeps();
    const error = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: WS_PEER,
      host: "nuc",
      newValue: "x",
    }).catch((caught: Error) => caught.message);
    expect(error).toContain(`is on host "macbook", not "nuc"`);
  });

  test("an unknown host hint is refused before the gate", async () => {
    const deps = buildSplitDeps();
    await expect(
      buildSplitMetaProposalInput(deps, {
        action: "rename_workspace",
        kind: "workspace",
        targetId: WS_A,
        host: "ghost",
        newValue: "x",
      }),
    ).rejects.toThrow('Host "ghost" is not a configured peer or this host');
  });

  test("create_project refuses an unknown host and a relative path", async () => {
    const deps = buildSplitDeps();
    await expect(
      buildSplitMetaProposalInput(deps, {
        action: "create_project",
        kind: "create-project",
        host: "ghost",
        destination: "/home/me/new",
      }),
    ).rejects.toThrow('Host "ghost" is not a configured peer or this host');
    await expect(
      buildSplitMetaProposalInput(deps, {
        action: "create_project",
        kind: "create-project",
        host: "local",
        destination: "relative/path",
      }),
    ).rejects.toThrow("destination must be an absolute path");
  });

  test("a peer id without a host hint routes through the fleet index", async () => {
    const deps = buildSplitDeps();
    const input = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: WS_PEER,
      newValue: "Lab",
    });
    expect(input.metaPlan).toMatchObject({
      action: "rename_workspace",
      serverId: "macbook",
      targetId: WS_PEER,
      newValue: "Lab",
    });
  });

  test("respondsTo rides the proposal input (M8 ledger)", async () => {
    const deps = buildSplitDeps();
    const input = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: WS_A,
      newValue: "Lab",
      respondsTo: "#12",
    });
    expect(input.respondsTo).toBe("#12");
  });
});

// ---------------------------------------------------------------------------
// metaPlan payload equivalence vs the old fleet_meta (all 11 actions)
// ---------------------------------------------------------------------------

interface SplitToolRow {
  tool: string;
  args: SplitMetaToolArgs;
  /** The exact metaPlan payload the split builder must produce — the payload
   *  the old fleet_meta carried (serverId + targetLabel resolved). */
  metaPlan: Record<string, unknown>;
}

const SPLIT_TOOL_TABLE: SplitToolRow[] = [
  {
    tool: "fleet_rename_project",
    args: { action: "rename_project", kind: "project", targetId: PRJ_EXP, newValue: "Lab" },
    metaPlan: {
      action: "rename_project",
      serverId: "local",
      targetId: PRJ_EXP,
      targetLabel: "experiments",
      newValue: "Lab",
    },
  },
  {
    tool: "fleet_rename_workspace",
    args: { action: "rename_workspace", kind: "workspace", targetId: WS_A, newValue: "Lab" },
    metaPlan: {
      action: "rename_workspace",
      serverId: "local",
      targetId: WS_A,
      targetLabel: "ws-a",
      newValue: "Lab",
    },
  },
  {
    tool: "fleet_rename_agent_title",
    args: {
      action: "rename_agent_title",
      kind: "agent",
      targetId: AGENT_LOCAL,
      newValue: "Runner",
    },
    metaPlan: {
      action: "rename_agent_title",
      serverId: "local",
      targetId: AGENT_LOCAL,
      targetLabel: "glowing-otter",
      newValue: "Runner",
    },
  },
  {
    tool: "fleet_archive_project",
    args: { action: "archive_project", kind: "project", targetId: PRJ_EXP },
    metaPlan: {
      action: "archive_project",
      serverId: "local",
      targetId: PRJ_EXP,
      targetLabel: "experiments",
    },
  },
  {
    tool: "fleet_archive_workspace",
    args: { action: "archive_workspace", kind: "workspace", targetId: WS_A },
    metaPlan: {
      action: "archive_workspace",
      serverId: "local",
      targetId: WS_A,
      targetLabel: "ws-a",
    },
  },
  {
    tool: "fleet_archive_agent",
    args: { action: "archive_agent", kind: "agent", targetId: AGENT_LOCAL },
    metaPlan: {
      action: "archive_agent",
      serverId: "local",
      targetId: AGENT_LOCAL,
      targetLabel: "glowing-otter",
    },
  },
  {
    tool: "fleet_create_project",
    args: {
      action: "create_project",
      kind: "create-project",
      host: "local",
      destination: "/home/me/new",
      newValue: "New",
    },
    metaPlan: {
      action: "create_project",
      serverId: "local",
      destination: "/home/me/new",
      newValue: "New",
    },
  },
  {
    tool: "fleet_move_agent",
    args: { action: "move_agent", kind: "agent", targetId: AGENT_LOCAL, destination: WS_B },
    metaPlan: {
      action: "move_agent",
      serverId: "local",
      targetId: AGENT_LOCAL,
      targetLabel: "glowing-otter",
      destination: WS_B,
    },
  },
  {
    tool: "fleet_promote_workspace",
    args: { action: "promote_workspace", kind: "workspace", targetId: WS_A },
    metaPlan: {
      action: "promote_workspace",
      serverId: "local",
      targetId: WS_A,
      targetLabel: "ws-a",
    },
  },
  {
    tool: "fleet_adopt_agent",
    args: { action: "adopt_agent", kind: "agent", targetId: AGENT_LOCAL },
    metaPlan: {
      action: "adopt_agent",
      serverId: "local",
      targetId: AGENT_LOCAL,
      targetLabel: "glowing-otter",
    },
  },
  {
    tool: "fleet_release_agent",
    args: { action: "release_agent", kind: "agent", targetId: AGENT_ADOPTED },
    metaPlan: {
      action: "release_agent",
      serverId: "local",
      targetId: AGENT_ADOPTED,
      targetLabel: "curious-crab",
    },
  },
];

describe("metaPlan payload equivalence vs old fleet_meta (11 actions)", () => {
  for (const { tool, args, metaPlan } of SPLIT_TOOL_TABLE) {
    test(`${tool} builds the identical proposal payload the old fleet_meta built`, async () => {
      const deps = buildSplitDeps();
      const splitInput = await buildSplitMetaProposalInput(deps, args);
      // The metaPlan is exactly the payload the old fleet_meta carried
      // (serverId + targetLabel resolved, same optional fields).
      expect(splitInput.metaPlan).toEqual(metaPlan);
      // And feeding that payload through the OLD builder yields the same
      // ProposalCreateInput byte-for-byte (approval gate, message, targetAgentId,
      // classification — zero protocol change).
      const legacyInput = await buildFleetMetaProposalInput({
        serverId: deps.serverId,
        hostAlias: deps.hostAlias,
        peerManager: deps.peerManager,
        metaPlan: splitInput.metaPlan!,
        lookup: deps.lookup,
      });
      expect(splitInput).toEqual(legacyInput);
    });
  }

  test("a peer-routed action stays shape-only through both builders (identical input)", async () => {
    const deps = buildSplitDeps();
    const splitInput = await buildSplitMetaProposalInput(deps, {
      action: "rename_workspace",
      kind: "workspace",
      targetId: WS_PEER,
      newValue: "Lab",
    });
    expect(splitInput.metaPlan).toMatchObject({ serverId: "macbook" });
    const legacyInput = await buildFleetMetaProposalInput({
      serverId: deps.serverId,
      hostAlias: deps.hostAlias,
      peerManager: deps.peerManager,
      metaPlan: splitInput.metaPlan!,
      lookup: deps.lookup,
    });
    expect(splitInput).toEqual(legacyInput);
  });
});

// ---------------------------------------------------------------------------
// Registered-tool schemas (flat, per-tool, host optional except create_project)
// ---------------------------------------------------------------------------

function createSchemaTestCatalog() {
  return createPaseoToolCatalog({
    agentManager: {} as unknown as AgentManager,
    agentStorage: {
      get: async () => null,
      list: async () => [],
    } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager as unknown as never,
    peerManager: {} as unknown as PeerManager,
    callerAgentId: "commander-1",
    callerLabels: { "paseo.mission-control": "commander" },
    serverId: "server-local",
    workspaceRegistry: { get: async () => null, list: async () => [] } as never,
    projectRegistry: { get: async () => null, list: async () => [] } as never,
    logger: createTestLogger(),
  });
}

/** Same parse path the catalog uses at execution (parseToolInput). */
function parseWithInputSchema(tool: PaseoToolDefinition, input: unknown) {
  const schema = z.object(tool.inputSchema as z.ZodRawShape).passthrough();
  return schema.safeParse(input);
}

const SCHEMA_ARG_SETS: Record<string, Record<string, unknown>> = {
  fleet_rename_project: { projectId: PRJ_EXP, title: "Lab" },
  fleet_rename_workspace: { workspaceId: WS_A, title: "Lab" },
  fleet_rename_agent_title: { agentId: AGENT_LOCAL, title: "Runner" },
  fleet_archive_project: { projectId: PRJ_EXP },
  fleet_archive_workspace: { workspaceId: WS_A },
  fleet_archive_agent: { agentId: AGENT_LOCAL },
  fleet_create_project: { host: "local", path: "/home/me/new", title: "New" },
  fleet_move_agent: { agentId: AGENT_LOCAL, workspaceId: WS_B },
  fleet_promote_workspace: { workspaceId: WS_A },
  fleet_adopt_agent: { agentId: AGENT_LOCAL },
  fleet_release_agent: { agentId: AGENT_LOCAL },
};

describe("registered tool schemas (04)", () => {
  test("all 11 tools are registered with their flat per-action schemas", () => {
    const catalog = createSchemaTestCatalog();
    for (const tool of [
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
    ]) {
      const definition = catalog.getTool(tool);
      expect(definition, `${tool} is registered`).toBeDefined();
      expect(definition!.inputSchema).toBeDefined();
    }
    // The COMPAT alias is still registered for MCP/older callers.
    expect(catalog.getTool("fleet_meta")).toBeDefined();
  });

  test("valid args parse for every tool (host optional except create_project)", () => {
    const catalog = createSchemaTestCatalog();
    for (const [tool, args] of Object.entries(SCHEMA_ARG_SETS)) {
      const result = parseWithInputSchema(catalog.getTool(tool)!, args);
      expect(result.success, `${tool} accepts ${JSON.stringify(args)}`).toBe(true);
    }
    // host is OPTIONAL for the ten id-targeted tools...
    for (const tool of [
      "fleet_rename_project",
      "fleet_rename_workspace",
      "fleet_rename_agent_title",
      "fleet_archive_project",
      "fleet_archive_workspace",
      "fleet_archive_agent",
      "fleet_move_agent",
      "fleet_promote_workspace",
      "fleet_adopt_agent",
      "fleet_release_agent",
    ]) {
      const args = { ...SCHEMA_ARG_SETS[tool] };
      delete args.host;
      const result = parseWithInputSchema(catalog.getTool(tool)!, args);
      expect(result.success, `${tool} accepts omitting host`).toBe(true);
    }
    // ...but REQUIRED for create_project (the new root must land somewhere).
    const createProject = catalog.getTool("fleet_create_project")!;
    const withoutHost = parseWithInputSchema(createProject, { path: "/home/me/new" });
    expect(withoutHost.success).toBe(false);
    const withoutPath = parseWithInputSchema(createProject, { host: "local" });
    expect(withoutPath.success).toBe(false);
  });

  test("wrong id families are rejected by the schema", () => {
    const catalog = createSchemaTestCatalog();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "fleet_rename_workspace",
        { workspaceId: PRJ_EXP, title: "x" },
        /workspaceId must be a workspace id/,
      ],
      ["fleet_rename_project", { projectId: WS_A, title: "x" }, /projectId must be a project id/],
      [
        "fleet_archive_workspace",
        { workspaceId: AGENT_LOCAL },
        /workspaceId must be a workspace id/,
      ],
      ["fleet_archive_project", { projectId: AGENT_LOCAL }, /projectId must be a project id/],
      ["fleet_archive_agent", { agentId: WS_A }, /agentId must be an agent UUID/],
      ["fleet_move_agent", { agentId: WS_A, workspaceId: WS_B }, /agentId must be an agent UUID/],
      [
        "fleet_rename_agent_title",
        { agentId: PRJ_EXP, title: "x" },
        /agentId must be an agent UUID/,
      ],
    ];
    for (const [tool, args, pattern] of cases) {
      const result = parseWithInputSchema(catalog.getTool(tool)!, args);
      expect(result.success, `${tool} rejects ${JSON.stringify(args)}`).toBe(false);
      if (result.success === false) {
        expect(JSON.stringify(result.error.issues.map((issue) => issue.message)), tool).toMatch(
          pattern,
        );
      }
    }
  });

  test("missing required fields are rejected by the schema", () => {
    const catalog = createSchemaTestCatalog();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["fleet_rename_project", { projectId: PRJ_EXP }],
      ["fleet_rename_workspace", { title: "Lab" }],
      ["fleet_rename_agent_title", { agentId: AGENT_LOCAL }],
      ["fleet_archive_workspace", {}],
      ["fleet_move_agent", { agentId: AGENT_LOCAL }],
      ["fleet_adopt_agent", {}],
    ];
    for (const [tool, args] of cases) {
      const result = parseWithInputSchema(catalog.getTool(tool)!, args);
      expect(result.success, `${tool} rejects ${JSON.stringify(args)}`).toBe(false);
      if (result.success === false) {
        const missing = result.error.issues.some((issue) => issue.code === "invalid_type");
        expect(missing, `${tool} reports a missing required field`).toBe(true);
      }
    }
  });
});
