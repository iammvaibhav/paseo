import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

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

function createCatalog(peerManager: PeerManager, agentManager?: AgentManager) {
  return createPaseoToolCatalog({
    agentManager: agentManager ?? ({} as unknown as AgentManager),
    agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
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
});

describe("fleet_send_prompt mode", () => {
  test("validates the schema: mode defaults to steer and rejects unknown modes", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
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
        mode: "replace",
      }),
    ).rejects.toThrow();
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
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "omp" })),
      hasInFlightRun: vi.fn(() => true),
      tryRunOutOfBand,
      streamAgent,
    } as unknown as AgentManager;
    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: {} as unknown as AgentStorage,
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
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });

  test("queues behind a busy non-omp agent instead of cancelling", async () => {
    const tryRunOutOfBand = vi.fn(() => false);
    const streamAgent = vi.fn(async function* () {});
    // First check reports busy (steer busy probe); the wait loop then sees idle.
    let busy = true;
    const agentManager = {
      getAgent: vi.fn(() => ({ provider: "codex" })),
      hasInFlightRun: vi.fn(() => {
        const current = busy;
        busy = false;
        return current;
      }),
      tryRunOutOfBand,
      streamAgent,
    } as unknown as AgentManager;
    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage: {} as unknown as AgentStorage,
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
    // Never steers a non-omp provider via the /steer prefix; the message
    // queues instead (startAgentRun still probes out-of-band with the plain
    // prompt, which the provider declines).
    expect(tryRunOutOfBand).not.toHaveBeenCalledWith("agent-1", "/steer follow up", undefined);
    expect(streamAgent).toHaveBeenCalledWith("agent-1", "follow up", undefined);
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "queue" });
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
    ).resolves.toMatchObject({ structuredContent: { success: true, deliveryMode: "steer" } });
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
      agentStorage: {} as unknown as AgentStorage,
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
      undefined,
    );
    expect(result.structuredContent).toEqual({ success: true, deliveryMode: "steer" });
  });
});
