import { describe, expect, test, vi } from "vitest";

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
  buildFleetContextData,
  buildHostModelsSection,
  buildLocalRecentAgents,
  buildSnapshotBlock,
  buildWorldSnapshot,
  WORLD_SNAPSHOT_MARKER,
  type FleetContextDependencies,
  type WorldSnapshot,
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
        silenceNudgeSeconds: 120,
        statusNudgeSeconds: 300,
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

describe("world snapshot as first conversation message", () => {
  test("launch config firstMessage is the system-enveloped world snapshot", async () => {
    const deps = buildDependencies({ hostAlias: "work server" });
    const { systemPrompt, firstMessage } = await buildCommanderLaunchConfig(deps);
    expect(systemPrompt).not.toContain("Fleet map");
    expect(firstMessage).toMatch(/^<paseo-system>\n# Fleet state as of \d{4}-\d{2}-\d{2}T/);
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
    const block = buildSnapshotBlock(context, new Date().toISOString());
    expect(block).toContain('Default dispatch host (central config): "local"');
  });

  test("roster renders spec one-liners with headline and age", async () => {
    // The age is rendered relative to now, so a hardcoded literal drifts by a day
    // every day. Freeze the clock at exactly 218 days after the running fixture's
    // updatedAt (2026-01-02T00:10:00Z) so the assertion holds regardless of how the
    // renderer rounds. Only Date is faked; real timers keep working for the awaits.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-08T00:10:00Z"));
    try {
      const context = await buildFleetContextData(
        buildDependencies({
          // Rusty's report stays at 218d for the age assertion (running always
          // qualifies). Mira's ready-for-review item must show recent activity
          // to stay inside the roster's 24h window — the ready bucket does not
          // escape the window like running does.
          events: [
            selfReportEvent("agent-running", "Root cause found", "2026-01-02T00:08:00Z"),
            selfReportEvent("agent-review", "Charts done", "2026-08-07T23:00:00Z"),
          ],
        }),
      );
      const block = buildSnapshotBlock(context, new Date().toISOString());
      expect(block).toContain('Rusty — Fix auth: "Root cause found"');
      expect(block).toContain("running, 218d ago");
      expect(block).toContain("Mira — Ship charts");
      expect(block).toContain("ready for review");
      expect(block).toContain("paseo://h/server-local/agent/agent-running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildLocalRecentAgents roster filter", () => {
  test("includes only agents active in the last 24 hours, bucketed by lifecycle", async () => {
    // The fixture activity (Jan 2026 reports) is beyond the 24h window: only
    // the running agent qualifies (running always qualifies). Freeze the clock
    // inside the window to keep the ready-for-review agent too.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T00:20:00Z"));
    try {
      const summaries = await buildLocalRecentAgents(buildDependencies());
      const ids = summaries.map((agent) => agent.agentId).sort();
      expect(ids).toEqual(["agent-review", "agent-running"]);
      expect(summaries.find((a) => a.agentId === "agent-running")?.status).toBe("running");
      expect(summaries.find((a) => a.agentId === "agent-review")?.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  test("excludes agents whose last activity is older than 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    try {
      const summaries = await buildLocalRecentAgents(buildDependencies());
      // agent-running still qualifies (running always qualifies); agent-review
      // (report 2026-01-02) is outside the window and drops out.
      const ids = summaries.map((agent) => agent.agentId).sort();
      expect(ids).toEqual(["agent-running"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("buckets needs-you ahead of running and marks done/idle within the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T00:20:00Z"));
    try {
      const records: StoredAgentRecord[] = [
        {
          id: "agent-blocked",
          labels: {},
          name: "Blocked One",
          updatedAt: "2026-01-02T00:01:00Z",
          lastStatus: "idle",
          config: { provider: "codex", cwd: "/repo" },
        },
        {
          id: "agent-running",
          labels: {},
          name: "Rusty",
          updatedAt: "2026-01-02T00:10:00Z",
          lastStatus: "running",
          config: { provider: "codex", cwd: "/repo" },
        },
        {
          id: "agent-done",
          labels: {},
          name: "Done One",
          updatedAt: "2026-01-02T00:02:00Z",
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        },
        {
          id: "agent-idle",
          labels: {},
          name: "Idle One",
          updatedAt: "2026-01-02T00:03:00Z",
          lastStatus: "closed",
          config: { provider: "codex", cwd: "/repo" },
        },
      ];
      const deps = buildDependencies({
        records,
        live: [
          // "blocked" is not a stored status: needs-you comes from the live
          // attention flag (attention outranks the running lifecycle).
          {
            id: "agent-blocked",
            lifecycle: "idle",
            attention: { requiresAttention: true, attentionReason: "error" },
          },
          { id: "agent-running", lifecycle: "running" },
        ],
        reviewStates: new Map<string, MissionControlReviewStateRecord>([
          ["agent-done", { reviewState: "done", doneAt: null, clearedAt: null, verdict: null }],
        ]),
        events: [
          selfReportEvent("agent-blocked", "stuck", "2026-01-02T00:01:00Z"),
          selfReportEvent("agent-running", "working", "2026-01-02T00:10:00Z"),
          selfReportEvent("agent-done", "finished", "2026-01-02T00:02:00Z"),
          selfReportEvent("agent-idle", "reported", "2026-01-02T00:03:00Z"),
        ],
      });
      const summaries = await buildLocalRecentAgents(deps);
      const byId = new Map(summaries.map((agent) => [agent.agentId, agent]));
      expect(byId.get("agent-blocked")?.status).toBe("needs_you");
      expect(byId.get("agent-running")?.status).toBe("running");
      expect(byId.get("agent-done")?.status).toBe("done");
      expect(byId.get("agent-idle")?.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a live attention flag buckets needs-you even when the record is not blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T00:20:00Z"));
    try {
      const deps = buildDependencies({
        live: [
          {
            id: "agent-running",
            lifecycle: "running",
            attention: { requiresAttention: true, attentionReason: "error" },
          },
        ],
      });
      const summaries = await buildLocalRecentAgents(deps);
      expect(summaries.find((a) => a.agentId === "agent-running")?.status).toBe("needs_you");
    } finally {
      vi.useRealTimers();
    }
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

  test("ages the roster row from the last user message when there is no self-report", async () => {
    const deps = buildDependencies({
      records: [
        {
          id: "agent-running",
          labels: {},
          name: "Rusty",
          title: "Fix auth",
          updatedAt: "2026-01-02T00:10:00Z",
          lastUserMessageAt: "2026-01-02T00:06:00Z",
          lastStatus: "running",
          config: { provider: "codex", cwd: "/repo/alpha/app" },
        },
      ],
      live: [{ id: "agent-running", lifecycle: "running" }],
      events: [],
    });
    const summaries = await buildLocalRecentAgents(deps);
    expect(summaries).toHaveLength(1);
    // The age is the last user message, NOT the boot-rewritten updatedAt.
    expect(summaries[0]?.lastActivityAt).toBe("2026-01-02T00:06:00Z");
    expect(summaries[0]?.lastReportHeadline).toBeUndefined();
  });

  test("omits the age when neither a self-report nor a user message exists", async () => {
    const deps = buildDependencies({
      records: [
        {
          id: "agent-running",
          labels: {},
          name: "Rusty",
          title: "Fix auth",
          updatedAt: "2026-01-02T00:10:00Z",
          lastStatus: "running",
          config: { provider: "codex", cwd: "/repo/alpha/app" },
        },
      ],
      live: [{ id: "agent-running", lifecycle: "running" }],
      events: [],
    });
    const summaries = await buildLocalRecentAgents(deps);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.lastActivityAt).toBeUndefined();
    // The roster line renders without a stale boot-stamped age.
    const context = await buildFleetContextData(deps);
    const block = buildSnapshotBlock(context, new Date().toISOString());
    expect(block).toContain("Rusty — Fix auth — running —");
    expect(block).not.toMatch(/Rusty — Fix auth — running, \d+d ago/);
  });
});

describe("world snapshot (buildWorldSnapshot / buildSnapshotBlock)", () => {
  test("is stamped with the generation time via WORLD_SNAPSHOT_MARKER", async () => {
    const deps = buildDependencies();
    const snapshot: WorldSnapshot = await buildWorldSnapshot(deps);
    expect(snapshot.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.block.startsWith(`${WORLD_SNAPSHOT_MARKER}${snapshot.at}`)).toBe(true);
    // The marker is how the injector identifies snapshot rows for
    // supersede-in-place retraction.
    expect(snapshot.block).toContain(WORLD_SNAPSHOT_MARKER);
  });

  test("renders fleet map, inventory, roster, models, and routing defaults", async () => {
    const deps = buildDependencies();
    const { block } = await buildWorldSnapshot(deps);
    expect(block).toContain("# Fleet map");
    expect(block).toContain("# Inventory");
    expect(block).toContain("# Roster");
    expect(block).toContain("# Models");
    expect(block).toContain("# Routing defaults");
    expect(block).toContain("Alpha (proj-1) — the alpha service");
    expect(block).toContain("Alpha App [worktree]");
  });

  test("regenerates fresh: two calls differ in the stamp and reflect new state", async () => {
    const deps = buildDependencies({ hostAlias: "work server" });
    const first: WorldSnapshot = await buildWorldSnapshot(deps);
    const second: WorldSnapshot = await buildWorldSnapshot(deps);
    expect(second.at).not.toBe(first.at);
    const mutated = buildDependencies({ hostAlias: "other alias" });
    const third: WorldSnapshot = await buildWorldSnapshot(mutated);
    expect(third.block).not.toBe(second.block);
  });

  test("block is inner content: no <paseo-system> envelope of its own", async () => {
    const deps = buildDependencies();
    const { block } = await buildWorldSnapshot(deps);
    expect(block).not.toMatch(/^<paseo-system>/);
    expect(block).toContain("# Fleet state as of ");
  });
});

describe("project descriptions in inventory", () => {
  test("render in the world snapshot", async () => {
    const deps = buildDependencies();
    const block = buildSnapshotBlock(await buildFleetContextData(deps), new Date().toISOString());
    expect(block).toContain("Alpha (proj-1) — the alpha service");
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
    const block = buildSnapshotBlock(context, new Date().toISOString());
    expect(block).toContain("- codex/gpt-5.4");
    expect(block).toContain("- codex/gpt-5.4-mini");
    expect(block).not.toMatch(/- codex: /);
  });
});

describe("models block roles notation (invocable only)", () => {
  const ROLES_KEY = "omp.modelRoles";

  test("roles render invocable: owning provider prefixed, effort split out", () => {
    const block = buildHostModelsSection(
      {
        omp: [
          "opencode-zen/deepseek-v4-flash-free",
          "anthropic/claude-fable-5",
          "grok-build/grok-4.5",
        ],
        [ROLES_KEY]: [
          "task: opencode-zen/deepseek-v4-flash-free:high",
          "plan: grok-build/grok-4.5:high",
        ],
      },
      "iammvaibhav",
    );
    expect(block).toContain(
      '- role "task" → omp/opencode-zen/deepseek-v4-flash-free (effort: high)',
    );
    expect(block).toContain('- role "plan" → omp/grok-build/grok-4.5 (effort: high)');
    // Never the bare internal provider/model:effort form in the block.
    expect(block).not.toContain("opencode-zen/deepseek-v4-flash-free:high");
    expect(block).not.toContain("grok-build/grok-4.5:high");
  });

  test("role model that is itself a provider/model pair stays direct when present", () => {
    const block = buildHostModelsSection(
      {
        cursor: ["gpt-5.6-sol-high", "composer-2.5"],
        [ROLES_KEY]: ["designer: cursor/gpt-5.6-sol-high"],
      },
      "macbook",
    );
    expect(block).toContain('- role "designer" → cursor/gpt-5.6-sol-high');
    // A colon-less value carries no effort note.
    expect(block).not.toContain("(effort:");
  });

  test("role missing from the snapshot renders as unavailable, not usable", () => {
    const block = buildHostModelsSection(
      {
        omp: ["anthropic/claude-fable-5"],
        [ROLES_KEY]: ["task: opencode-zen/deepseek-v4-flash-free:high"],
      },
      "iammvaibhav",
    );
    expect(block).toContain(
      '- role "task" → opencode-zen/deepseek-v4-flash-free (not available on this host)',
    );
    expect(block).not.toContain("omp/opencode-zen/deepseek-v4-flash-free");
  });

  test("one line states the strings are exactly what the create tools accept", () => {
    const block = buildHostModelsSection(
      { omp: ["anthropic/claude-fable-5"], [ROLES_KEY]: ["task: anthropic/claude-fable-5:high"] },
      "local",
    );
    expect(block).toContain("exactly what create_agent/fleet_create_agent accept");
  });

  test("default worker model line: task role invocable", () => {
    const block = buildHostModelsSection(
      {
        omp: ["opencode-zen/deepseek-v4-flash-free"],
        [ROLES_KEY]: ["task: opencode-zen/deepseek-v4-flash-free:high"],
      },
      "local",
    );
    expect(block).toContain(
      "- default worker model: omp/opencode-zen/deepseek-v4-flash-free (omp task role)",
    );
  });

  test("default worker model line: task role missing from snapshot falls back and says so", () => {
    const block = buildHostModelsSection(
      {
        omp: ["anthropic/claude-fable-5", "opencode-go/deepseek-v4-flash"],
        [ROLES_KEY]: ["task: opencode-zen/deepseek-v4-flash-free:high"],
      },
      "iammvaibhav",
    );
    expect(block).toContain(
      '- default worker model: omp/anthropic/claude-fable-5 (omp task role "opencode-zen/deepseek-v4-flash-free" is not available on this host; using first available model)',
    );
  });
});

describe("single <paseo-system> envelope", () => {
  test("snapshot blocks are inner content: the injector wraps exactly one envelope", async () => {
    const deps = buildDependencies();
    const { block } = await buildWorldSnapshot(deps);
    expect(block).not.toMatch(/^<paseo-system>/);
    expect(block).toContain("# Fleet state as of ");
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
