import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import type { MissionControlService } from "../../mission-control/service.js";
import { createPaseoToolCatalog, dispatchLocalPromptMode } from "./paseo-tools.js";

/** Canned fetch_agent_timeline response payload. */
function peerTimelinePayload(): Record<string, unknown> {
  return {
    requestId: "req-1",
    agentId: "peer-agent-1",
    agent: { id: "peer-agent-1", currentModeId: "auto" },
    direction: "tail",
    projection: "projected",
    epoch: "e1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 2, nextSeq: 3 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    mergeWindow: false,
    entries: [
      {
        provider: "omp",
        item: { type: "assistant_message", text: "Did the thing" },
        timestamp: "2026-08-08T00:00:00.000Z",
        seqStart: 0,
        seqEnd: 0,
        sourceSeqRanges: [],
        collapsed: [],
      },
      {
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "echo hi" },
        },
        timestamp: "2026-08-08T00:00:01.000Z",
        seqStart: 1,
        seqEnd: 1,
        sourceSeqRanges: [],
        collapsed: [],
      },
    ],
    error: null,
  };
}

/** Fake peer harness: a stub PeerManager over a stub DaemonClient. */
function createFakePeerHarness(
  overrides: {
    client?: Partial<DaemonClient>;
    statuses?: Array<{ name: string; state: "online" | "unreachable"; lastSeenAt: string | null }>;
  } = {},
) {
  const statuses = overrides.statuses ?? [
    { name: "macbook", state: "online" as const, lastSeenAt: null },
  ];
  const client = {
    fetchAgentTimeline: vi.fn(async () => peerTimelinePayload()),
    sendAgentMessage: vi.fn(async () => undefined),
    ...overrides.client,
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) => statuses.find((s) => s.name === name) ?? null,
    getPeerStatuses: () =>
      statuses.map((s) => Object.assign({}, s, { name: s.name, url: `ws://${s.name}` })),
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;
  return { client, peerManager };
}

function createCatalog(
  peerManager: PeerManager,
  agentManager?: AgentManager,
  hostIdentity: { serverId?: string; hostAlias?: string | null } = {},
) {
  return createPaseoToolCatalog({
    agentManager: agentManager ?? ({} as unknown as AgentManager),
    agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
    serverId: hostIdentity.serverId,
    hostAlias: hostIdentity.hostAlias,
    logger: createTestLogger(),
  });
}

describe("fleet_get_agent_activity tool", () => {
  test("proxies to the peer host via fetchAgentTimeline and curates the summary", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_get_agent_activity", {
      host: "macbook",
      agentId: "peer-agent-1",
      limit: 10,
    });
    expect(client.fetchAgentTimeline).toHaveBeenCalledWith("peer-agent-1", {
      direction: "tail",
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      agentId: "peer-agent-1",
      updateCount: 2,
      currentModeId: "auto",
    });
    expect(String(result.structuredContent.content)).toContain("Did the thing");
  });

  test("falls back to the local get_agent_activity path when host is local", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager, {
      getAgent: () => null,
    } as unknown as AgentManager);

    // The local branch resolves through the catalog's own get_agent_activity,
    // which needs a loaded agent; the stub has none, so it fails with the
    // local "Agent not found" error — proving the peer proxy was not used.
    await expect(
      catalog.executeTool("fleet_get_agent_activity", {
        host: "local",
        agentId: "agent-1",
      }),
    ).rejects.toThrow(/not found/i);
    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
  });

  test("the daemon's own hostAlias resolves to the local branch, never the peer proxy", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(
      peerManager,
      { getAgent: () => null } as unknown as AgentManager,
      { serverId: "srv__alpha", hostAlias: "alpha" },
    );

    // Own alias (the world snapshot teaches the Commander these) must route
    // to the local branch exactly like "local" — same shared resolver the
    // spawn and meta executors use.
    await expect(
      catalog.executeTool("fleet_get_agent_activity", {
        host: "alpha",
        agentId: "agent-1",
      }),
    ).rejects.toThrow(/not found/i);
    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
  });

  test("throws a peer-unreachable error when the host is not online", async () => {
    const { peerManager } = createFakePeerHarness({
      statuses: [{ name: "macbook", state: "unreachable", lastSeenAt: "2026-08-08T00:00:00.000Z" }],
    });
    const catalog = createCatalog(peerManager);
    await expect(
      catalog.executeTool("fleet_get_agent_activity", {
        host: "macbook",
        agentId: "peer-agent-1",
      }),
    ).rejects.toThrow(/unreachable/i);
  });

  test("throws when the host is not a configured peer", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    await expect(
      catalog.executeTool("fleet_get_agent_activity", {
        host: "unknown-host",
        agentId: "peer-agent-1",
      }),
    ).rejects.toThrow(/not a configured peer/i);
  });
});

describe("fleet_list_agents roster enrichment", () => {
  function selfEvent(agentId: string, ts: string, headline: string) {
    return {
      id: `mce_${ts}`,
      ts,
      agentId,
      agentTitle: "Agent",
      kind: "milestone" as const,
      source: "self" as const,
      severity: "info" as const,
      headline,
    };
  }

  test("peer rows carry report_status headlines (cap 5, oldest to newest, self events only)", async () => {
    const { client, peerManager } = createFakePeerHarness();
    client.fetchAgents = vi.fn(async () => ({
      entries: [
        {
          agent: {
            id: "peer-agent-1",
            provider: "omp",
            cwd: "/tmp",
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
            status: "idle",
            title: "Peer agent",
          },
        },
      ],
      page: { limit: 200 },
    }));
    client.missionControlEventsFetch = vi.fn(async () => ({
      requestId: "req-events",
      events: [
        selfEvent("peer-agent-1", "2026-08-08T00:00:01.000Z", "Oldest headline"),
        selfEvent("peer-agent-1", "2026-08-08T00:00:02.000Z", "Newest headline"),
        {
          id: "mce_sys",
          ts: "2026-08-08T00:00:03.000Z",
          agentId: "peer-agent-1",
          agentTitle: "Agent",
          kind: "started",
          source: "system",
          severity: "info",
          headline: "Started running",
        },
      ],
    }));
    const catalog = createCatalog(peerManager, {
      listAgents: () => [],
      getRegisteredProviderIds: () => [],
      getTimeline: () => [],
    } as unknown as AgentManager);

    const result = await catalog.executeTool("fleet_list_agents", { limit: 50 });
    const agents = (result.structuredContent as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "peer-agent-1",
      host: "macbook",
    });
    expect(agents[0].reportStatus).toEqual(["Oldest headline", "Newest headline"]);
    expect(agents[0].lastUserMessage).toBeUndefined();
  });

  test("headlines are capped at 5, oldest to newest", async () => {
    const { client, peerManager } = createFakePeerHarness();
    client.fetchAgents = vi.fn(async () => ({
      entries: [
        {
          agent: {
            id: "peer-agent-1",
            provider: "omp",
            cwd: "/tmp",
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
            status: "idle",
            title: "Peer agent",
          },
        },
      ],
      page: { limit: 200 },
    }));
    const peerEvents = Array.from({ length: 7 }, (_, index) =>
      selfEvent("peer-agent-1", `2026-08-08T00:00:0${index}.000Z`, `Headline ${index + 1}`),
    );
    client.missionControlEventsFetch = vi.fn(async () => ({
      requestId: "req-events",
      events: peerEvents,
    }));
    const catalog = createCatalog(peerManager, {
      listAgents: () => [],
      getRegisteredProviderIds: () => [],
      getTimeline: () => [],
    } as unknown as AgentManager);

    const result = await catalog.executeTool("fleet_list_agents", { limit: 50 });
    const agents = (result.structuredContent as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents[0].reportStatus).toEqual([
      "Headline 3",
      "Headline 4",
      "Headline 5",
      "Headline 6",
      "Headline 7",
    ]);
  });

  test("local roster rows carry the host alias instead of the literal local", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createPaseoToolCatalog({
      agentManager: {
        listAgents: () => [],
        getRegisteredProviderIds: () => ["omp"],
        getTimeline: () => [],
      } as unknown as AgentManager,
      agentStorage: {
        get: async () => null,
        list: async () => [
          {
            id: "local-1",
            provider: "omp",
            cwd: "/tmp",
            labels: {},
            createdAt: "2026-08-01T00:00:00Z",
            updatedAt: "2026-08-01T00:00:00Z",
            lastStatus: "closed",
            title: "Local agent",
          },
        ],
      } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      peerManager,
      hostAlias: "work server",
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("fleet_list_agents", { limit: 50 });
    const agents = (result.structuredContent as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "local-1", host: "work server" });
  });
});

describe("fleet_send_prompt mode", () => {
  test("validates the schema: mode defaults to the central setting (interrupt without MC) and rejects unknown modes", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    // No missionControlService wired: the fleet default resolves to
    // "interrupt" (the spec default of commanderToWorkerMode).
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "peer-agent-1",
        prompt: "hello",
        mode: "steer",
      }),
    ).resolves.toMatchObject({ structuredContent: { success: true, deliveryMode: "steer" } });
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "peer-agent-1",
        prompt: "hello",
      }),
    ).resolves.toMatchObject({
      structuredContent: { success: true, deliveryMode: "interrupt" },
    });
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "peer-agent-1",
        prompt: "hello",
        mode: "replace",
      }),
    ).rejects.toThrow();
  });

  test("commanderToWorkerMode is the default when mode is omitted; an explicit mode overrides it", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      peerManager,
      // Commander host daemon: the fleet setting drives the default.
      missionControlService: {
        getCentralConfig: () => ({ commanderToWorkerMode: "queue" }),
      } as unknown as MissionControlService,
      logger: createTestLogger(),
    });

    // Omitted mode → the fleet commanderToWorkerMode setting (queue).
    await catalog.executeTool("fleet_send_prompt", {
      host: "macbook",
      agentId: "peer-agent-1",
      prompt: "follow up",
    });
    expect(client.sendAgentMessage).toHaveBeenLastCalledWith("peer-agent-1", "follow up", {
      dispatchMode: "queue",
    });
    // An explicit mode from the Commander always wins (steer for additive).
    await catalog.executeTool("fleet_send_prompt", {
      host: "macbook",
      agentId: "peer-agent-1",
      prompt: "add a note",
      mode: "steer",
    });
    expect(client.sendAgentMessage).toHaveBeenLastCalledWith("peer-agent-1", "add a note", {
      dispatchMode: "steer",
    });
  });

  test("proxies the dispatch mode to the peer via sendAgentMessage", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "macbook",
      agentId: "peer-agent-1",
      prompt: "steer the turn",
      mode: "steer",
    });
    expect(client.sendAgentMessage).toHaveBeenCalledWith("peer-agent-1", "steer the turn", {
      dispatchMode: "steer",
    });
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });

  test("steers a busy omp agent locally through the out-of-band path without cancelling", async () => {
    const tryRunOutOfBand = vi.fn(() => true);
    const streamAgent = vi.fn();
    const appendTimelineItem = vi.fn(async () => undefined);
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "omp" })),
      hasInFlightRun: vi.fn(() => true),
      tryRunOutOfBand,
      streamAgent,
      // The native steer records the prompt as a timeline row (classify-at-
      // source); the mock must accept the append.
      appendTimelineItem,
    } as unknown as AgentManager;
    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "agent-1",
      prompt: "focus on tests",
      mode: "steer",
    });
    expect(tryRunOutOfBand).toHaveBeenCalledWith("agent-1", "/steer focus on tests");
    expect(streamAgent).not.toHaveBeenCalled();
    expect(appendTimelineItem).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ type: "user_message", text: "focus on tests" }),
    );
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });

  test("an instruction steer records a visible user row so the agent's chat is never missing a direction", async () => {
    const tryRunOutOfBand = vi.fn(() => true);
    const appendTimelineItem = vi.fn(async () => undefined);
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "omp" })),
      hasInFlightRun: vi.fn(() => true),
      tryRunOutOfBand,
      appendTimelineItem,
      expectPromptClassification: vi.fn(),
    } as unknown as AgentManager;

    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "agent-1",
      prompt: "add a note about the fix",
      mode: "steer",
    });
    // The native steer records no row in Paseo's timeline; the instruction is
    // appended as a classified user row (absent classification = instruction).
    expect(appendTimelineItem).toHaveBeenCalledWith("agent-1", {
      type: "user_message",
      text: "add a note about the fix",
      classification: "instruction",
    });
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });

  test("a machinery steer records a machinery-classified row (status asks render as a placeholder)", async () => {
    const tryRunOutOfBand = vi.fn(() => true);
    const appendTimelineItem = vi.fn(async () => undefined);
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "omp" })),
      hasInFlightRun: vi.fn(() => true),
      tryRunOutOfBand,
      appendTimelineItem,
    } as unknown as AgentManager;

    // Machinery prompts (stall status-ask nudges) reach dispatchLocalPromptMode
    // from the mission-control approval path with an explicit classification.
    const result = await dispatchLocalPromptMode({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      agentId: "agent-1",
      prompt: "You've been quiet for a while. Post a one-line report_status.",
      mode: "steer",
      classification: "machinery",
      logger: createTestLogger(),
    });
    expect(result).toBe("steer");
    expect(appendTimelineItem).toHaveBeenCalledWith("agent-1", {
      type: "user_message",
      text: "You've been quiet for a while. Post a one-line report_status.",
      classification: "machinery",
    });
  });

  test("an interrupt machinery dispatch registers an expectation instead of appending a row", async () => {
    const expectPromptClassification = vi.fn();
    const streamAgent = vi.fn(async function* () {});
    const appendTimelineItem = vi.fn(async () => undefined);
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "omp" })),
      hasInFlightRun: vi.fn(() => false),
      tryRunOutOfBand: vi.fn(() => false),
      streamAgent,
      appendTimelineItem,
      expectPromptClassification,
    } as unknown as AgentManager;

    // The interrupt path echoes the submitted prompt as a natural user row;
    // the machinery classification rides an expectation that stamps that echo.
    await dispatchLocalPromptMode({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      agentId: "agent-1",
      prompt: "status please",
      mode: "interrupt",
      classification: "machinery",
      logger: createTestLogger(),
    });
    expect(expectPromptClassification).toHaveBeenCalledWith(
      "agent-1",
      "status please",
      "machinery",
    );
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  test("steer on a busy non-omp agent interrupts (replaceRunning) and reports the fallback honestly", async () => {
    const tryRunOutOfBand = vi.fn(() => false);
    const replaceAgentRun = vi.fn(async function* () {});
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "codex" })),
      hasInFlightRun: vi.fn(() => true),
      tryRunOutOfBand,
      replaceAgentRun,
    } as unknown as AgentManager;
    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "agent-1",
      prompt: "follow up",
      mode: "steer",
    });
    // No native steer path on codex: the run is replaced instead of queued —
    // a steer's value is timely delivery, queue-until-idle can sit for tens of
    // minutes. startAgentRun still probes out-of-band with the plain prompt
    // (declined), then replaces.
    expect(tryRunOutOfBand).not.toHaveBeenCalledWith("agent-1", "/steer follow up", undefined);
    // The steer fallback is a machinery dispatch (Commander/Verifier): the
    // superseded run keeps the failure treatment, never a user interruption.
    expect(replaceAgentRun).toHaveBeenCalledWith("agent-1", "follow up", {
      replaceOrigin: "machinery",
    });
    // The caller is told the truth: this was a steer request delivered as an
    // interrupt fallback, not a native steer.
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer-interrupt" });
  });

  test("validates the attachments schema and rejects unknown attachment types", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    const uploadedFile = {
      type: "uploaded_file",
      id: "upload_1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 12,
      path: "/tmp/paseo-attachments/notes.txt",
    };
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "peer-agent-1",
        prompt: "read my notes",
        attachments: [uploadedFile],
      }),
    ).resolves.toMatchObject({
      structuredContent: { success: true, deliveryMode: "interrupt" },
    });
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "peer-agent-1",
        prompt: "read my notes",
        attachments: [{ type: "mystery_attachment", payload: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("proxies attachments to the peer via sendAgentMessage without base64", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    const attachments = [
      {
        type: "github_pr" as const,
        mimeType: "application/github-pr" as const,
        number: 12,
        title: "Fix worktree naming",
        url: "https://github.com/getpaseo/paseo/pull/12",
        baseRefName: "main",
        headRefName: "fix/worktree-naming",
      },
    ];
    await catalog.executeTool("fleet_send_prompt", {
      host: "macbook",
      agentId: "peer-agent-1",
      prompt: "review this PR",
      mode: "steer",
      attachments,
    });
    expect(client.sendAgentMessage).toHaveBeenCalledWith("peer-agent-1", "review this PR", {
      dispatchMode: "steer",
      attachments,
    });
  });

  test("renders attachments as prompt blocks for a local idle agent", async () => {
    const tryRunOutOfBand = vi.fn(() => false);
    const streamAgent = vi.fn(async function* () {});
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "codex" })),
      hasInFlightRun: vi.fn(() => false),
      tryRunOutOfBand,
      streamAgent,
    } as unknown as AgentManager;
    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
    });

    const attachments = [
      {
        type: "uploaded_file",
        id: "upload_1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        path: "/tmp/paseo-attachments/notes.txt",
      },
    ];
    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "agent-1",
      prompt: "read my notes",
      mode: "steer",
      attachments,
    });
    // The prompt becomes structured blocks: the user text plus the attachment
    // block (descriptor only — no file bytes cross the model boundary here).
    expect(streamAgent).toHaveBeenCalledWith(
      "agent-1",
      [
        { type: "text", text: "read my notes" },
        {
          type: "uploaded_file",
          id: "upload_1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 12,
          path: "/tmp/paseo-attachments/notes.txt",
        },
      ],
      { replaceOrigin: "machinery" },
    );
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });
});

// ============================================================================
// M4: Commander interaction cards (clarify / post_answer) and the generalized
// approval-gate wrap point (runCommanderGatedAction) that every mutating
// Commander tool routes through. clarify/post_answer are label-gated to the
// Commander (registered only for commander-labeled callers) and are NOT
// approval-gated: they emit feed cards attributed to the Commander, never
// side effects on the fleet.
// ============================================================================

/** A minimal MissionControlService stub exposing the M4 card + gate surface. */
function createMissionControlServiceStub(
  overrides: Record<string, unknown> = {},
): MissionControlService {
  return {
    emitCommanderCard: vi.fn(async () => ({ id: "mce_card_1" })),
    getCentralConfig: () => ({ commanderToWorkerMode: "interrupt" }),
    approvals: {
      createProposal: vi.fn(),
    },
    ...overrides,
  } as unknown as MissionControlService;
}

function createCommanderCatalog(input: {
  missionControlService: MissionControlService;
  peerManager?: PeerManager;
  agentManager?: AgentManager;
}) {
  return createPaseoToolCatalog({
    agentManager: input.agentManager ?? ({} as unknown as AgentManager),
    agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager: input.peerManager ?? ({} as unknown as PeerManager),
    callerAgentId: "commander-1",
    callerLabels: { "paseo.mission-control": "commander" },
    serverId: "host-a",
    missionControlService: input.missionControlService,
    logger: createTestLogger(),
  });
}

describe("clarify tool", () => {
  test("emits a clarification event with the full payload for the Commander caller", async () => {
    const missionControlService = createMissionControlServiceStub();
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("clarify", {
      question: "Which workspace should the backtest run in?",
      options: ["payments (existing)", "experiments (new worktree)"],
      allowFreeText: true,
    });
    expect(result.structuredContent).toEqual({ ok: true, eventId: "mce_card_1" });
    expect(missionControlService.emitCommanderCard).toHaveBeenCalledWith({
      kind: "clarification",
      headline: "Which workspace should the backtest run in?",
      clarification: {
        question: "Which workspace should the backtest run in?",
        options: ["payments (existing)", "experiments (new worktree)"],
        allowFreeText: true,
      },
    });
  });

  test("rejects non-Commander callers (label-gated like the fleet_* tools)", async () => {
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      callerAgentId: "worker-1",
      missionControlService: createMissionControlServiceStub(),
      logger: createTestLogger(),
    });
    await expect(
      catalog.executeTool("clarify", { question: "q?", options: ["a"], allowFreeText: false }),
    ).rejects.toThrow("clarify requires a Commander caller");
  });
});

describe("post_answer tool", () => {
  test("emits an agent_status answer card with fields", async () => {
    const missionControlService = createMissionControlServiceStub();
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("post_answer", {
      kind: "agent_status",
      agentId: "worker-1",
      headline: "worker-1 finished the backtest",
      fields: [
        { label: "State", value: "done" },
        { label: "Proof", value: "PR #12" },
      ],
    });
    expect(result.structuredContent).toEqual({ ok: true, eventId: "mce_card_1" });
    expect(missionControlService.emitCommanderCard).toHaveBeenCalledWith({
      kind: "answer",
      headline: "worker-1 finished the backtest",
      answer: {
        kind: "agent_status",
        agentId: "worker-1",
        headline: "worker-1 finished the backtest",
        fields: [
          { label: "State", value: "done" },
          { label: "Proof", value: "PR #12" },
        ],
      },
    });
  });

  test("emits a generic answer card with a body and no agentId", async () => {
    const missionControlService = createMissionControlServiceStub();
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("post_answer", {
      kind: "generic",
      headline: "Overnight runs: 3 done, 1 blocked",
      body: "The blocked run waits on credentials.",
    });
    expect(result.structuredContent).toEqual({ ok: true, eventId: "mce_card_1" });
    expect(missionControlService.emitCommanderCard).toHaveBeenCalledWith({
      kind: "answer",
      headline: "Overnight runs: 3 done, 1 blocked",
      answer: {
        kind: "generic",
        headline: "Overnight runs: 3 done, 1 blocked",
        body: "The blocked run waits on credentials.",
      },
    });
  });

  test("rejects agent_status without an agentId", async () => {
    const missionControlService = createMissionControlServiceStub();
    const catalog = createCommanderCatalog({ missionControlService });
    await expect(
      catalog.executeTool("post_answer", {
        kind: "agent_status",
        headline: "no target",
      }),
    ).rejects.toThrow("agentId is required when kind is agent_status");
    expect(missionControlService.emitCommanderCard).not.toHaveBeenCalled();
  });

  test("rejects non-Commander callers (label-gated like the fleet_* tools)", async () => {
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      callerAgentId: "worker-1",
      missionControlService: createMissionControlServiceStub(),
      logger: createTestLogger(),
    });
    await expect(
      catalog.executeTool("post_answer", { kind: "generic", headline: "hi" }),
    ).rejects.toThrow("post_answer requires a Commander caller");
  });
});

describe("approval-gate wrap point (runCommanderGatedAction)", () => {
  test("fleet_create_agent routes the Commander spawn through approvals.createProposal", async () => {
    const createProposal = vi.fn(async () => ({
      id: "mcp_1",
      status: "pending",
      kind: "spawn",
    }));
    const missionControlService = createMissionControlServiceStub({
      approvals: { createProposal },
    });
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("fleet_create_agent", {
      host: "local",
      provider: "codex/gpt-5.4",
      initialPrompt: "run the backtest",
      title: "backtest",
    });
    expect(createProposal).toHaveBeenCalledTimes(1);
    const proposalInput = createProposal.mock.calls[0][0];
    expect(proposalInput).toMatchObject({
      origin: "commander",
      serverId: "host-a",
      targetAgentId: "",
      kind: "spawn",
      classification: "normal",
    });
    expect(proposalInput.spawnPlan).toMatchObject({
      provider: "codex",
      summary: "Spawn backtest (codex/gpt-5.4) on local",
    });
    // Pending card: the tool reports pending-approval, never a spawned agent.
    expect(result.structuredContent).toMatchObject({
      agentId: null,
      status: "pending-approval",
    });
  });

  test("fleet_create_agent into a NEW workspace on a peer resolves labels over the peer RPC", async () => {
    const createProposal = vi.fn(async () => ({
      id: "mcp_new_ws",
      status: "pending",
      kind: "spawn",
    }));
    const missionControlService = createMissionControlServiceStub({
      approvals: { createProposal },
    });
    // The peer knows its own checkout facts; the Commander host must ask it
    // (mission_control.spawn_labels.resolve) instead of leaving the card
    // unnamed — the regression this guards against.
    const { peerManager } = createFakePeerHarness({
      client: {
        missionControlSpawnLabelsResolve: vi.fn(async () => ({
          labels: { newWorkspace: "feature/alpha", newProject: "new-thing" },
        })),
      },
    });
    const catalog = createCommanderCatalog({ missionControlService, peerManager });
    const result = await catalog.executeTool("fleet_create_agent", {
      host: "macbook",
      provider: "codex/gpt-5.4",
      cwd: "/home/ubuntu/new-thing",
      initialPrompt: "run the backtest",
      title: "backtest",
    });
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal.mock.calls[0][0].spawnPlan).toMatchObject({
      host: "macbook",
      cwd: "/home/ubuntu/new-thing",
      labels: { newWorkspace: "feature/alpha", newProject: "new-thing" },
    });
    expect(result.structuredContent).toMatchObject({
      agentId: null,
      status: "pending-approval",
    });
  });

  test("fleet_send_prompt routes the Commander send through approvals.createProposal", async () => {
    const createProposal = vi.fn(async () => ({
      id: "mcp_2",
      status: "pending",
      kind: "send",
    }));
    const missionControlService = createMissionControlServiceStub({
      approvals: { createProposal },
    });
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "worker-1",
      prompt: "continue the backtest",
      mode: "steer",
    });
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal.mock.calls[0][0]).toMatchObject({
      origin: "commander",
      serverId: "host-a",
      targetAgentId: "worker-1",
      message: "continue the backtest",
      deliveryMode: "steer",
      reason: "Commander send",
      classification: "normal",
      timelineClassification: "instruction",
    });
    expect(result.structuredContent).toMatchObject({
      success: false,
      deliveryMode: "steer",
    });
  });

  test("auto-approved sends report success and skip the pending card", async () => {
    const createProposal = vi.fn(async () => ({
      id: "mcp_3",
      status: "sent",
      kind: "send",
    }));
    const missionControlService = createMissionControlServiceStub({
      approvals: { createProposal },
    });
    const catalog = createCommanderCatalog({ missionControlService });
    const result = await catalog.executeTool("fleet_send_prompt", {
      host: "local",
      agentId: "worker-1",
      prompt: "continue",
    });
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "interrupt" });
  });

  test("non-Commander callers take the ungated path (gate requires a Commander caller)", async () => {
    const createProposal = vi.fn();
    const missionControlService = createMissionControlServiceStub({
      approvals: { createProposal },
    });
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      callerAgentId: "worker-1",
      missionControlService,
      logger: createTestLogger(),
    });
    // A worker calling fleet_create_agent on local spawns directly via
    // create_agent — never a proposal.
    await expect(
      catalog.executeTool("fleet_create_agent", {
        host: "local",
        provider: "codex/gpt-5.4",
        initialPrompt: "subtask",
      }),
    ).rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("gate failures surface as tool errors with the underlying message", async () => {
    const missionControlService = createMissionControlServiceStub({
      approvals: {
        createProposal: vi.fn(async () => {
          throw new Error("store write failed");
        }),
      },
    });
    const catalog = createCommanderCatalog({ missionControlService });
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "local",
        agentId: "worker-1",
        prompt: "continue",
      }),
    ).rejects.toThrow("store write failed");
  });
});
