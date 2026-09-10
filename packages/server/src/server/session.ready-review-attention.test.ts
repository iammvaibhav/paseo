import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import { Session } from "./session.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { MissionControlService } from "./mission-control/service.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import { deriveLifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import {
  asAgentManager,
  asAgentStorage,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asGitHubService,
  asPushNotifications,
  asScheduleService,
  asWorkspaceGitService,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
function createMockLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function makeStoredAgent(
  id: string,
  overrides: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id,
    workspaceId: "ws-aria",
    cwd: "/tmp/project-aria",
    title: "Implement feature",
    provider: "omp",
    lastStatus: "idle",
    labels: {},
    internal: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    ...overrides,
  } as unknown as StoredAgentRecord;
}

interface TestHarnessOptions {
  storedRecord: StoredAgentRecord;
  liveAgent?: ManagedAgent | null;
  reviewState?: "ready" | "done" | "none" | "cleared";
  stopOrigin?: "user" | "machinery" | "system" | null;
  pendingProposalCount?: number;
}

function createHarness(options: TestHarnessOptions) {
  let stored = { ...options.storedRecord };
  const emitted: SessionOutboundMessage[] = [];
  const reviewState = options.reviewState ?? "ready";
  const stopOrigin = options.stopOrigin ?? null;
  const pendingProposalCount = options.pendingProposalCount ?? 0;
  const mockMissionControlService = {
    getLifecycleBucket: vi.fn(async (agentId: string) => {
      if (agentId !== stored.id) return "idle";
      const live = options.liveAgent ?? null;
      return deriveLifecycleBucket({
        pendingPermissionCount: live ? (live.pendingPermissions?.size ?? 0) : 0,
        pendingProposalCount,
        attentionReason: live?.attention?.requiresAttention
          ? (live.attention.attentionReason ?? null)
          : (stored.attentionReason ?? null),
        lastStatus: live ? live.lifecycle : (stored.lastStatus ?? null),
        running: live ? live.lifecycle === "running" || live.lifecycle === "initializing" : false,
        reviewState,
        stopOrigin,
      });
    }),
    getStopOrigin: vi.fn((agentId: string) => (agentId === stored.id ? stopOrigin : null)),
    getReviewStates: vi.fn(() => new Map()),
    fetchEvents: vi.fn(() => []),
  } as unknown as MissionControlService;

  const workspace = {
    workspaceId: "ws-aria",
    projectId: "proj-aria",
    cwd: stored.cwd,
    kind: "directory" as const,
    displayName: "project-aria",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  };

  const project = {
    projectId: "proj-aria",
    rootPath: stored.cwd,
    kind: "non_git" as const,
    displayName: "project-aria",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  };

  const liveAgentsMap = new Map<string, ManagedAgent>();
  if (options.liveAgent) liveAgentsMap.set(options.liveAgent.id, options.liveAgent);
  const agentManager = asAgentManager({
    getAgent: vi.fn((id: string) => liveAgentsMap.get(id) ?? null),
    listAgents: vi.fn(() => Array.from(liveAgentsMap.values())),
    listProviderSubagentActivity: vi.fn(() => []),
    getRegisteredProviderIds: vi.fn(() => ["omp"]),
    subscribe: vi.fn(() => () => {}),
    clearAgentAttention: vi.fn(async (id: string) => {
      const live = liveAgentsMap.get(id);
      if (live) {
        live.attention = { requiresAttention: false, attentionReason: null };
      }
      if (stored.id === id) {
        stored.requiresAttention = false;
        stored.attentionReason = null;
        stored.attentionTimestamp = null;
      }
    }),
    hasTimeline: vi.fn(() => false),
    seedTimelineForRehydrate: vi.fn(async (_id: string, cb: () => Promise<unknown>) => cb()),
    createAgent: vi.fn(async () => {
      const agent = {
        id: stored.id,
        provider: stored.provider,
        cwd: stored.cwd,
        lifecycle: stored.lastStatus ?? "idle",
        labels: stored.labels ?? {},
        internal: stored.internal ?? false,
        attention: {
          requiresAttention: stored.requiresAttention ?? false,
          attentionReason: stored.attentionReason ?? null,
        },
        pendingPermissions: new Map(),
        session: { isRuntimeAlive: () => true },
        capabilities: {
          supportsStreaming: false,
          supportsSessionPersistence: true,
          supportsDynamicModes: false,
        },
        config: { provider: stored.provider, cwd: stored.cwd },
        features: [],
        availableModes: [],
        createdAt: new Date(stored.createdAt),
        updatedAt: new Date(stored.updatedAt),
      } as unknown as ManagedAgent;
      liveAgentsMap.set(agent.id, agent);
      return agent;
    }),
    hydrateTimelineFromProvider: vi.fn(async () => {}),
  });

  const agentStorage = asAgentStorage({
    get: vi.fn(async (id: string) => (id === stored.id ? { ...stored } : null)),
    list: vi.fn(async () => [{ ...stored }]),
    upsert: vi.fn(async (record: StoredAgentRecord) => {
      stored = { ...record };
    }),
  });

  const session = new Session({
    clientId: "client-test",
    serverId: "server-test",
    permissions: OWNER_PERMISSIONS,
    scopes: ["*"],
    appVersion: "0.2.0",
    onMessage: (msg: SessionOutboundMessage) => emitted.push(msg),
    logger: createMockLogger(),
    downloadTokenStore: asDownloadTokenStore(),
    pushNotifications: asPushNotifications(),
    paseoHome: "/tmp/paseo-test",
    agentManager,
    agentStorage,
    projectRegistry: {
      list: vi.fn().mockResolvedValue([project]),
      get: vi.fn().mockResolvedValue(project),
      getOrCreateActiveByRoot: vi.fn().mockResolvedValue(project),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn().mockResolvedValue(true),
    },
    workspaceRegistry: {
      get: vi.fn().mockResolvedValue(workspace),
      list: vi.fn().mockResolvedValue([workspace]),
    },
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager({
      scheduleRefreshForCwd: vi.fn(),
    }),
    github: asGitHubService({
      invalidate: vi.fn(),
      searchIssuesAndPrs: vi.fn(),
      createPullRequest: vi.fn(),
      mergePullRequest: vi.fn(),
    }),
    workspaceGitService: asWorkspaceGitService({
      getCheckout: vi.fn().mockResolvedValue({
        cwd: stored.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
      getCheckoutDiff: vi.fn(),
      getSnapshot: vi.fn(),
      suggestBranchesForCwd: vi.fn(),
      listStashes: vi.fn(),
      peekSnapshot: vi.fn(),
      validateBranchRef: vi.fn(),
      hasLocalBranch: vi.fn(),
      resolveRepoRemoteUrl: vi.fn(),
      resolveRepoRoot: vi.fn(),
      getWorkspaceGitMetadata: vi.fn(),
      resolveForge: vi.fn(),
      invalidateForge: vi.fn(),
      getProjectSlug: vi.fn(),
    }),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({ mcp: { injectIntoAgents: false }, providers: {} })),
      onChange: vi.fn(() => () => {}),
    }),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    missionControlService: mockMissionControlService,
    terminalManager: null,
    stt: null,
    tts: null,
  });

  return {
    session,
    emitted,
    getStored: () => stored,
    mockMissionControlService,
  };
}

describe("Ready to review lifecycle stability on user view (Aria defect)", () => {
  test("an agent that finished cleanly is in bucket ready; user views it via fetch_agent; it is STILL ready", async () => {
    const record = makeStoredAgent("agent-aria-1", {
      lastStatus: "idle",
      requiresAttention: false,
      attentionReason: null,
    });

    const { session, emitted } = createHarness({
      storedRecord: record,
      reviewState: "ready",
    });

    // User views the agent (e.g. Mission Control Inspector opens Aria)
    await session.handleMessage({
      type: "fetch_agent_request",
      agentId: "agent-aria-1",
      requestId: "req-fetch-aria",
    });
    if (!emitted.find((msg) => msg.type === "fetch_agent_response")) {
      process.stderr.write("EMITTED IN TEST: " + JSON.stringify(emitted, null, 2) + "\n");
    }
    const response = emitted.find((msg) => msg.type === "fetch_agent_response");
    expect(response).toBeDefined();
    if (response && response.type === "fetch_agent_response") {
      expect(response.payload.error).toBeNull();
      expect(response.payload.agent).not.toBeNull();
      expect(response.payload.agent?.bucket).toBe("ready");
    }
  });

  test("an agent that finished cleanly is in bucket ready; workspace attention clears; agent_update is STILL ready", async () => {
    const record = makeStoredAgent("agent-aria-2", {
      lastStatus: "idle",
      requiresAttention: true,
      attentionReason: "finished", // legacy latch on disk
    });

    const { session, emitted, getStored } = createHarness({
      storedRecord: record,
      reviewState: "ready",
    });

    // User opens the workspace containing Aria -> clear workspace attention runs
    await session.handleMessage({
      type: "workspace.clear_attention.request",
      workspaceId: "ws-aria",
      requestId: "req-clear-aria",
    } as SessionInboundMessage);

    // Attention flag is acknowledged and cleared on disk
    expect(getStored().requiresAttention).toBe(false);
    expect(getStored().attentionReason).toBeNull();

    // Emitted agent_update reflects cleared attention but keeps bucket: "ready"
    const agentUpdate = emitted.find(
      (msg) =>
        msg.type === "agent_update" &&
        msg.payload.kind === "upsert" &&
        msg.payload.agent.id === "agent-aria-2",
    );
    expect(agentUpdate).toBeDefined();
    if (
      agentUpdate &&
      agentUpdate.type === "agent_update" &&
      agentUpdate.payload.kind === "upsert"
    ) {
      expect(agentUpdate.payload.agent.requiresAttention).toBe(false);
      expect(agentUpdate.payload.agent.attentionReason).toBeNull();
      expect(agentUpdate.payload.agent.bucket).toBe("ready");
    }
  });

  test("clear_agent_attention returns the agent with bucket ready", async () => {
    const record = makeStoredAgent("agent-aria-3", {
      lastStatus: "idle",
      requiresAttention: true,
      attentionReason: "finished",
    });

    const { session, emitted } = createHarness({
      storedRecord: record,
      reviewState: "ready",
    });

    await session.handleMessage({
      type: "clear_agent_attention",
      agentId: "agent-aria-3",
      requestId: "req-clear-single-aria",
    });

    const response = emitted.find((msg) => msg.type === "clear_agent_attention_response");
    if (response && response.type === "clear_agent_attention_response") {
      expect(response.payload.agents).toHaveLength(1);
      expect(response.payload.agents[0]?.bucket).toBe("ready");
    }
  });
});

describe("Genuine attention cases retain correct buckets and clear properly", () => {
  test("a permission prompt leaves needs_you and workspace.clear_attention does not clear it", async () => {
    const liveAgent = {
      id: "agent-perm-1",
      provider: "omp",
      cwd: "/tmp/project-aria",
      lifecycle: "running" as const,
      labels: {},
      internal: false,
      attention: { requiresAttention: true, attentionReason: "permission" as const },
      pendingPermissions: new Map([["perm-1", { id: "perm-1" }]]),
      session: { isRuntimeAlive: () => true },
    } as unknown as ManagedAgent;

    const record = makeStoredAgent("agent-perm-1", {
      lastStatus: "running",
      requiresAttention: true,
      attentionReason: "permission",
    });

    const { session, emitted } = createHarness({
      storedRecord: record,
      liveAgent,
      reviewState: "none",
    });

    // Fetch shows needs_you
    await session.handleMessage({
      type: "fetch_agent_request",
      agentId: "agent-perm-1",
      requestId: "req-fetch-perm",
    });

    const fetchResponse = emitted.find((msg) => msg.type === "fetch_agent_response");
    if (fetchResponse && fetchResponse.type === "fetch_agent_response") {
      expect(fetchResponse.payload.agent?.bucket).toBe("needs_you");
    }

    // Clearing workspace attention does NOT clear pending permission
    await session.handleMessage({
      type: "workspace.clear_attention.request",
      workspaceId: "ws-aria",
      requestId: "req-clear-ws-perm",
    });

    const clearResponse = emitted.find((msg) => msg.type === "workspace.clear_attention.response");
    if (clearResponse && clearResponse.type === "workspace.clear_attention.response") {
      expect(clearResponse.payload.clearedAgentIds).toEqual([]);
    }
  });

  test("an error agent has bucket needs_you; attention clear clears attention flag but error bucket remains needs_you", async () => {
    const record = makeStoredAgent("agent-err-1", {
      lastStatus: "error",
      requiresAttention: true,
      attentionReason: "error",
    });

    const { session, emitted, getStored } = createHarness({
      storedRecord: record,
      reviewState: "none",
    });

    await session.handleMessage({
      type: "workspace.clear_attention.request",
      workspaceId: "ws-aria",
      requestId: "req-clear-err",
    });

    expect(getStored().requiresAttention).toBe(false);
    expect(getStored().attentionReason).toBeNull();

    const agentUpdate = emitted.find(
      (msg) =>
        msg.type === "agent_update" &&
        msg.payload.kind === "upsert" &&
        msg.payload.agent.id === "agent-err-1",
    );
    expect(agentUpdate).toBeDefined();
    if (
      agentUpdate &&
      agentUpdate.type === "agent_update" &&
      agentUpdate.payload.kind === "upsert"
    ) {
      expect(agentUpdate.payload.agent.requiresAttention).toBe(false);
      // Because lastStatus is still "error", bucket stays "needs_you"
      expect(agentUpdate.payload.agent.bucket).toBe("needs_you");
    }
  });

  test("a user-stopped agent lands in done and viewing it preserves bucket done", async () => {
    const record = makeStoredAgent("agent-stopped-1", {
      lastStatus: "idle",
      requiresAttention: false,
      attentionReason: null,
    });

    const { session, emitted } = createHarness({
      storedRecord: record,
      reviewState: "none",
      stopOrigin: "user",
    });

    await session.handleMessage({
      type: "fetch_agent_request",
      agentId: "agent-stopped-1",
      requestId: "req-fetch-stopped",
    });

    const response = emitted.find((msg) => msg.type === "fetch_agent_response");
    expect(response).toBeDefined();
    if (response && response.type === "fetch_agent_response") {
      expect(response.payload.agent?.bucket).toBe("done");
      expect(response.payload.agent?.stoppedBy).toBe("user");
    }
  });
});
