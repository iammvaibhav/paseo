import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  buildFleetContextData,
  buildLocalInventory,
  buildLocalModels,
  buildLocalRecentAgents,
  resolveRememberedBaseBranch,
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
  projectSettings?: Record<string, { alwaysRaisePr?: boolean }>;
  agentProfiles?: Array<{ id: string; name: string; provider: string; notes?: string }>;
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
        ...(options.agentProfiles ? { agentProfiles: options.agentProfiles } : {}),
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
        ...(options.projectSettings ? { projectSettings: options.projectSettings } : {}),
      }),
    }),
    getReviewStates: () => reviewStates,
    getReportEvents: () => events,
    serverId: "server-local",
    hostName: "mac-work",
    logger: createTestLogger(),
  };
}

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
  });
});

describe("per-project commander instructions in inventory", () => {
  test("buildLocalInventory loads project instructions from rootPath", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "paseo-local-inventory-instructions-"));
    try {
      writeFileSync(
        join(tmpDir, "paseo.json"),
        JSON.stringify({
          commander: {
            instructions: "Project-specific instructions for inventory.",
          },
        }),
      );
      const inventory = await buildLocalInventory({
        projectRegistry: {
          list: async () => [
            {
              projectId: "proj-custom",
              rootPath: tmpDir,
              kind: "git",
              displayName: "custom",
              customName: "Custom Project",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              archivedAt: null,
            },
          ],
        },
        workspaceRegistry: { list: async () => [] },
        serverId: "server-local",
      });

      expect(inventory.projects[0]?.commanderInstructions).toBe(
        "Project-specific instructions for inventory.",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("buildLocalInventory populates defaultBaseBranch from composerPreferences", async () => {
    const inventory = await buildLocalInventory({
      projectRegistry: {
        list: async () => [
          {
            projectId: "prj_proj_a",
            projectKey: "proj-a",
            rootPath: "/repo-a",
            kind: "git",
            displayName: "repo-a",
            customName: "Project A",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: null,
          },
        ],
      },
      workspaceRegistry: { list: async () => [] },
      serverId: "server-local",
      composerPreferences: {
        byProject: {
          "proj-a": { baseBranch: "develop" },
        },
      },
    });

    expect(inventory.projects[0]?.defaultBaseBranch).toBe("develop");
  });

  test("resolveRememberedBaseBranch uses the project's own pick, never another repo's", () => {
    const prefs = {
      baseBranch: "vaibhav/customizations",
      byProject: {
        "proj-a": { baseBranch: "develop" },
      },
    };
    expect(resolveRememberedBaseBranch(prefs, { projectKey: "proj-a" })).toBe("develop");
    // A repo with no pick of its own falls back to its default branch upstream.
    expect(resolveRememberedBaseBranch(prefs, { projectKey: "proj-b" })).toBeNull();
    expect(resolveRememberedBaseBranch(null)).toBeNull();
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

describe("buildLocalModels visibleModels filtering", () => {
  test("filters models by answering host's visibleModels", async () => {
    const providerSnapshotManager = {
      listProviders: async () => [
        {
          provider: "omp",
          models: [{ id: "anthropic/claude-opus-5-5" }, { id: "google/gemini-2.5" }],
        },
        {
          provider: "cursor",
          models: [{ id: "gpt-5" }],
        },
      ],
      listRegisteredProviderIds: () => ["omp", "cursor"],
    };
    const daemonConfigStore = {
      get: () => ({
        visibleModels: ["omp:anthropic/claude-opus-5-5"],
      }),
    };

    const result = await buildLocalModels({
      providerSnapshotManager,
      daemonConfigStore,
    });

    expect(result.omp).toEqual(["anthropic/claude-opus-5-5"]);
    expect(result.cursor).toBeUndefined();
  });
});
