import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createMissionControlPresenceSource } from "./presence.js";
import {
  MissionControlService,
  isMonitorAnnounceKind,
  monitorWatchMatchesEvent,
  type MonitorWatch,
} from "./service.js";
import { MissionControlStore } from "./store.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

interface Harness {
  dir: string;
  service: MissionControlService;
  store: MissionControlStore;
  broadcast: ReturnType<typeof vi.fn>;
  updateAgentMetadata: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
  getStoredAgent: ReturnType<typeof vi.fn>;
  listStoredAgents: ReturnType<typeof vi.fn>;
}

const STORED_AGENT: Record<string, unknown> = {
  id: "agent-1",
  provider: "omp",
  cwd: "/tmp/ws",
  workspaceId: "wks_1111111111111111",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  title: "Auth refactor",
  name: "turing",
  shortDescription: "Refactoring the auth flow",
  lastStatus: "running",
  labels: {},
  attentionReason: null,
  requiresAttention: false,
};

function event(overrides: Partial<MissionControlEvent>): MissionControlEvent {
  return {
    id: "mce_1",
    ts: "2026-08-16T10:00:00.000Z",
    agentId: "agent-1",
    agentTitle: "Auth refactor",
    kind: "milestone",
    source: "self",
    severity: "info",
    headline: "Headline",
    ...overrides,
  } as MissionControlEvent;
}

async function createHarness(
  overrides: {
    storedAgent?: Record<string, unknown> | null;
    liveAgent?: unknown;
    seededEvents?: MissionControlEvent[];
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "mc-monitor-"));
  const broadcast = vi.fn();
  const updateAgentMetadata = vi.fn(async () => undefined);
  const getAgent = vi.fn(() => overrides.liveAgent ?? null);
  const stored = overrides.storedAgent === undefined ? STORED_AGENT : overrides.storedAgent;
  const getStoredAgent = vi.fn(async () => stored);
  const listStoredAgents = vi.fn(async () => (stored ? [stored] : []));
  const service = new MissionControlService({
    paseoHome: dir,
    logger: createTestLogger(),
    agentManager: {
      getAgent,
      listAgents: vi.fn(() => []),
      updateAgentMetadata,
      subscribe: vi.fn(() => () => {}),
    } as unknown as AgentManager,
    agentStorage: { get: getStoredAgent, list: listStoredAgents } as unknown as AgentStorage,
    daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
    serverId: "test-server",
    hostName: "test-host",
    broadcast,
    presence: createMissionControlPresenceSource({
      isAgentFocused: () => false,
      readStopOrigin: () => null,
    }),
  });
  await service.start();
  // The service owns its store instance; seed through it so reads are consistent.
  const serviceInternals = service as unknown as { store: MissionControlStore };
  const store = serviceInternals.store;
  for (const seeded of overrides.seededEvents ?? []) {
    await store.append(seeded);
  }
  return {
    dir,
    service,
    store,
    broadcast,
    updateAgentMetadata,
    getAgent,
    getStoredAgent,
    listStoredAgents,
  };
}

async function teardown(harness: Harness): Promise<void> {
  await harness.service.stop();
  await awaitStoreWrites(harness.store);
  await rm(harness.dir, { recursive: true, force: true });
}

function catalogHarness(harness: Harness) {
  return createPaseoToolCatalog({
    agentManager: {
      getAgent: harness.getAgent,
      listAgents: vi.fn(() => []),
    } as unknown as AgentManager,
    agentStorage: {
      get: harness.getStoredAgent,
      list: harness.listStoredAgents,
    } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    missionControlService: harness.service,
    workspaceRegistry: {
      get: async (workspaceId: string) =>
        workspaceId === "wks_1111111111111111"
          ? { workspaceId, projectId: "prj_2222222222222222" }
          : null,
      list: async () => [],
    },
    peerManager: null,
    serverId: "test-server",
    hostAlias: null,
    logger: createTestLogger(),
  });
}

describe("MissionControlService.monitorFleet (spec 03)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await teardown(harness);
  });

  test("start adds agent-scope watches; fleet + several agents coexist; status lists them with ids", () => {
    const { service } = harness;
    const started = service.monitorFleet({
      action: "start",
      scope: "agent",
      agentId: "agent-1",
      sessionKey: "voice-session-1",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.subscriptions).toEqual([
      expect.objectContaining({ scope: "agent", agentId: "agent-1" }),
    ]);

    service.monitorFleet({
      action: "start",
      scope: "agent",
      agentId: "agent-2",
      sessionKey: "voice-session-1",
    });
    const withFleet = service.monitorFleet({
      action: "start",
      scope: "fleet",
      sessionKey: "voice-session-1",
    });
    expect(withFleet.ok).toBe(true);
    if (!withFleet.ok) {
      return;
    }
    expect(withFleet.subscriptions.map((s) => ({ scope: s.scope, agentId: s.agentId }))).toEqual([
      { scope: "agent", agentId: "agent-1" },
      { scope: "agent", agentId: "agent-2" },
      { scope: "fleet", agentId: undefined },
    ]);
    const status = service.monitorFleet({
      action: "status",
      scope: "agent",
      sessionKey: "voice-session-1",
    });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.subscriptions).toHaveLength(3);
    }
  });

  test("start is idempotent per (scope, agentId)", () => {
    const { service } = harness;
    service.monitorFleet({
      action: "start",
      scope: "agent",
      agentId: "agent-1",
      sessionKey: "s1",
    });
    const again = service.monitorFleet({
      action: "start",
      scope: "agent",
      agentId: "agent-1",
      sessionKey: "s1",
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.subscriptions).toHaveLength(1);
    }
  });

  test("stop removes only the matching watch; independent start/stop", () => {
    const { service } = harness;
    service.monitorFleet({ action: "start", scope: "agent", agentId: "agent-1", sessionKey: "s1" });
    service.monitorFleet({ action: "start", scope: "agent", agentId: "agent-2", sessionKey: "s1" });
    service.monitorFleet({ action: "start", scope: "fleet", sessionKey: "s1" });
    const stopped = service.monitorFleet({
      action: "stop",
      scope: "agent",
      agentId: "agent-1",
      sessionKey: "s1",
    });
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.subscriptions.map((s) => s.agentId)).toEqual(["agent-2", undefined]);
    }
    // Stopping the fleet watch leaves the agent watch untouched.
    const stoppedFleet = service.monitorFleet({ action: "stop", scope: "fleet", sessionKey: "s1" });
    expect(stoppedFleet.ok).toBe(true);
    if (stoppedFleet.ok) {
      expect(stoppedFleet.subscriptions).toHaveLength(1);
      expect(stoppedFleet.subscriptions[0]).toMatchObject({ scope: "agent", agentId: "agent-2" });
    }
  });

  test("sessions are isolated", () => {
    const { service } = harness;
    service.monitorFleet({ action: "start", scope: "agent", agentId: "agent-1", sessionKey: "s1" });
    const other = service.monitorFleet({
      action: "status",
      scope: "agent",
      sessionKey: "s2",
    });
    expect(other.ok).toBe(true);
    if (other.ok) {
      expect(other.subscriptions).toEqual([]);
    }
  });

  test("validation errors name the field and the full enum", () => {
    const { service } = harness;
    const badAction = service.monitorFleet({
      action: "pause" as "start",
      scope: "agent",
      sessionKey: "s1",
    });
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) {
      expect(badAction.error).toContain('"start", "stop", "status"');
    }
    const badScope = service.monitorFleet({
      action: "start",
      scope: "workspace" as "agent",
      sessionKey: "s1",
    });
    expect(badScope.ok).toBe(false);
    if (!badScope.ok) {
      expect(badScope.error).toContain('"fleet", "agent"');
    }
    const missingAgent = service.monitorFleet({
      action: "start",
      scope: "agent",
      sessionKey: "s1",
    });
    expect(missingAgent.ok).toBe(false);
    if (!missingAgent.ok) {
      expect(missingAgent.error).toContain("agentId");
    }
  });
});

describe("monitor announce policy (spec 03 table)", () => {
  test("isMonitorAnnounceKind: blocked/failed/finished yes; started/milestones/verdicts no", () => {
    expect(isMonitorAnnounceKind("blocked")).toBe(true);
    expect(isMonitorAnnounceKind("failed")).toBe(true);
    expect(isMonitorAnnounceKind("finished")).toBe(true);
    expect(isMonitorAnnounceKind("started")).toBe(false);
    expect(isMonitorAnnounceKind("milestone")).toBe(false);
    expect(isMonitorAnnounceKind("finding")).toBe(false);
    expect(isMonitorAnnounceKind("verdict")).toBe(false);
    expect(isMonitorAnnounceKind("proposal")).toBe(false);
    expect(isMonitorAnnounceKind("clarification")).toBe(false);
  });

  test("proposal/clarification always announce, independent of the monitor", () => {
    const watch: MonitorWatch = { scope: "agent", agentId: "agent-1", startedAt: "t" };
    expect(monitorWatchMatchesEvent(watch, event({ kind: "proposal", severity: "info" }))).toBe(
      true,
    );
    expect(
      monitorWatchMatchesEvent(watch, event({ kind: "clarification", severity: "info" })),
    ).toBe(true);
  });

  test("blocked/error/finished announce for fleet scope and matching agent scope", () => {
    const fleet: MonitorWatch = { scope: "fleet", startedAt: "t" };
    const agent: MonitorWatch = { scope: "agent", agentId: "agent-1", startedAt: "t" };
    for (const kind of ["blocked", "failed", "finished"] as const) {
      expect(monitorWatchMatchesEvent(fleet, event({ kind }))).toBe(true);
      expect(monitorWatchMatchesEvent(agent, event({ kind }))).toBe(true);
    }
  });

  test("an agent-scope watch does not announce another agent's terminal events", () => {
    const watch: MonitorWatch = { scope: "agent", agentId: "agent-1", startedAt: "t" };
    expect(monitorWatchMatchesEvent(watch, event({ kind: "finished", agentId: "agent-9" }))).toBe(
      false,
    );
  });

  test("started/mid-run milestone reports never announce, even for watched scope", () => {
    const watch: MonitorWatch = { scope: "agent", agentId: "agent-1", startedAt: "t" };
    expect(monitorWatchMatchesEvent(watch, event({ kind: "started" }))).toBe(false);
    expect(monitorWatchMatchesEvent(watch, event({ kind: "milestone" }))).toBe(false);
    expect(monitorWatchMatchesEvent(watch, event({ kind: "finding" }))).toBe(false);
  });
});

describe("MissionControlService.getAgentStatusRecord (spec 03)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) {
      await teardown(harness);
    }
  });

  test("returns record identity, canonical bucket, running-turn info, and the last report", async () => {
    harness = await createHarness({
      liveAgent: {
        id: "agent-1",
        lifecycle: "running",
        activeTurnId: "turn-42",
        activeTurnStartedAt: new Date("2026-08-16T09:59:00.000Z"),
        currentModeId: "auto",
        pendingPermissions: new Map(),
        attention: { requiresAttention: false },
        config: { title: "Auth refactor" },
        name: "turing",
        shortDescription: "Refactoring the auth flow",
        workspaceId: "wks_1111111111111111",
      },
      seededEvents: [
        event({
          id: "mce_report",
          kind: "milestone",
          source: "self",
          headline: "Tests are green",
          detail: "Full suite passes",
          ts: "2026-08-16T09:30:00.000Z",
          reportKind: "milestone",
        }),
      ],
    });
    const record = await harness.service.getAgentStatusRecord("agent-1");
    expect(record).toMatchObject({
      agentId: "agent-1",
      name: "turing",
      title: "Auth refactor",
      description: "Refactoring the auth flow",
      bucket: "running",
      lastStatus: "running",
      workspaceId: "wks_1111111111111111",
      running: {
        lifecycle: "running",
        activeTurnId: "turn-42",
        modeId: "auto",
        pendingPermissionCount: 0,
      },
      lastReport: {
        headline: "Tests are green",
        detail: "Full suite passes",
        ts: "2026-08-16T09:30:00.000Z",
        reportKind: "milestone",
      },
    });
  });

  test("no record, no reports: null identity fields, idle bucket", async () => {
    harness = await createHarness({ storedAgent: null });
    const record = await harness.service.getAgentStatusRecord("agent-1");
    expect(record).toMatchObject({
      agentId: "agent-1",
      name: null,
      title: null,
      description: null,
      bucket: "idle",
      lastStatus: null,
      running: null,
      lastReport: null,
      workspaceId: null,
    });
  });

  test("an error lastStatus with a pending proposal reads needs_you", async () => {
    harness = await createHarness({
      storedAgent: { ...STORED_AGENT, lastStatus: "error" },
    });
    const bucket = await harness.service.getLifecycleBucket("agent-1");
    expect(bucket).toBe("needs_you");
  });

  test("a clean finished run with reviewState ready reads ready", async () => {
    harness = await createHarness({
      storedAgent: { ...STORED_AGENT, lastStatus: "idle" },
    });
    await harness.service.setReviewState("agent-1", "ready");
    const bucket = await harness.service.getLifecycleBucket("agent-1");
    expect(bucket).toBe("ready");
  });
});

describe("fleet_agent_status tool", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      seededEvents: [
        event({
          id: "mce_report",
          kind: "finding",
          source: "self",
          headline: "Root cause isolated",
          detail: "It was the rate limiter",
          ts: "2026-08-16T09:30:00.000Z",
          reportKind: "finding",
        }),
      ],
    });
  });

  afterEach(async () => {
    await teardown(harness);
  });

  test("returns ids + the last report through the catalog (in-process daemon)", async () => {
    const catalog = catalogHarness(harness);
    const result = await catalog.executeTool("fleet_agent_status", { agentId: "agent-1" });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      agentId: "agent-1",
      name: "turing",
      title: "Auth refactor",
      description: "Refactoring the auth flow",
      bucket: "idle",
      lastStatus: "running",
      host: "local",
      fresh: false,
      workspaceId: "wks_1111111111111111",
      projectId: "prj_2222222222222222",
      lastReport: {
        headline: "Root cause isolated",
        detail: "It was the rate limiter",
        ts: "2026-08-16T09:30:00.000Z",
        reportKind: "finding",
      },
    });
  });

  test("unknown agent rejects with resolver guidance (error contract)", async () => {
    harness.getStoredAgent.mockResolvedValue(null);
    harness.getAgent.mockReturnValue(null);
    const catalog = catalogHarness(harness);
    await expect(
      catalog.executeTool("fleet_agent_status", { agentId: "agent-zzz" }),
    ).rejects.toThrow(/fleet_list_agents/);
  });

  test("host-hint mismatch rejects with the actual host", async () => {
    const catalog = catalogHarness(harness);
    await expect(
      catalog.executeTool("fleet_agent_status", { agentId: "agent-1", host: "somewhere-else" }),
    ).rejects.toThrow(/on host "local", not "somewhere-else"/);
  });

  test("fresh:true timeout returns the stale data with fresh:false and a note", async () => {
    vi.useFakeTimers();
    try {
      const catalog = catalogHarness(harness);
      vi.spyOn(harness.service, "requestFreshStatusSteer").mockResolvedValue({ ok: true });
      const promise = catalog.executeTool("fleet_agent_status", {
        agentId: "agent-1",
        fresh: true,
      });
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await promise;
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).toMatchObject({
        agentId: "agent-1",
        fresh: false,
        lastReport: { headline: "Root cause isolated" },
        note: expect.stringContaining("No fresh report_status within 60s"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("fresh:true includes the fresh report when it lands in time", async () => {
    const catalog = catalogHarness(harness);
    let reportListener: ((event: MissionControlEvent) => void) | null = null;
    vi.spyOn(harness.service, "subscribeSelfReports").mockImplementation((listener) => {
      reportListener = listener;
      return () => {
        if (reportListener === listener) {
          reportListener = null;
        }
      };
    });
    vi.spyOn(harness.service, "requestFreshStatusSteer").mockResolvedValue({ ok: true });
    const promise = catalog.executeTool("fleet_agent_status", {
      agentId: "agent-1",
      fresh: true,
    });
    // Let the handler subscribe + steer, then deliver the fresh report.
    await vi.waitFor(() => expect(reportListener).not.toBeNull());
    reportListener!(
      event({
        id: "mce_fresh",
        kind: "milestone",
        source: "self",
        headline: "Just landed the fix",
        detail: "Fresh from the steered run",
        ts: "2026-08-16T10:05:00.000Z",
        reportKind: "milestone",
      }),
    );
    const result = await promise;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      agentId: "agent-1",
      fresh: true,
      lastReport: {
        headline: "Just landed the fix",
        detail: "Fresh from the steered run",
        ts: "2026-08-16T10:05:00.000Z",
        reportKind: "milestone",
      },
    });
  });

  test("a failed status-ask steer returns stale data with a note, never an error", async () => {
    const catalog = catalogHarness(harness);
    vi.spyOn(harness.service, "requestFreshStatusSteer").mockResolvedValue({
      ok: false,
      error: "agent is not live",
    });
    vi.useFakeTimers();
    try {
      const promise = catalog.executeTool("fleet_agent_status", {
        agentId: "agent-1",
        fresh: true,
      });
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await promise;
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).toMatchObject({
        fresh: false,
        note: expect.stringContaining("status-ask not delivered"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fleet_monitor tool", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await teardown(harness);
  });

  test("start/status/stop through the catalog key subscriptions on the session", async () => {
    const catalog = catalogHarness(harness);
    const started = await catalog.executeTool(
      "fleet_monitor",
      { action: "start", scope: "agent", agentId: "agent-1" },
      { sessionKey: "voice-session-1" },
    );
    expect(started.structuredContent).toMatchObject({
      ok: true,
      action: "start",
      subscriptions: [{ scope: "agent", agentId: "agent-1" }],
    });

    const status = await catalog.executeTool(
      "fleet_monitor",
      { action: "status", scope: "agent" },
      { sessionKey: "voice-session-1" },
    );
    const statusSc = status.structuredContent as {
      subscriptions: Array<{ scope: string; agentId?: string }>;
    };
    expect(statusSc.subscriptions).toHaveLength(1);
    expect(statusSc.subscriptions[0]).toMatchObject({ scope: "agent", agentId: "agent-1" });

    const stopped = await catalog.executeTool(
      "fleet_monitor",
      { action: "stop", scope: "agent", agentId: "agent-1" },
      { sessionKey: "voice-session-1" },
    );
    const stoppedSc = stopped.structuredContent as { subscriptions: unknown[] };
    expect(stoppedSc.subscriptions).toEqual([]);
    // The service registry is authoritative: the same session sees the stop.
    expect(harness.service.getMonitorSubscriptions("voice-session-1")).toEqual([]);
  });

  test("sessions do not share subscriptions", async () => {
    const catalog = catalogHarness(harness);
    await catalog.executeTool(
      "fleet_monitor",
      { action: "start", scope: "agent", agentId: "agent-1" },
      { sessionKey: "session-a" },
    );
    const other = await catalog.executeTool(
      "fleet_monitor",
      { action: "status", scope: "agent" },
      { sessionKey: "session-b" },
    );
    expect(other.structuredContent).toMatchObject({
      ok: true,
      subscriptions: [],
    });
  });

  test("agent-scope start rejects an unknown agent with guidance", async () => {
    harness.getStoredAgent.mockResolvedValue(null);
    harness.getAgent.mockReturnValue(null);
    const catalog = catalogHarness(harness);
    await expect(
      catalog.executeTool(
        "fleet_monitor",
        { action: "start", scope: "agent", agentId: "agent-zzz" },
        { sessionKey: "s1" },
      ),
    ).rejects.toThrow(/fleet_list_agents/);
  });

  test("requires a session context", async () => {
    const catalog = catalogHarness(harness);
    await expect(
      catalog.executeTool("fleet_monitor", { action: "status", scope: "agent" }),
    ).rejects.toThrow(/session context/);
  });

  test("bad action enum rejects with the full enum", async () => {
    const catalog = catalogHarness(harness);
    await expect(
      catalog.executeTool(
        "fleet_monitor",
        { action: "pause", scope: "agent" },
        { sessionKey: "s1" },
      ),
    ).rejects.toThrow(/expected one of .*start.*stop.*status/);
  });

  test("the service requestFreshStatusSteer sends a machinery status-ask envelope", async () => {
    const createProposal = vi
      .spyOn(harness.service.approvals, "createProposal")
      .mockResolvedValue({ id: "mcp_1" } as never);
    const result = await harness.service.requestFreshStatusSteer("agent-1");
    expect(result).toEqual({ ok: true });
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        targetAgentId: "agent-1",
        deliveryMode: "steer",
        forceSend: true,
        verboseOnly: true,
        timelineClassification: "machinery",
        message: expect.stringMatching(/^<paseo-system>\n/),
      }),
    );
  });
});
