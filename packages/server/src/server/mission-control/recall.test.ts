import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { CentralMissionControlConfigStore } from "./config.js";
import { createMissionControlPresenceSource } from "./presence.js";
import {
  MissionControlService,
  mergeRecallResults,
  resolveRecallAttribution,
  type RecallMatchAttribution,
} from "./service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fleet-bank style recall match: run record, no omp session id. */
function fleetMatch(text: string, id: string): Record<string, unknown> {
  return {
    id,
    text,
    document_id: `paseo-run:agent-1:1`,
    tags: ["host:work-server", "agent:Rusty"],
  };
}

/** omp-bank style recall match: transcript memory with session metadata. */
function ompMatch(text: string, sessionId: string): Record<string, unknown> {
  return {
    id: sessionId,
    text,
    context: "omp",
    entities: ["view agents", "clipping bug"],
    metadata: { session_id: sessionId },
    tags: ["project:stackmod"],
  };
}

interface RecallHarnessOptions {
  hindsightSecondaryBank?: string | null;
  liveAgents?: unknown[];
  storedRecords?: unknown[];
  onFetch?: (url: string, init: RequestInit) => Response | Promise<Response>;
}

function createRecallHarness(options: RecallHarnessOptions = {}) {
  const liveAgents = options.liveAgents ?? [];
  const storedRecords = options.storedRecords ?? [];
  const onFetch = options.onFetch;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (onFetch) {
      return onFetch(url, init);
    }
    if (url.includes("/banks/omp/memories/recall")) {
      return jsonResponse({
        results: [
          ompMatch(
            "The view agents produced nothing; the assistant fixed the clipping bug.",
            "omp-session-stored",
          ),
          ompMatch("An unrelated memory from an unknown session.", "omp-session-unknown"),
        ],
      });
    }
    return jsonResponse({
      results: [
        fleetMatch("Rusty fixed the auth bug (run mcr_agent-1_1)", "mem-p1"),
        fleetMatch("Rusty shipped run records (run mcr_agent-1_2)", "mem-p2"),
      ],
    });
  }) as unknown as typeof fetch;
  // The service's HindsightClient captures fetch at construction time.
  vi.stubGlobal("fetch", fetchImpl);

  const service = new MissionControlService({
    paseoHome: dir,
    logger: createTestLogger(),
    agentManager: {
      listAgents: () => liveAgents,
      subscribe: vi.fn(() => () => {}),
      getAgent: vi.fn(() => null),
    } as unknown as AgentManager,
    agentStorage: {
      list: async () => storedRecords,
      get: async () => null,
    } as unknown as AgentStorage,
    daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
    serverId: "test-server",
    hostName: "test-host",
    broadcast: vi.fn(),
    presence: createMissionControlPresenceSource({
      isAgentFocused: () => false,
      readStopOrigin: () => null,
    }),
    centralConfig: {
      get: () => ({
        hindsightUrl: "http://hindsight.test:8890",
        hindsightBank: "paseo-fleet",
        hindsightSecondaryBank:
          options.hindsightSecondaryBank === undefined ? "omp" : options.hindsightSecondaryBank,
      }),
    } as unknown as CentralMissionControlConfigStore,
  });

  return { service, fetchImpl };
}

const LIVE_AGENT = {
  id: "agent-live-1",
  name: "Rusty",
  shortDescription: "Backend maintainer",
  workspaceId: "ws-1",
  persistence: { provider: "omp", sessionId: "omp-session-live" },
};

const STORED_RECORD = {
  id: "agent-stored-1",
  name: "Quill",
  title: "Docs agent",
  shortDescription: "Writes the docs",
  workspaceId: "ws-2",
  persistence: { provider: "omp", sessionId: "omp-session-stored" },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mc-recall-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("fleet_recall primary + secondary bank merge", () => {
  test("merges primary first, tags each match with its source bank, and respects the overall limit", async () => {
    const { service } = createRecallHarness();
    const result = await service.hindsightRecall("clipping bug", 3);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Primary matches first, then secondary; overall limit 3 respected.
    expect(result.matches.map((match) => match.text)).toEqual([
      "Rusty fixed the auth bug (run mcr_agent-1_1)",
      "Rusty shipped run records (run mcr_agent-1_2)",
      "The view agents produced nothing; the assistant fixed the clipping bug.",
    ]);
    expect(result.matches.map((match) => match.bank)).toEqual([
      "paseo-fleet",
      "paseo-fleet",
      "omp",
    ]);
  });

  test("a secondary failure degrades silently: primary results still return", async () => {
    const { service } = createRecallHarness({
      onFetch: (url) => {
        if (url.includes("/banks/omp/memories/recall")) {
          throw new Error("ECONNREFUSED");
        }
        return jsonResponse({
          results: [fleetMatch("Rusty fixed the auth bug (run mcr_agent-1_1)", "mem-p1")],
        });
      },
    });
    const result = await service.hindsightRecall("auth bug", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].text).toBe("Rusty fixed the auth bug (run mcr_agent-1_1)");
    expect(result.matches[0].bank).toBe("paseo-fleet");
  });

  test("no secondary bank configured: primary only, no omp recall attempt", async () => {
    const { service, fetchImpl } = createRecallHarness({ hindsightSecondaryBank: null });
    const result = await service.hindsightRecall("auth bug", 5);
    expect(result.ok).toBe(true);
    const ompCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/banks/omp/memories/recall"),
    );
    expect(ompCalls).toHaveLength(0);
    if (!result.ok) {
      return;
    }
    expect(result.matches.every((match) => match.bank === "paseo-fleet")).toBe(true);
  });

  test("a primary failure returns memory unavailable even when the secondary would succeed", async () => {
    const { service } = createRecallHarness({
      onFetch: (url) => {
        if (url.includes("/banks/omp/memories/recall")) {
          return jsonResponse({ results: [ompMatch("secondary only", "omp-session-stored")] });
        }
        throw new Error("timeout");
      },
    });
    const result = await service.hindsightRecall("anything", 5);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("memory unavailable");
  });
});

describe("fleet_recall omp session-id attribution", () => {
  test("resolves a stored record's persistence session id into agent attribution", async () => {
    const { service } = createRecallHarness({
      storedRecords: [STORED_RECORD],
      onFetch: (url) =>
        url.includes("/banks/omp/memories/recall")
          ? jsonResponse({
              results: [
                ompMatch(
                  "The view agents produced nothing; the assistant fixed the clipping bug.",
                  "omp-session-stored",
                ),
                ompMatch("Memory from an unknown session.", "omp-session-unknown"),
              ],
            })
          : jsonResponse({ results: [fleetMatch("primary", "mem-p1")] }),
    });
    const result = await service.hindsightRecall("clipping bug", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const attributed = result.matches.find((match) => match.sessionId === "omp-session-stored");
    expect(attributed?.attribution).toEqual<RecallMatchAttribution>({
      agentId: "agent-stored-1",
      agentName: "Quill",
      agentTitle: "Docs agent",
      workspaceId: "ws-2",
    });
    // Unresolved matches pass the raw session_id, tags, and entities through
    // with no attribution, so the Commander can fleet_search them.
    const unresolved = result.matches.find((match) => match.sessionId === "omp-session-unknown");
    expect(unresolved?.attribution).toBeUndefined();
    expect(unresolved?.sessionId).toBe("omp-session-unknown");
    expect(unresolved?.entities).toEqual(["view agents", "clipping bug"]);
    expect(unresolved?.tags).toEqual(["project:stackmod"]);
    // Fleet-bank matches (no session id) never gain an attribution block.
    const fleetMatchResult = result.matches.find((match) => match.bank === "paseo-fleet");
    expect(fleetMatchResult?.attribution).toBeUndefined();
  });

  test("resolves a live agent's persistence session id (live wins over stored)", async () => {
    // The stored record carries the same session id; the live agent must win.
    const { service } = createRecallHarness({
      liveAgents: [LIVE_AGENT],
      storedRecords: [
        { ...STORED_RECORD, persistence: { provider: "omp", sessionId: "omp-session-live" } },
      ],
      onFetch: (url) =>
        url.includes("/banks/omp/memories/recall")
          ? jsonResponse({ results: [ompMatch("live session memory", "omp-session-live")] })
          : jsonResponse({ results: [] }),
    });
    const result = await service.hindsightRecall("live", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.matches[0].attribution).toEqual<RecallMatchAttribution>({
      agentId: "agent-live-1",
      agentName: "Rusty",
      agentTitle: "Backend maintainer",
      workspaceId: "ws-1",
    });
  });
});

describe("mergeRecallResults / resolveRecallAttribution (pure)", () => {
  test("mergeRecallResults: primary first, secondary appended, limit respected", () => {
    const primary = {
      ok: true as const,
      matches: [
        { id: "p1", text: "primary-1", bank: "paseo-fleet" } as never,
        { id: "p2", text: "primary-2", bank: "paseo-fleet" } as never,
      ],
    };
    const secondary = {
      ok: true as const,
      matches: [{ id: "s1", text: "secondary-1", bank: "omp" } as never],
    };
    const merged = mergeRecallResults(primary, secondary, 2);
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.matches.map((match) => match.id)).toEqual(["p1", "p2"]);
  });

  test("mergeRecallResults: failed secondary degrades to primary only", () => {
    const primary = {
      ok: true as const,
      matches: [{ id: "p1", text: "primary-1", bank: "paseo-fleet" } as never],
    };
    const secondary = { ok: false as const, reason: "memory unavailable" as const, error: "boom" };
    const merged = mergeRecallResults(primary, secondary, 5);
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.matches).toHaveLength(1);
    expect(merged.matches[0].id).toBe("p1");
  });

  test("mergeRecallResults: a failed primary is the failure (no secondary substitution)", () => {
    const primary = { ok: false as const, reason: "memory unavailable" as const, error: "timeout" };
    const secondary = {
      ok: true as const,
      matches: [{ id: "s1", text: "secondary-1", bank: "omp" } as never],
    };
    expect(mergeRecallResults(primary, secondary, 5)).toEqual(primary);
  });

  test("resolveRecallAttribution: matches a fixture record by persistence session id", () => {
    const live: Array<{
      id: string;
      sessionId: string | null;
      name?: string;
      title?: string | null;
      shortDescription?: string;
      workspaceId?: string | null;
    }> = [
      { id: "agent-1", sessionId: "omp-session-1", name: "Rusty", shortDescription: "Backend" },
    ];
    const stored = [
      {
        id: "agent-2",
        sessionId: "omp-session-2",
        name: "Quill",
        title: "Docs agent",
        shortDescription: "Writes the docs",
        workspaceId: "ws-2",
      },
    ];
    expect(resolveRecallAttribution("omp-session-1", live, stored)).toEqual<RecallMatchAttribution>(
      {
        agentId: "agent-1",
        agentName: "Rusty",
        agentTitle: "Backend",
        workspaceId: null,
      },
    );
    expect(resolveRecallAttribution("omp-session-2", live, stored)).toEqual<RecallMatchAttribution>(
      {
        agentId: "agent-2",
        agentName: "Quill",
        agentTitle: "Docs agent",
        workspaceId: "ws-2",
      },
    );
    // Unknown session ids resolve to nothing (Commander fleet_searches them).
    expect(resolveRecallAttribution("omp-session-missing", live, stored)).toBeNull();
  });

  test("resolveRecallAttribution prefers the live agent over a stored record", () => {
    const live = [
      {
        id: "agent-live",
        sessionId: "omp-session-shared",
        name: "LiveName",
        shortDescription: "Live title",
        workspaceId: "ws-live",
      },
    ];
    const stored = [
      {
        id: "agent-stored",
        sessionId: "omp-session-shared",
        name: "StoredName",
        title: "Stored title",
        workspaceId: "ws-stored",
      },
    ];
    expect(
      resolveRecallAttribution("omp-session-shared", live, stored),
    ).toEqual<RecallMatchAttribution>({
      agentId: "agent-live",
      agentName: "LiveName",
      agentTitle: "Live title",
      workspaceId: "ws-live",
    });
  });
});
