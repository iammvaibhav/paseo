import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { MissionControlService } from "./service.js";
import { CentralMissionControlConfigStore } from "./config.js";
import { MissionControlStore } from "./store.js";
import { createMissionControlPresenceSource } from "./presence.js";
import type { ProposalCreateInput } from "./approvals.js";

/**
 * Ready-for-review scope discipline: under evaluationScope "all" a bare run
 * end (a conversational session finishing a turn) must NEVER move an agent
 * to ready-for-review — only an auditable run (launch brief AND at least one
 * report_status this run) or an explicit `status: "completed"` self-report
 * does. Under "commander" the default behavior is unchanged (every finished
 * run is marked ready; the verifier's own scope filter decides).
 */

function createMockLogger(): pino.Logger {
  const logger: Record<string, unknown> = { child: () => logger };
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    logger[level] = vi.fn();
  }
  return logger as unknown as pino.Logger;
}

/** Minimal agent state the service accepts from agent_state events. */
function agentState(agentId: string, overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "running",
    labels: {},
    internal: false,
    attention: { requiresAttention: false },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
    ...overrides,
  } as unknown as ManagedAgent;
}

/** A run that just ended with attention "finished" (the manager's terminal state). */
function finishedAgent(agentId: string): ManagedAgent {
  return agentState(agentId, {
    lifecycle: "idle",
    attention: {
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date(),
    },
  });
}

interface ReviewScopeHarness {
  service: MissionControlService;
  emit: (event: AgentManagerEvent) => void;
  startRunning: (agentId: string, overrides?: Partial<ManagedAgent>) => void;
  finishRun: (agentId: string) => void;
  streamTimeline: (agentId: string, seq: number, item: AgentTimelineItem) => void;
  cleanup: () => Promise<void>;
}

async function createHarness(scope: "commander" | "all"): Promise<ReviewScopeHarness> {
  const dir = await mkdtemp(join(tmpdir(), "mc-review-scope-"));
  const centralConfig = new CentralMissionControlConfigStore({
    paseoHome: dir,
    logger: createMockLogger(),
  });
  await centralConfig.initialize();
  if (scope === "all") {
    await centralConfig.patch({ evaluationScope: "all" });
  }
  let onEvent: ((event: AgentManagerEvent) => void) | null = null;
  const service = new MissionControlService({
    paseoHome: dir,
    logger: createMockLogger(),
    agentManager: {
      getAgent: vi.fn(() => null),
      subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
        onEvent = cb;
        return () => {};
      }),
    } as unknown as AgentManager,
    agentStorage: { get: async () => null } as unknown as AgentStorage,
    daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
    centralConfig,
    serverId: "test-server",
    hostName: "test-host",
    broadcast: vi.fn(),
    presence: createMissionControlPresenceSource({
      isAgentFocused: () => false,
      readStopOrigin: () => null,
    }),
  });
  await service.start();

  // The ready-for-review decision is synchronous once handleAgentState runs
  // (setReviewState mutates the in-memory map before its first await), so
  // each emit below is followed by a direct assertion — no timers.
  const emit = (event: AgentManagerEvent): void => onEvent?.(event);
  const startRunning = (agentId: string, overrides: Partial<ManagedAgent> = {}): void =>
    emit({ type: "agent_state", agent: agentState(agentId, overrides) });
  const finishRun = (agentId: string): void =>
    emit({ type: "agent_state", agent: finishedAgent(agentId) });
  const streamTimeline = (agentId: string, seq: number, item: AgentTimelineItem): void =>
    emit({
      type: "agent_stream",
      agentId,
      seq,
      event: { type: "timeline", provider: "omp", item },
    });

  return {
    service,
    emit,
    startRunning,
    finishRun,
    streamTimeline,
    // Drain the store's fire-and-forget write tails so the temp dir can be
    // removed (append/persist tails are private fields; the shape is stable).
    cleanup: async () => {
      await service.stop();
      const internals = service as unknown as { store: MissionControlStore };
      const tails = internals.store as unknown as {
        appendTail: Promise<void>;
        persistTail: Promise<void>;
      };
      await Promise.all([tails.appendTail, tails.persistTail]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("ready-for-review under evaluationScope all", () => {
  let harness: ReviewScopeHarness;

  beforeEach(async () => {
    harness = await createHarness("all");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("a conversational agent finishing a turn never becomes ready-for-review", () => {
    harness.startRunning("agent-chat");
    harness.finishRun("agent-chat");
    expect(harness.service.getReviewState("agent-chat")).toMatchObject({ reviewState: "none" });
    expect(harness.service.getReadyForReview()).not.toContain("agent-chat");
  });

  test("a chat session WITH a user message but no report_status is still not auditable", () => {
    // A hand-started agent's first prompt IS a user_message row — the brief
    // alone must never qualify a run; report_status history is the
    // dispatched-worker discriminator.
    harness.startRunning("agent-chat2");
    harness.streamTimeline("agent-chat2", 1, { type: "user_message", text: "Just chat with me" });
    harness.finishRun("agent-chat2");
    expect(harness.service.getReviewState("agent-chat2")).toMatchObject({ reviewState: "none" });
  });

  test("a worker that reported status but has no launch brief is not auditable", async () => {
    harness.startRunning("agent-orphan");
    await harness.service.reportSelfStatus("agent-orphan", {
      status: "working",
      headline: "Progress without a brief",
    });
    harness.finishRun("agent-orphan");
    expect(harness.service.getReviewState("agent-orphan")).toMatchObject({ reviewState: "none" });
  });

  test("a dispatched worker with a brief + prior reports finishing its run IS ready", async () => {
    harness.startRunning("agent-worker");
    harness.streamTimeline("agent-worker", 1, {
      type: "user_message",
      text: "Ship the flaky-test fix",
    });
    await harness.service.reportSelfStatus("agent-worker", {
      status: "working",
      headline: "Reproduced the flake",
    });
    harness.finishRun("agent-worker");
    expect(harness.service.getReviewState("agent-worker")).toMatchObject({ reviewState: "ready" });
  });

  test("reports from an EARLIER run do not make a later conversational turn auditable", async () => {
    // Deterministic clock so run two provably starts after run one's report
    // (both land in the same real millisecond otherwise).
    vi.useFakeTimers();
    try {
      // Run 1: dispatched worker reports progress, ends without attention.
      harness.startRunning("agent-rerun");
      await harness.service.reportSelfStatus("agent-rerun", {
        status: "working",
        headline: "Run-one progress",
      });
      vi.advanceTimersByTime(1_000);
      harness.emit({
        type: "agent_state",
        agent: agentState("agent-rerun", { lifecycle: "idle" }),
      });
      // Run 2: the same agent is now used conversationally (brief, no report).
      harness.startRunning("agent-rerun");
      harness.streamTimeline("agent-rerun", 2, {
        type: "user_message",
        text: "Now just help me chat",
      });
      harness.finishRun("agent-rerun");
      // The run-one report predates run two's start, so "this run" is empty.
      expect(harness.service.getReviewState("agent-rerun")).toMatchObject({ reviewState: "none" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("an explicit completed self-report IS ready under scope all", async () => {
    const result = await harness.service.reportSelfStatus("agent-done", {
      status: "completed",
      headline: "Everything asked is done",
      proofs: [{ kind: "url", url: "https://example.com/evidence" }],
    });
    expect(result.ok).toBe(true);
    expect(harness.service.getReviewState("agent-done")).toMatchObject({ reviewState: "ready" });
  });
});

describe("ready-for-review under evaluationScope commander (default unchanged)", () => {
  let harness: ReviewScopeHarness;

  beforeEach(async () => {
    harness = await createHarness("commander");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("a finished run is marked ready even without brief or reports (scope filter downstream)", () => {
    harness.startRunning("agent-plain");
    harness.finishRun("agent-plain");
    expect(harness.service.getReviewState("agent-plain")).toMatchObject({ reviewState: "ready" });
    expect(harness.service.getReadyForReview()).toContain("agent-plain");
  });
});

describe("Commander adoption (verifier scope feeding)", () => {
  interface AdoptionHarness {
    service: MissionControlService;
    worker: ManagedAgent;
    setLabels: Mock;
    setWorker: (agent: ManagedAgent) => void;
    cleanup: () => Promise<void>;
  }

  function makeAdoptableWorker(id: string): ManagedAgent {
    return {
      id,
      labels: {},
      internal: false,
      provider: "omp",
      cwd: `/tmp/${id}`,
      lifecycle: "idle",
      name: `Name-${id}`,
      session: { isRuntimeAlive: () => true },
      config: { provider: "omp", cwd: `/tmp/${id}`, title: `Title-${id}` },
    } as unknown as ManagedAgent;
  }

  async function createAdoptionHarness(): Promise<AdoptionHarness> {
    const dir = await mkdtemp(join(tmpdir(), "mc-adoption-"));
    const centralConfig = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createMockLogger(),
    });
    await centralConfig.initialize();
    const liveAgents = new Map<string, ManagedAgent>();
    liveAgents.set("worker-1", makeAdoptableWorker("worker-1"));
    // A minimal live surface that lets an idle STEER delivery succeed through
    // dispatchLocalPromptMode → startAgentRun: idle (no replace), no
    // out-of-band interception, a drainable empty stream.
    const setLabels = vi.fn(async (agentId: string, labels: Record<string, string>) => {
      const agent = liveAgents.get(agentId);
      if (agent) {
        agent.labels = { ...agent.labels, ...labels };
      }
    });
    const service = new MissionControlService({
      paseoHome: dir,
      logger: createMockLogger(),
      agentManager: {
        getAgent: (agentId) => liveAgents.get(agentId) ?? null,
        subscribe: vi.fn(() => () => {}),
        hasInFlightRun: () => false,
        tryRunOutOfBand: () => false,
        streamAgent: async function* () {},
        setLabels,
      } as unknown as AgentManager,
      agentStorage: { get: async () => null } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      centralConfig,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
    });
    await service.start();
    return {
      service,
      worker: liveAgents.get("worker-1")!,
      setLabels,
      setWorker: (agent) => {
        liveAgents.set(agent.id, agent);
      },
      cleanup: async () => {
        await service.stop();
        const internals = service as unknown as { store: MissionControlStore };
        const tails = internals.store as unknown as {
          appendTail: Promise<void>;
          persistTail: Promise<void>;
        };
        await Promise.all([tails.appendTail, tails.persistTail]);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  function commanderSend(targetAgentId: string): ProposalCreateInput {
    return {
      origin: "commander",
      serverId: "test-server",
      targetAgentId,
      message: "Ship the flaky-test fix",
      deliveryMode: "steer",
      reason: "Commander send",
      classification: "normal",
      timelineClassification: "instruction",
    };
  }

  let harness: AdoptionHarness;

  beforeEach(async () => {
    harness = await createAdoptionHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("a delivered commander-origin send adopts the worker", async () => {
    const proposal = await harness.service.approvals.createProposal(commanderSend("worker-1"));
    // Ask mode (default): the send sits pending until approved; adoption must
    // fire on DELIVERY, not on proposal creation.
    expect(proposal.status).toBe("pending");
    const resolved = await harness.service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "approve",
    });
    expect(resolved.ok).toBe(true);
    const adoptedAt = harness.worker.labels["paseo.commander-adopted-at"];
    expect(typeof adoptedAt).toBe("string");
    expect(Number.isNaN(Date.parse(adoptedAt as string))).toBe(false);
    expect(harness.setLabels).toHaveBeenCalledTimes(1);
  });

  test("repeated commander sends do not duplicate the marker (first adoption wins)", async () => {
    const first = await harness.service.approvals.createProposal(commanderSend("worker-1"));
    await harness.service.approvals.resolveProposal({ proposalId: first.id, action: "approve" });
    const adoptedAt = harness.worker.labels["paseo.commander-adopted-at"];
    expect(adoptedAt).toBeTruthy();

    const second = await harness.service.approvals.createProposal(commanderSend("worker-1"));
    await harness.service.approvals.resolveProposal({ proposalId: second.id, action: "approve" });

    expect(harness.worker.labels["paseo.commander-adopted-at"]).toBe(adoptedAt);
    expect(harness.setLabels).toHaveBeenCalledTimes(1);
  });

  test("auto mode adopts too (the same deliver funnel)", async () => {
    await harness.service.setMode("auto");
    const proposal = await harness.service.approvals.createProposal(commanderSend("worker-1"));
    expect(proposal.status).toBe("sent");
    expect(typeof harness.worker.labels["paseo.commander-adopted-at"]).toBe("string");
    expect(harness.setLabels).toHaveBeenCalledTimes(1);
  });

  test("stall status-ask nudges never adopt a worker", async () => {
    const proposal = await harness.service.approvals.createProposal({
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Post a one-line report_status, then continue.",
      deliveryMode: "steer",
      reason: "No timeline output mid-run",
      classification: "normal",
      forceSend: true,
    });
    expect(proposal.status).toBe("sent");
    expect(harness.worker.labels["paseo.commander-adopted-at"]).toBeUndefined();
    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  test("verifier-to-worker contacts never adopt a worker", async () => {
    const proposal = await harness.service.approvals.createProposal({
      origin: "verifier",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Prove the fix with a failing test.",
      deliveryMode: "steer",
      reason: "Verifier clarification request",
      classification: "normal",
    });
    await harness.service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "approve",
    });
    expect(harness.worker.labels["paseo.commander-adopted-at"]).toBeUndefined();
    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  test("mission-control machinery is never adopted (Commander itself)", async () => {
    harness.setWorker({
      ...makeAdoptableWorker("commander-1"),
      labels: { "paseo.mission-control": "commander" },
    } as ManagedAgent);
    const result = await harness.service.recordCommanderAdoption("commander-1");
    expect(result).toBeNull();
    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  test("an agent that is not live is never adopted", async () => {
    const result = await harness.service.recordCommanderAdoption("ghost");
    expect(result).toBeNull();
    expect(harness.setLabels).not.toHaveBeenCalled();
  });
});
