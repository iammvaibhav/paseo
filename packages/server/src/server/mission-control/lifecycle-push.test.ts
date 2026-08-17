import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import type { AgentSnapshotPayload } from "../messages.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { MissionControlService } from "./service.js";
import { MissionControlStore } from "./store.js";
import type { MissionControlEvent } from "./store.js";
import { createMissionControlPresenceSource } from "./presence.js";

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

function runningAgent(agentId: string, overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "running",
    labels: {},
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
    ...overrides,
  } as unknown as ManagedAgent;
}

function storedRecord(
  agentId: string,
  overrides: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id: agentId,
    name: "Test Agent",
    title: "Test title",
    provider: "omp",
    cwd: "/tmp",
    status: "idle",
    lastStatus: "idle",
    labels: {},
    internal: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as StoredAgentRecord;
}

/**
 * F1 (user-stop terminal card) + F2 (reviewState-change agent push) against
 * the in-process MissionControlService harness. The interrupted event is the
 * board's only source of the stoppedBy:'user' snapshot (lifecycle.ts
 * resolveDoneReason); the reviewState push is what reconciles the fetch_agents
 * bucket field / board sections / sidebar badge without a reload.
 */
describe("MissionControlService lifecycle push", () => {
  let dir: string;
  let service: MissionControlService;
  let store: MissionControlStore;
  let broadcast: ReturnType<typeof vi.fn>;
  let onEvent: ((event: AgentManagerEvent) => void) | null;
  let getAgent: ReturnType<typeof vi.fn>;
  let notifyAgentState: ReturnType<typeof vi.fn>;
  let getRecord: ReturnType<typeof vi.fn>;
  let onReviewStateChanged: ReturnType<typeof vi.fn>;
  let liveAgent: ManagedAgent | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-lifecycle-push-"));
    broadcast = vi.fn();
    getAgent = vi.fn(() => liveAgent);
    liveAgent = null;
    notifyAgentState = vi.fn();
    getRecord = vi.fn(async () => null);
    onReviewStateChanged = vi.fn();
    onEvent = null;
    service = new MissionControlService({
      paseoHome: dir,
      logger: createMockLogger(),
      agentManager: {
        getAgent,
        notifyAgentState,
        updateAgentMetadata: vi.fn(async () => undefined),
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          onEvent = cb;
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: getRecord,
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast,
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      onReviewStateChanged,
    });
    await service.start();
    (service as unknown as { bootedAtMs: number }).bootedAtMs = Date.now() - 120_000;
    store = (service as unknown as { store: MissionControlStore }).store;
    (service as unknown as { approvals: Record<string, unknown> }).approvals = {
      createProposal: vi.fn(async () => ({ id: "mcp_test" })),
      expirePendingForAgent: vi.fn(async () => undefined),
      listProposals: vi.fn(() => []),
    };
  });

  afterEach(async () => {
    await service.stop();
    const internals = store as unknown as {
      appendTail: Promise<void>;
      persistTail: Promise<void>;
    };
    await Promise.all([internals.appendTail, internals.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function events(): MissionControlEvent[] {
    return broadcast.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; event?: MissionControlEvent })
      .filter((message) => message?.type === "mission_control_event")
      .map((message) => message.event as MissionControlEvent);
  }

  function interruptedEvents(): MissionControlEvent[] {
    return events().filter((event) => event.kind === "interrupted");
  }

  /** The run starts (lifecycle→running), clearing any prior stop origin. */
  function startRunning(): void {
    liveAgent = runningAgent("agent-1");
    onEvent?.({ type: "agent_state", agent: liveAgent });
  }

  /** A user cancel: turn_canceled hop to idle, no attention latch. */
  function cancelRun(): void {
    liveAgent = runningAgent("agent-1", { lifecycle: "idle" });
    onEvent?.({ type: "agent_state", agent: liveAgent });
  }

  // ==========================================================================
  // F1: the user-stop terminal card
  // ==========================================================================

  test("a user-origin cancel of a running turn emits one interrupted event with stoppedBy user", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    cancelRun();
    await flush();

    expect(interruptedEvents()).toHaveLength(1);
    expect(interruptedEvents()[0]).toMatchObject({
      agentId: "agent-1",
      kind: "interrupted",
      source: "system",
      severity: "info",
      headline: "Interrupted by you",
      // The board's 'Stopped by you' chip reads this snapshot
      // (lifecycle.ts resolveDoneReason).
      stoppedBy: "user",
    });
  });

  test("the interrupted card is deduped within the run epoch across the error-card path", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    // The cancel hop emits the card…
    cancelRun();
    // …and the provider abort ALSO surfaces as turn_failed with the
    // user-abort signature: the error-card path must not emit a second one.
    onEvent?.({
      type: "agent_stream",
      agentId: "agent-1",
      seq: 1,
      event: {
        type: "turn_failed",
        provider: "omp",
        error: "Interrupted by user (stopReason=aborted, model=omp)",
      } as never,
    });
    await flush();

    expect(interruptedEvents()).toHaveLength(1);
  });

  test("a new run epoch earns a fresh interrupted card; the previous run stays single", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    cancelRun();
    await flush();
    expect(interruptedEvents()).toHaveLength(1);

    // Second run: the running transition clears the origin, the user stops
    // again — a NEW epoch, so a new card.
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    cancelRun();
    await flush();

    expect(interruptedEvents()).toHaveLength(2);
  });

  test("machinery and system stops keep their existing behavior (no interrupted card)", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "machinery");
    cancelRun();
    await flush();
    expect(interruptedEvents()).toHaveLength(0);

    startRunning();
    store.recordStopOrigin("agent-1", "system");
    cancelRun();
    await flush();
    expect(interruptedEvents()).toHaveLength(0);
  });

  test("a user replace (interrupt-and-send) stays silent: no interrupted card", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    liveAgent = runningAgent("agent-1", {
      lifecycle: "idle",
      pendingReplacement: true,
      pendingReplacementOrigin: "user",
    });
    onEvent?.({ type: "agent_state", agent: liveAgent });
    await flush();

    // The superseded run's abort is machinery noise; the new run's own
    // started card is the story.
    expect(interruptedEvents()).toHaveLength(0);
  });

  test("a run that ended through the clean-finish latch reads as finished, not stopped", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    liveAgent = runningAgent("agent-1", {
      lifecycle: "idle",
      attention: { requiresAttention: true, attentionReason: "finished" },
    });
    onEvent?.({ type: "agent_state", agent: liveAgent });
    await flush();

    expect(interruptedEvents()).toHaveLength(0);
    expect(events().filter((event) => event.kind === "finished")).toHaveLength(1);
  });

  test("the interrupted event is excluded from the machinery-turn chat gate (spec 07)", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    cancelRun();
    await flush();

    const interrupted = interruptedEvents()[0];
    expect(interrupted).toBeDefined();
    const gate = (
      service as unknown as {
        shouldDispatchMachineryTurn(event: MissionControlEvent): Promise<boolean>;
      }
    ).shouldDispatchMachineryTurn;
    await expect(gate(interrupted)).resolves.toBe(false);
  });

  // ==========================================================================
  // F2: reviewState changes push fresh agent state
  // ==========================================================================

  test("lifecycle.set done pushes the stored-record upsert whose bucket is done", async () => {
    // A closed/stored agent: no live state, so the daemon-level hook fans the
    // stored-record upsert out. The hook mirrors the bootstrap wiring: read
    // the record, build the stored payload, attach the recomputed bucket.
    const record = storedRecord("agent-1");
    getRecord.mockResolvedValue(record);
    const pushed: AgentSnapshotPayload[] = [];
    onReviewStateChanged.mockImplementation(async (agentId: string) => {
      const stored = await getRecord(agentId);
      const payload = buildStoredAgentPayload(stored, new Set(["omp"]));
      payload.bucket = await service.getLifecycleBucket(agentId);
      pushed.push(payload);
    });

    const result = await service.setLifecycle({ agentId: "agent-1", action: "done" });
    expect(result).toEqual({ ok: true });
    await flush();

    expect(onReviewStateChanged).toHaveBeenCalledWith("agent-1");
    expect(notifyAgentState).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ id: "agent-1" });
    // The recomputed canonical bucket (spec 01) rides the pushed upsert, so
    // the board section / sidebar badge reconcile without a reload.
    expect(pushed[0]?.bucket).toBe("done");
  });

  test("lifecycle.set done re-emits state for a live agent through the manager", async () => {
    liveAgent = runningAgent("agent-1", { lifecycle: "idle" });
    getRecord.mockResolvedValue(storedRecord("agent-1"));

    const result = await service.setLifecycle({ agentId: "agent-1", action: "done" });
    expect(result).toEqual({ ok: true });

    expect(notifyAgentState).toHaveBeenCalledWith("agent-1");
    expect(onReviewStateChanged).not.toHaveBeenCalled();
  });

  test("clear and reopen also push (every reviewState change)", async () => {
    liveAgent = runningAgent("agent-1", { lifecycle: "idle" });
    getRecord.mockResolvedValue(storedRecord("agent-1"));

    await service.setLifecycle({ agentId: "agent-1", action: "done" });
    await service.setLifecycle({ agentId: "agent-1", action: "clear" });
    await service.setLifecycle({ agentId: "agent-1", action: "reopen" });

    expect(notifyAgentState).toHaveBeenCalledTimes(3);
  });

  test("a verdict via setReviewState (verifier / aging sweep) pushes too", async () => {
    liveAgent = runningAgent("agent-1", { lifecycle: "idle" });

    await service.setReviewState("agent-1", "done", {
      verdict: { by: "verifier", summary: "Proofs match", at: new Date().toISOString() },
    });

    expect(notifyAgentState).toHaveBeenCalledWith("agent-1");
  });

  test("a completed self-report (report_status completed) pushes the fresh ready bucket", async () => {
    liveAgent = runningAgent("agent-1");

    const result = await service.reportSelfStatus("agent-1", {
      status: "completed",
      headline: "Everything asked is done",
    });
    expect(result.ok).toBe(true);
    await flush();

    expect(notifyAgentState).toHaveBeenCalledWith("agent-1");
    // The completed report marks the item ready-for-review (the push rides
    // the reviewState change); the live agent is still running, so the
    // canonical bucket stays running until the run ends.
    expect(store.getReviewState("agent-1").reviewState).toBe("ready");
  });

  test("internal agents never push", async () => {
    liveAgent = runningAgent("agent-1", { lifecycle: "idle", internal: true });
    getRecord.mockResolvedValue(storedRecord("agent-1"));

    await service.setLifecycle({ agentId: "agent-1", action: "done" });

    expect(notifyAgentState).not.toHaveBeenCalled();
    expect(onReviewStateChanged).not.toHaveBeenCalled();
  });
});
