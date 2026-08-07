import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { MissionControlAutopilot, type MissionControlAutopilotConfig } from "./autopilot.js";
import { MissionControlStore, type MissionControlAppendInput } from "./store.js";

function makeTimelineRow(seq: number, text: string): AgentTimelineRow {
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    item: { type: "user_message", text },
  };
}

function makeFinishedAgent(
  id: string,
  labels: Record<string, string>,
  finishedAt: string,
): ManagedAgent {
  return {
    id,
    labels,
    internal: false,
    attention: {
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date(finishedAt),
    },
  } as unknown as ManagedAgent;
}

function blockedCardCount(entries: Array<Omit<MissionControlAppendInput, "agentTitle">>): number {
  return entries.filter((entry) => entry.kind === "blocked").length;
}

const BASE_CONFIG: MissionControlAutopilotConfig = {
  mode: "observe",
  model: null,
  scope: "commander-spawned",
  maxNudgesPerAgent: 2,
  backend: "gateway",
  baseUrl: "http://gateway.test",
  apiKey: null,
};

function verdictBody(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

interface Harness {
  dir: string;
  store: MissionControlStore;
  autopilot: MissionControlAutopilot;
  published: Array<Omit<MissionControlAppendInput, "agentTitle">>;
  nudged: Array<{ agentId: string; instructions: string }>;
  emitState: (agent: ManagedAgent) => void;
  setLiveAgent: (agent: ManagedAgent) => void;
  setParentRecord: (agentId: string, labels: Record<string, string>) => void;
  setTimeline: (rows: AgentTimelineRow[]) => void;
  subscribeMock: ReturnType<typeof vi.fn>;
}

async function createHarness(overrides?: {
  config?: Partial<MissionControlAutopilotConfig>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "mc-autopilot-"));
  const store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
  await store.initialize();

  const published: Array<Omit<MissionControlAppendInput, "agentTitle">> = [];
  const nudged: Array<{ agentId: string; instructions: string }> = [];
  const liveAgents = new Map<string, ManagedAgent>();
  const parentRecords = new Map<string, { labels: Record<string, string> }>();
  let timeline: AgentTimelineRow[] = [];
  let listener: ((event: AgentManagerEvent) => void) | null = null;

  const subscribeMock = vi.fn((callback: (event: AgentManagerEvent) => void) => {
    listener = callback;
    return () => {
      listener = null;
    };
  });
  const getAgent = vi.fn((id: string) => liveAgents.get(id) ?? null);
  const getTimelineRows = vi.fn(async () => timeline);
  const storageGet = vi.fn(async (id: string) => parentRecords.get(id) ?? null);

  const autopilot = new MissionControlAutopilot({
    logger: createTestLogger(),
    store,
    agentManager: {
      subscribe: subscribeMock,
      getAgent,
      getTimelineRows,
    } as unknown as AgentManager,
    agentStorage: { get: storageGet } as unknown as AgentStorage,
    publish: (input) => {
      published.push(input);
    },
    getConfig: () => ({ ...BASE_CONFIG, ...overrides?.config }),
    dispatchNudge: async (agentId, instructions) => {
      nudged.push({ agentId, instructions });
    },
  });

  return {
    dir,
    store,
    autopilot,
    published,
    nudged,
    emitState: (agent) => {
      listener?.({ type: "agent_state", agent });
    },
    setLiveAgent: (agent) => {
      liveAgents.set(agent.id, agent);
    },
    setParentRecord: (agentId, labels) => {
      parentRecords.set(agentId, { labels });
    },
    setTimeline: (rows) => {
      timeline = rows;
    },
    subscribeMock,
  };
}

async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as { appendTail: Promise<void>; persistTail: Promise<void> };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

describe("MissionControlStore autopilot observation", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-autopilot-store-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  test("nudge count and finished ledger persist across a restart", async () => {
    store.updateObservation("agent-1", {
      autopilot: {
        nudgeCount: 2,
        lastEvaluatedSeq: 41,
        lastEvaluatedFinishedAt: "2026-01-02T00:00:00Z",
      },
    });
    await awaitStoreWrites(store);
    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getObservation("agent-1").autopilot).toEqual({
      nudgeCount: 2,
      lastEvaluatedSeq: 41,
      lastEvaluatedFinishedAt: "2026-01-02T00:00:00Z",
    });
    await awaitStoreWrites(reloaded);
  });

  test("non-autopilot observation updates keep autopilot bookkeeping", async () => {
    store.updateObservation("agent-1", { autopilot: { nudgeCount: 1 } });
    store.updateObservation("agent-1", { lastTimelineSeq: 7 });
    expect(store.getObservation("agent-1").autopilot?.nudgeCount).toBe(1);
  });
});

describe("MissionControlAutopilot", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    harness.autopilot.stop();
    await awaitStoreWrites(harness.store);
    await rm(harness.dir, { recursive: true, force: true });
  });

  const WAIT = { timeout: 2000 };

  test("mode off evaluates nothing even when finished states arrive", async () => {
    const offHarness = await createHarness({ config: { mode: "off" } });
    offHarness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    offHarness.setLiveAgent(worker);
    offHarness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    offHarness.autopilot.start();
    offHarness.emitState(worker);
    expect(offHarness.published).toEqual([]);
    expect(offHarness.nudged).toEqual([]);
    await rm(offHarness.dir, { recursive: true, force: true });
  });

  test("observe mode posts an accept verdict card without acting", async () => {
    verdictBody(JSON.stringify({ verdict: "accept", reason: "Tests are green" }));
    harness.setTimeline([makeTimelineRow(1, "Fix the flaky test")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);

    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0]).toMatchObject({
      agentId: "worker-1",
      kind: "milestone",
      source: "autopilot",
      severity: "info",
      headline: "Accepted — Tests are green",
    });
    expect(harness.nudged).toEqual([]);
    expect(harness.store.getObservation("worker-1").autopilot?.lastEvaluatedFinishedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  test("observe mode posts a nudge verdict card without sending the nudge", async () => {
    verdictBody(
      JSON.stringify({
        verdict: "nudge",
        reason: "Missing the screenshot proof",
        nudge_instructions: "Add the screenshot to the PR description.",
      }),
    );
    harness.setTimeline([makeTimelineRow(1, "Fix the flaky test")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);

    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0]).toMatchObject({
      kind: "diverged",
      source: "autopilot",
      severity: "attention",
      headline: expect.stringContaining("Nudge"),
    });
    expect(harness.published[0].detail).toBe("Add the screenshot to the PR description.");
    expect(harness.nudged).toEqual([]);
    expect(harness.store.getObservation("worker-1").autopilot?.nudgeCount).toBe(0);
  });

  test("act mode sends the nudge verbatim, counts it, and re-evaluates until the cap escalates", async () => {
    const actHarness = await createHarness({ config: { mode: "act" } });
    actHarness.setTimeline([
      makeTimelineRow(1, "Fix the flaky test"),
      makeTimelineRow(2, "Ran the suite"),
    ]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    actHarness.setLiveAgent(worker);
    actHarness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });

    const nudgeVerdict = JSON.stringify({
      verdict: "nudge",
      reason: "Add proof",
      nudge_instructions: "Attach the diff.",
    });
    verdictBody(nudgeVerdict);

    actHarness.autopilot.start();
    actHarness.emitState(worker);
    await vi.waitFor(() => expect(actHarness.nudged.length).toBe(1), WAIT);
    expect(actHarness.nudged[0]).toEqual({ agentId: "worker-1", instructions: "Attach the diff." });
    expect(actHarness.store.getObservation("worker-1").autopilot?.nudgeCount).toBe(1);

    // The nudge runs the worker again; a new finish re-evaluates.
    const secondFinish = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T01:00:00Z",
    );
    actHarness.setLiveAgent(secondFinish);
    actHarness.emitState(secondFinish);
    await vi.waitFor(() => expect(actHarness.nudged.length).toBe(2), WAIT);
    expect(actHarness.store.getObservation("worker-1").autopilot?.nudgeCount).toBe(2);

    // Third nudge verdict hits the cap: escalate instead, no prompt.
    const thirdFinish = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T02:00:00Z",
    );
    actHarness.setLiveAgent(thirdFinish);
    actHarness.emitState(thirdFinish);
    await vi.waitFor(() => expect(blockedCardCount(actHarness.published)).toBe(1), WAIT);
    expect(actHarness.nudged.length).toBe(2);
    expect(actHarness.published.at(-1)).toMatchObject({
      kind: "blocked",
      source: "autopilot",
      severity: "blocker",
      headline: expect.stringContaining("Escalated"),
      detail: expect.stringContaining("Nudge limit reached (2)"),
    });
    await rm(actHarness.dir, { recursive: true, force: true });
  });

  test("the finished-event ledger blocks re-evaluating the same transition", async () => {
    verdictBody(JSON.stringify({ verdict: "accept", reason: "Done" }));
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);
    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    harness.emitState(worker);
    harness.emitState(worker);
    expect(harness.published.length).toBe(1);
  });

  test("mission-control-labeled agents are never evaluated", async () => {
    harness.setTimeline([makeTimelineRow(1, "Dispatch")]);
    const commander = makeFinishedAgent(
      "commander-1",
      { "paseo.mission-control": "commander" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(commander);
    harness.autopilot.start();
    harness.emitState(commander);
    expect(harness.published.length).toBe(0);
  });

  test("commander-spawned scope ignores workers whose parent is not the Commander", async () => {
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "normal-agent-9" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("normal-agent-9", { "paseo.parent-agent-id": "root" });
    harness.autopilot.start();
    harness.emitState(worker);
    expect(harness.published.length).toBe(0);
  });

  test("commander-spawned scope ignores root agents without a parent label", async () => {
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const root = makeFinishedAgent("root-1", {}, "2026-01-02T00:00:00Z");
    harness.setLiveAgent(root);
    harness.autopilot.start();
    harness.emitState(root);
    expect(harness.published.length).toBe(0);
  });

  test("all scope evaluates a root agent", async () => {
    const allHarness = await createHarness({ config: { scope: "all" } });
    verdictBody(JSON.stringify({ verdict: "accept", reason: "Done" }));
    allHarness.setTimeline([makeTimelineRow(1, "Task")]);
    const root = makeFinishedAgent("root-1", {}, "2026-01-02T00:00:00Z");
    allHarness.setLiveAgent(root);
    allHarness.autopilot.start();
    allHarness.emitState(root);
    await vi.waitFor(() => expect(allHarness.published.length).toBe(1), WAIT);
    expect(allHarness.published[0].agentId).toBe("root-1");
    await rm(allHarness.dir, { recursive: true, force: true });
  });

  test("reason is truncated to 200 chars and headline to 120", async () => {
    const longReason = "r".repeat(250);
    verdictBody(JSON.stringify({ verdict: "accept", reason: longReason }));
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);
    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    // "Accepted — " (11 chars) + reason, hard-capped at 120.
    expect(harness.published[0].headline.length).toBe(120);
    expect(harness.published[0].headline.startsWith("Accepted — ")).toBe(true);
    expect(harness.published[0].headline).toContain("r".repeat(109));
  });

  test("nudge instructions are capped at 1000 chars before dispatch", async () => {
    const actHarness = await createHarness({ config: { mode: "act" } });
    verdictBody(
      JSON.stringify({
        verdict: "nudge",
        reason: "More work",
        nudge_instructions: "n".repeat(1200),
      }),
    );
    actHarness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    actHarness.setLiveAgent(worker);
    actHarness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    actHarness.autopilot.start();
    actHarness.emitState(worker);
    await vi.waitFor(() => expect(actHarness.nudged.length).toBe(1), WAIT);
    expect(actHarness.nudged[0].instructions.length).toBe(1000);
    await rm(actHarness.dir, { recursive: true, force: true });
  });

  test("gateway failure logs and posts no card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "not json" } }] }),
      })),
    );
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.published.length).toBe(0);
    expect(harness.nudged).toEqual([]);
  });

  test("gateway failure retries once with the extract tier and still posts a verdict", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "accept", reason: "Recovered via extract" }),
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    harness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    harness.setLiveAgent(worker);
    harness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    harness.autopilot.start();
    harness.emitState(worker);

    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0]).toMatchObject({
      agentId: "worker-1",
      kind: "milestone",
      headline: "Accepted — Recovered via extract",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("smart");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("extract");
  });

  test("an explicitly configured evaluator model is tried first, then extract on failure", async () => {
    const cfgHarness = await createHarness({ config: { model: "custom-tier" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "accept", reason: "Fallback worked" }),
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    cfgHarness.setTimeline([makeTimelineRow(1, "Task")]);
    const worker = makeFinishedAgent(
      "worker-1",
      { "paseo.parent-agent-id": "commander-1" },
      "2026-01-02T00:00:00Z",
    );
    cfgHarness.setLiveAgent(worker);
    cfgHarness.setParentRecord("commander-1", { "paseo.mission-control": "commander" });
    cfgHarness.autopilot.start();
    cfgHarness.emitState(worker);

    await vi.waitFor(() => expect(cfgHarness.published.length).toBe(1), WAIT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("custom-tier");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("extract");
    await rm(cfgHarness.dir, { recursive: true, force: true });
  });
});
