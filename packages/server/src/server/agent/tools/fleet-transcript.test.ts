import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const AGENT_ID = "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a";
const PEER_AGENT_ID = "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d";

interface TranscriptPage {
  ok: boolean;
  entries: Array<{ seq: number; turnId: string | null; item: Record<string, unknown> }>;
  olderCursor: string | null;
  newerCursor: string | null;
  truncatedFields: number;
  error?: string;
}

/** A closed agent whose stored timeline holds `turns` turns of user/tool/assistant rows. */
function createHarness(
  turns: number,
  options: { peerClient?: Partial<DaemonClient>; answer?: (turn: number) => string } = {},
) {
  const peerClient = options.peerClient;
  const store = new InMemoryAgentTimelineStore();
  const items: Array<{ item: AgentTimelineItem; turnId: string }> = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const turnId = `turn-${turn}`;
    items.push({ turnId, item: { type: "user_message", text: `ask ${turn}` } });
    items.push({
      turnId,
      item: {
        type: "tool_call",
        callId: `call-${turn}`,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: `echo ${turn}`, output: `out ${turn}` },
      } as AgentTimelineItem,
    });
    items.push({
      turnId,
      item: { type: "assistant_message", text: options.answer?.(turn) ?? `answer ${turn}` },
    });
  }
  const loadAgent = vi.fn();
  const agentManager = {
    getAgent: () => null,
    listAgents: () => [],
    hasTimeline: (id: string) => store.has(id),
    seedTimelineForRehydrate: async (id: string) => {
      if (store.has(id)) return false;
      store.initialize(id);
      for (const { item, turnId } of items) store.append(id, item, { turnId });
      return true;
    },
    seedTimelineFromItems: (id: string) => store.initialize(id),
    fetchTimeline: (id: string, fetchOptions: Parameters<InMemoryAgentTimelineStore["fetch"]>[1]) =>
      store.fetch(id, fetchOptions),
    // Reading a transcript must never start the provider.
    ensureAgentLoaded: loadAgent,
    resumeAgentFromPersistence: loadAgent,
  } as unknown as AgentManager;
  const agentStorage = {
    get: async (id: string) =>
      id === AGENT_ID ? { id, provider: "omp", cwd: "/work", lastStatus: "closed" } : null,
    list: async () => [{ id: AGENT_ID }],
  } as unknown as AgentStorage;
  const client = {
    fetchAgentTimeline: vi.fn(async () => ({ entries: [], error: null })),
    ...peerClient,
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) =>
      name === "macbook" ? { name, state: "online", lastSeenAt: null } : null,
    getPeerStatuses: () => [{ name: "macbook", state: "online", lastSeenAt: null, url: "ws://m" }],
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
    logger: createTestLogger(),
  });
  const read = async (args: Record<string, unknown>) =>
    (await catalog.executeTool("fleet_get_transcript", { agentId: AGENT_ID, ...args }))
      .structuredContent as TranscriptPage;
  return { read, loadAgent, client, catalog };
}

describe("fleet_get_transcript", () => {
  test("paging older from the tail returns every entry exactly once, oldest page last", async () => {
    const { read, loadAgent } = createHarness(10);
    const seen: number[] = [];
    let page = await read({ limit: 7 });
    for (;;) {
      seen.push(...page.entries.map((entry) => entry.seq));
      if (!page.olderCursor) break;
      page = await read({ cursor: page.olderCursor, limit: 7 });
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(30);
    expect(loadAgent).not.toHaveBeenCalled();
  });

  test("tool calls carry their input and output inline", async () => {
    const { read } = createHarness(1);
    const page = await read({ types: ["tool_call"] });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.item).toMatchObject({
      type: "tool_call",
      status: "completed",
      detail: { command: "echo 1", output: "out 1" },
    });
  });

  test("turnId filters to one turn; newerCursor picks up only later entries", async () => {
    const { read } = createHarness(3);
    const turn = await read({ turnId: "turn-2", limit: 200 });
    expect(turn.entries.map((entry) => entry.turnId)).toEqual(["turn-2", "turn-2", "turn-2"]);

    const tail = await read({ limit: 200 });
    const after = await read({ cursor: tail.newerCursor, direction: "newer" });
    expect(after.entries).toEqual([]);
    // Polling with no new rows keeps the caller's position.
    expect(after.newerCursor).toBe(tail.newerCursor);
  });

  test("long fields are cut at maxFieldChars and counted; short ones are untouched", async () => {
    const { read } = createHarness(2, { answer: (turn) => (turn === 1 ? "x".repeat(500) : "ok") });
    const page = await read({ maxFieldChars: 200, types: ["assistant_message"] });
    expect(page.truncatedFields).toBe(1);
    const [long, short] = page.entries.map((entry) => entry.item.text as string);
    expect(long).toBe(`${"x".repeat(200)}\n[truncated 300 chars]`);
    expect(short).toBe("ok");
  });

  test("a malformed cursor is rejected with guidance", async () => {
    const { catalog } = createHarness(1);
    await expect(
      catalog.executeTool("fleet_get_transcript", { agentId: AGENT_ID, cursor: "nope" }),
    ).rejects.toThrow(/olderCursor\/newerCursor/);
  });

  test("a peer agent pages through the peer's timeline RPC", async () => {
    const fetchAgentTimeline = vi.fn(async () => ({
      epoch: "ep-1",
      reset: false,
      staleCursor: false,
      hasOlder: true,
      hasNewer: false,
      startCursor: { epoch: "ep-1", seq: 40 },
      endCursor: { epoch: "ep-1", seq: 41 },
      entries: [
        {
          seqStart: 40,
          seqEnd: 40,
          turnId: "t-9",
          timestamp: "2026-10-12T00:00:00.000Z",
          item: { type: "user_message", text: "remote ask" },
        },
        {
          seqStart: 41,
          seqEnd: 41,
          turnId: "t-9",
          timestamp: "2026-10-12T00:00:01.000Z",
          item: { type: "assistant_message", text: "remote answer" },
        },
      ],
      error: null,
    }));
    const { catalog } = createHarness(0, { peerClient: { fetchAgentTimeline } as never });
    const result = await catalog.executeTool("fleet_get_transcript", {
      agentId: PEER_AGENT_ID,
      host: "macbook",
      limit: 2,
    });
    const page = result.structuredContent as TranscriptPage & { host: string };
    expect(fetchAgentTimeline).toHaveBeenCalledWith(PEER_AGENT_ID, {
      direction: "tail",
      limit: 2,
    });
    expect(page.host).toBe("macbook");
    expect(page.entries.map((entry) => entry.seq)).toEqual([40, 41]);
    expect(page.olderCursor).toBeTruthy();

    await catalog.executeTool("fleet_get_transcript", {
      agentId: PEER_AGENT_ID,
      host: "macbook",
      cursor: page.olderCursor,
      limit: 2,
    });
    expect(fetchAgentTimeline).toHaveBeenLastCalledWith(PEER_AGENT_ID, {
      direction: "before",
      cursor: { epoch: "ep-1", seq: 40 },
      limit: 2,
    });
  });
});
