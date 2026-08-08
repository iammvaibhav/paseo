import { describe, expect, test } from "vitest";

import type {
  MissionControlEvent,
  MissionControlInventoryProject,
} from "@getpaseo/protocol/mission-control/types";
import { MissionControlEventSchema } from "@getpaseo/protocol/mission-control/types";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type {
  PersistedProjectRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import {
  buildCommanderLaunchConfig,
  buildCommanderSystemPrompt,
  buildContextDeltaBlock,
  buildContextPack,
  buildFleetContextData,
  buildLocalRecentAgents,
  createFleetContextDigestProvider,
  type FleetContextDependencies,
} from "./context.js";
import type { MissionControlReviewStateRecord } from "./store.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

function selfReportEvent(agentId: string, headline: string, ts: string): MissionControlEvent {
  return MissionControlEventSchema.parse({
    id: `mce_${agentId}_${ts}`,
    ts,
    agentId,
    agentTitle: "Worker",
    kind: "milestone",
    source: "self",
    severity: "info",
    headline,
  });
}

interface TestFleetOptions {
  hostAlias?: string;
  peerAlias?: string;
  defaultDispatchHost?: string | null;
  commanderInstructions?: string;
  projects?: PersistedProjectRecord[];
  records?: StoredAgentRecord[];
  live?: Array<{ id: string; lifecycle: string }>;
  reviewStates?: Map<string, MissionControlReviewStateRecord>;
  events?: MissionControlEvent[];
}

function buildDependencies(options: TestFleetOptions = {}): FleetContextDependencies {
  const projects: PersistedProjectRecord[] = options.projects ?? [
    {
      projectId: "proj-1",
      rootPath: "/repo/alpha",
      kind: "git",
      displayName: "alpha",
      customName: "Alpha",
      description: "the alpha service",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
    },
  ];
  const workspaces = [
    {
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/repo/alpha/app",
      kind: "worktree",
      displayName: "alpha-app",
      title: "Alpha App",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
    },
  ];
  const records: StoredAgentRecord[] = options.records ?? [
    {
      id: "agent-running",
      labels: {},
      name: "Rusty",
      title: "Fix auth",
      shortDescription: "auth worker",
      updatedAt: "2026-01-02T00:10:00Z",
      lastStatus: "running",
      config: { provider: "codex", cwd: "/repo/alpha/app" },
    },
    {
      id: "agent-review",
      labels: {},
      name: "Mira",
      title: "Ship charts",
      updatedAt: "2026-01-02T00:05:00Z",
      lastStatus: "closed",
      config: { provider: "codex", cwd: "/repo/alpha/app" },
    },
    {
      id: "agent-idle",
      labels: {},
      name: "Idle One",
      title: "Old task",
      updatedAt: "2026-01-01T00:00:00Z",
      lastStatus: "closed",
      config: { provider: "codex", cwd: "/repo/alpha/app" },
    },
  ];
  const live: Array<{ id: string; lifecycle: string }> = options.live ?? [
    { id: "agent-running", lifecycle: "running" },
  ];
  const reviewStates = new Map<string, MissionControlReviewStateRecord>(
    options.reviewStates ?? [
      ["agent-review", { reviewState: "ready", doneAt: null, clearedAt: null, verdict: null }],
    ],
  );
  const events = options.events ?? [
    selfReportEvent("agent-running", "Root cause found", "2026-01-02T00:08:00Z"),
    selfReportEvent("agent-review", "Charts done", "2026-01-02T00:03:00Z"),
  ];

  const daemonConfigStore = {
    get: () =>
      ({
        missionControl: {
          ...(options.hostAlias ? { hostAlias: options.hostAlias } : {}),
          ...(options.defaultDispatchHost ? { defaultHost: options.defaultDispatchHost } : {}),
        },
      }) as ReturnType<DaemonConfigStore["get"]>,
  };

  return {
    agentManager: { listAgents: () => live } as unknown as Pick<AgentManager, "listAgents">,
    agentStorage: { list: async () => records } as unknown as Pick<AgentStorage, "list">,
    workspaceRegistry: { list: async () => workspaces } as unknown as Pick<
      WorkspaceRegistry,
      "list"
    >,
    projectRegistry: { list: async () => projects } as unknown as Pick<ProjectRegistry, "list">,
    providerSnapshotManager: {
      listProviders: async () => [],
      listRegisteredProviderIds: () => ["codex"],
    } as unknown as Pick<ProviderSnapshotManager, "listProviders" | "listRegisteredProviderIds">,
    peerManager: null as PeerManager | null,
    daemonConfigStore,
    centralConfig: () => ({
      get: () => ({
        commanderHost: null,
        commanderModel: null,
        commanderInstructions: options.commanderInstructions ?? "",
        verifierModel: null,
        verifierConcurrency: 3,
        evaluationScope: "commander",
        mode: "ask",
        retentionDays: 30,
        namingTheme: "mixed",
        hideAgentNames: false,
        defaultDispatchHost: options.defaultDispatchHost ?? null,
        nudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    }),
    getReviewStates: () => reviewStates,
    getReportEvents: () => events,
    serverId: "server-local",
    hostName: "mac-work",
    logger: createTestLogger(),
  };
}

describe("buildCommanderSystemPrompt (static)", () => {
  test("is static: identical across different fleet states", async () => {
    const depsA = buildDependencies({ hostAlias: "work server" });
    const depsB = buildDependencies({ hostAlias: "other alias" });
    const launchA = await buildCommanderLaunchConfig(depsA);
    const launchB = await buildCommanderLaunchConfig(depsB);
    expect(launchA.systemPrompt).toBe(launchB.systemPrompt);
  });

  test("carries the shipped playbook and orchestrator reminder, no fleet state", () => {
    const prompt = buildCommanderSystemPrompt("");
    expect(prompt).toContain("fleet_create_agent");
    expect(prompt).toContain("tag_message");
    expect(prompt).toContain("you are the orchestrator");
    expect(prompt).toContain("never run commands, debug, or edit anything yourself");
    expect(prompt).not.toContain("Fleet map");
    expect(prompt).not.toContain("Roster");
  });

  test("appends central commanderInstructions on top", () => {
    const prompt = buildCommanderSystemPrompt("User override: route iOS work to the mac.");
    expect(prompt).toContain("User override: route iOS work to the mac.");
    expect(buildCommanderSystemPrompt("")).not.toContain("User override");
  });
});

describe("context pack as first conversation message", () => {
  test("launch config firstMessage is a system-enveloped fleet snapshot", async () => {
    const deps = buildDependencies({ hostAlias: "work server" });
    const { systemPrompt, firstMessage } = await buildCommanderLaunchConfig(deps);
    expect(systemPrompt).not.toContain("Fleet map");
    expect(firstMessage).toMatch(/^<paseo-system>\nFleet context snapshot:/);
    expect(firstMessage).toContain("Fleet map");
    expect(firstMessage).toContain('alias "work server"');
    expect(firstMessage).toContain("Alpha");
    expect(firstMessage).toContain("the alpha service");
    expect(firstMessage).toContain("Alpha App");
    expect(firstMessage).toContain("Rusty");
  });

  test("different fleet states produce different first messages", async () => {
    const depsA = buildDependencies({ hostAlias: "work server" });
    const depsB = buildDependencies({ hostAlias: "other alias" });
    const launchA = await buildCommanderLaunchConfig(depsA);
    const launchB = await buildCommanderLaunchConfig(depsB);
    expect(launchA.firstMessage).not.toBe(launchB.firstMessage);
  });

  test("fleet map aliases come from each host's own hostAlias declaration", async () => {
    const context = await buildFleetContextData(buildDependencies({ hostAlias: "work server" }));
    const local = context.hosts.find((host) => host.hostName === "local");
    expect(local?.alias).toBe("work server");
  });

  test("routing defaults use the central defaultDispatchHost", async () => {
    const context = await buildFleetContextData(
      buildDependencies({ defaultDispatchHost: "local" }),
    );
    expect(context.defaultHost).toBe("local");
    const pack = buildContextPack(context);
    expect(pack).toContain('Default dispatch host (central config): "local"');
  });

  test("roster renders spec one-liners with headline and age", async () => {
    const context = await buildFleetContextData(buildDependencies());
    const pack = buildContextPack(context);
    expect(pack).toContain('Rusty — Fix auth: "Root cause found"');
    expect(pack).toContain("running, 218d ago");
    expect(pack).toContain("Mira — Ship charts");
    expect(pack).toContain("ready for review");
    expect(pack).toContain("paseo://h/server-local/agent/agent-running");
  });
});

describe("buildLocalRecentAgents roster filter", () => {
  test("includes running and ready-for-review only", async () => {
    const summaries = await buildLocalRecentAgents(buildDependencies());
    const ids = summaries.map((agent) => agent.agentId).sort();
    expect(ids).toEqual(["agent-review", "agent-running"]);
  });

  test("caps the roster at 30", async () => {
    const records: StoredAgentRecord[] = [];
    for (let index = 0; index < 40; index++) {
      records.push({
        id: `agent-${index}`,
        labels: {},
        name: `Name ${index}`,
        updatedAt: new Date(2026, 0, 2, 0, index).toISOString(),
        lastStatus: "running",
        config: { provider: "codex", cwd: "/repo" },
      });
    }
    const deps = buildDependencies({
      records,
      live: records.map((record) => ({ id: record.id, lifecycle: "running" })),
    });
    const summaries = await buildLocalRecentAgents(deps);
    expect(summaries.length).toBeLessThanOrEqual(30);
  });

  test("excludes mission-control-labeled agents", async () => {
    const deps = buildDependencies({
      records: [
        {
          id: "commander-1",
          labels: { "paseo.mission-control": "commander" },
          name: "Commander",
          updatedAt: "2026-01-02T00:00:00Z",
          lastStatus: "running",
          config: { provider: "codex", cwd: "/repo" },
        },
      ],
      live: [{ id: "commander-1", lifecycle: "running" }],
    });
    const summaries = await buildLocalRecentAgents(deps);
    expect(summaries).toEqual([]);
  });
});

describe("fleet context digest provider", () => {
  test("primes baseline then emits deltas, and full snapshots when fresh", async () => {
    const deps = buildDependencies();
    const provider = createFleetContextDigestProvider(deps);
    expect(await provider.deltaBlock()).toBeNull();
    expect(await provider.deltaBlock()).toBeNull();
    const mutated = buildDependencies({ hostAlias: "work server" });
    const provider2 = createFleetContextDigestProvider(mutated);
    await provider2.deltaBlock();
    const delta = await provider2.deltaBlock();
    expect(delta).toBeNull();
    const fresh = await provider2.deltaBlock(true);
    expect(fresh).toContain("Fleet context snapshot:");
    expect(fresh).toContain("Fleet map");
  });
});

describe("project descriptions in inventory", () => {
  test("render in the context pack", async () => {
    const deps = buildDependencies();
    const pack = buildContextPack(await buildFleetContextData(deps));
    expect(pack).toContain("Alpha (proj-1) — the alpha service");
  });
});

describe("invocable provider/model strings", () => {
  test("models render verbatim provider/model strings the create tools accept", async () => {
    const deps = buildDependencies();
    deps.providerSnapshotManager = {
      listProviders: async () => [
        { provider: "codex", models: [{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] },
      ],
      listRegisteredProviderIds: () => ["codex"],
    } as unknown as FleetContextDependencies["providerSnapshotManager"];
    const context = await buildFleetContextData(deps);
    const pack = buildContextPack(context);
    expect(pack).toContain("- codex/gpt-5.4");
    expect(pack).toContain("- codex/gpt-5.4-mini");
    expect(pack).not.toMatch(/- codex: /);
  });

  test("model changes surface through context deltas as invocable strings", () => {
    const previous = [
      { category: "models" as const, host: "local", id: "codex", line: "models: codex/gpt-5.4" },
    ];
    const current = [
      {
        category: "models" as const,
        host: "local",
        id: "codex",
        line: "models: codex/gpt-5.4, codex/gpt-5.4-mini",
      },
    ];
    const block = buildContextDeltaBlock(previous, current);
    expect(block).toContain("models: codex/gpt-5.4, codex/gpt-5.4-mini");
  });
});

describe("single <paseo-system> envelope", () => {
  test("context blocks are inner content: no envelope of their own", async () => {
    const deps = buildDependencies();
    const provider = createFleetContextDigestProvider(deps);
    await provider.deltaBlock();
    const fresh = await provider.deltaBlock(true);
    expect(fresh).not.toMatch(/^<paseo-system>/);
    expect(fresh).toContain("Fleet context snapshot:");
  });
});

describe("peer context hostAlias derivation", () => {
  test("peer alias comes from the peer payload, not a hardcoded list", async () => {
    const peerClient = {
      missionControlContextFetch: async () => ({
        inventory: {
          projects: [
            {
              id: "peer-proj",
              title: "Peer Project",
              hostServerId: "server-peer",
              workspaces: [] as MissionControlInventoryProject["workspaces"],
            },
          ],
        },
        models: {},
        recentAgents: [],
        hostAlias: "peer box",
      }),
    };
    const peerManager = {
      getPeerStatuses: () => [{ name: "peer-a", state: "online", lastSeenAt: null }],
      getPeerClient: () => peerClient,
    } as unknown as PeerManager;
    const deps = buildDependencies();
    const context = await buildFleetContextData({
      ...deps,
      peerManager,
    });
    const peer = context.hosts.find((host) => host.hostName === "peer-a");
    expect(peer?.alias).toBe("peer box");
    expect(peer?.serverId).toBe("server-peer");
  });
});
