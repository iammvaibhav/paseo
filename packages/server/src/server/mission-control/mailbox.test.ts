import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";
import type { MissionControlStore } from "./store.js";
import type { HindsightRecallResult } from "./hindsight.js";

vi.mock("../agent/tools/paseo-tools.js", () => ({
  dispatchLocalPromptMode: vi.fn(async () => "steer"),
}));

const dispatchLocalPromptModeMock = vi.mocked(dispatchLocalPromptMode);

// Mirrors the module-level constant in service.ts (deliberately not exported).
const SPECULATIVE_RECALL_BUDGET_MS = 600;

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

function commanderAgent(agentId: string): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "idle",
    labels: { "paseo.mission-control": "commander" },
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
  } as unknown as ManagedAgent;
}

function commanderRecord(agentId: string): StoredAgentRecord {
  return {
    id: agentId,
    labels: { "paseo.mission-control": "commander" },
    archivedAt: null,
    updatedAt: "2026-08-08T00:00:00Z",
    config: { provider: "omp", cwd: "/tmp" },
  } as unknown as StoredAgentRecord;
}

describe("M8 mailbox: instruction delivery + speculative auto-recall", () => {
  let dir: string;
  let service: MissionControlService;
  let logger: pino.Logger;
  let setPendingInstructionEnvelope: Mock;
  let hasInFlightRun: Mock;
  let dispatchSnapshotTurn: Mock;
  let disarmSnapshotAckDrop: Mock;
  /** The agent-manager subscribe callback, captured so tests can push stream events. */
  let subscribeCallback: ((event: AgentManagerEvent) => void) | null;

  async function createService(
    options: { busy?: boolean; snapshotInFlight?: boolean } = {},
  ): Promise<void> {
    logger = createMockLogger();
    hasInFlightRun = vi.fn(() => options.busy === true);
    setPendingInstructionEnvelope = vi.fn();
    // Default: the snapshot turn is in flight after dispatch (the normal
    // idle case — the message is steered into it). `snapshotInFlight: false`
    // exercises the fallback (settled fast / busy skip / dispatch failure).
    dispatchSnapshotTurn = vi.fn(async () => options.snapshotInFlight !== false);
    disarmSnapshotAckDrop = vi.fn();
    subscribeCallback = null;
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: vi.fn(() => commanderAgent("commander-1")),
        listAgents: vi.fn(() => [commanderAgent("commander-1")]),
        hasInFlightRun,
        subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
          subscribeCallback = callback;
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => [commanderRecord("commander-1")]),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      setPendingInstructionEnvelope,
      dispatchSnapshotTurn,
      disarmSnapshotAckDrop,
    });
    await service.start();
  }

  /**
   * Push a Commander stream event into the service through the captured
   * agent-manager subscription (the same path live stream events use).
   */
  function pushStream(
    event: AgentStreamEvent,
    options: { seq?: number; agentId?: string } = {},
  ): void {
    if (!subscribeCallback) {
      throw new Error("service not created");
    }
    subscribeCallback({
      type: "agent_stream",
      agentId: options.agentId ?? "commander-1",
      ...(options.seq !== undefined ? { seq: options.seq } : {}),
      event,
    });
  }

  function allInstructionsClosed(): boolean {
    for (const instruction of service.listInstructions()) {
      if (instruction.status !== "closed") {
        return false;
      }
    }
    return true;
  }

  function instructionStatus(id: string): "open" | "closed" | undefined {
    for (const instruction of service.listInstructions()) {
      if (instruction.id === id) {
        return instruction.status;
      }
    }
    return undefined;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-mailbox-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service.stop();
    const internals = service as unknown as {
      store: { appendTail: Promise<void>; persistTail: Promise<void> };
    };
    await Promise.all([internals.store.appendTail, internals.store.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  test("within-budget recall attaches to the busy steer envelope and opens a ledger row", async () => {
    await createService({ busy: true });
    const recallSpy = vi.spyOn(service, "hindsightRecall").mockResolvedValue({
      ok: true,
      matches: [
        {
          id: "m1",
          text: "  deploy the fleet  to staging\n",
          context: null,
          score: 0.9,
          tags: null,
          bank: "omp",
          sessionId: null,
          entities: null,
          metadata: null,
        },
      ],
    });

    const result = await service.deliverCommanderInstruction({
      text: "deploy the fleet to staging",
      source: "chat",
    });

    expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "steer" });
    expect(recallSpy).toHaveBeenCalledWith("deploy the fleet to staging", 3);
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "instruction",
    });
    expect(call?.prompt).toContain("New instruction (#1)");
    expect(call?.prompt).toContain("Open instructions:");
    expect(call?.prompt).toContain("- #1: deploy the fleet to staging");
    // Within budget → the auto-recall block rides the envelope with ≤3 one-liners.
    expect(call?.prompt).toContain("Possibly related (auto-recall):");
    expect(call?.prompt).toContain("- deploy the fleet to staging [omp]");
    // Idle-path staging only happens for idle deliveries — a busy steer never stages.
    expect(setPendingInstructionEnvelope).not.toHaveBeenCalled();
    // The busy path steers into the running turn; it never dispatches a
    // snapshot turn of its own (the running turn carries the prior row).
    expect(dispatchSnapshotTurn).not.toHaveBeenCalled();
  });

  test("an idle delivery within budget hands the recall block to the snapshot seam", async () => {
    await createService({ busy: false });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({
      ok: true,
      matches: [
        {
          id: "m1",
          text: "staging box is provisioned",
          context: null,
          score: 0.8,
          tags: null,
          bank: "paseo-fleet-dev",
          sessionId: null,
          entities: null,
          metadata: null,
        },
      ],
    });

    const result = await service.deliverCommanderInstruction({
      text: "is staging ready?",
      source: "voice",
    });

    expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "run" });
    // The snapshot turn is dispatched first; the recall block rides it (the
    // steered message itself carries no envelope blocks).
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toBe("is staging ready?");
    expect(setPendingInstructionEnvelope).toHaveBeenCalledTimes(1);
    const staged = setPendingInstructionEnvelope.mock.calls[0]?.[0] as string;
    expect(staged).toContain("Possibly related (auto-recall):");
    expect(staged).toContain("- staging box is provisioned [paseo-fleet-dev]");
  });

  test("idle delivery steers the message into the in-flight snapshot turn (M10: no replace-running user run)", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    const result = await service.deliverCommanderInstruction({
      text: "is staging ready?",
      source: "voice",
    });

    expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "run" });
    // Snapshot turn dispatched FIRST…
    expect(dispatchSnapshotTurn).toHaveBeenCalledWith("commander-1");
    // …then the message steered into that same turn — the native steer mode
    // (never a startAgentRun with replaceRunning:true while it is in flight).
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "instruction",
    });
    // The turn's PRIMARY ask: plain message text, no mid-turn acknowledge
    // wrapper (the snapshot body already carries ledger + recall blocks).
    expect(call?.prompt).toBe("is staging ready?");
    expect(call?.prompt).not.toContain("New instruction (#1)");
    expect(call?.prompt).not.toContain("Acknowledge it in one line");
    // Ordering: the snapshot dispatch precedes the steer.
    expect(dispatchSnapshotTurn.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchLocalPromptModeMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    // The joined turn's reply is real content: the ack-drop is disarmed.
    expect(disarmSnapshotAckDrop).toHaveBeenCalledTimes(1);
  });

  test("idle delivery falls back to the plain run when no snapshot turn is in flight", async () => {
    // No turn in flight after dispatch: already settled (fast model), busy
    // skip, or a failed dispatch — all fall back identically, and the
    // message is ALWAYS still delivered (the snapshot is advisory).
    await createService({ busy: false, snapshotInFlight: false });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    const result = await service.deliverCommanderInstruction({
      text: "is staging ready?",
      source: "voice",
    });

    expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "run" });
    expect(dispatchSnapshotTurn).toHaveBeenCalledWith("commander-1");
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call?.prompt).toBe("is staging ready?");
    // No steer joined a snapshot turn — nothing to disarm.
    expect(disarmSnapshotAckDrop).not.toHaveBeenCalled();
  });

  test("a recall past the hard budget never delays delivery and attaches nothing", async () => {
    await createService({ busy: true });
    // Never settles: the timeout leg of the race must win.
    const recallSpy = vi
      .spyOn(service, "hindsightRecall")
      .mockReturnValue(new Promise<HindsightRecallResult>(() => {}));

    vi.useFakeTimers();
    try {
      const delivery = service.deliverCommanderInstruction({
        text: "any updates?",
        source: "chat",
      });
      await vi.advanceTimersByTimeAsync(SPECULATIVE_RECALL_BUDGET_MS + 50);
      const result = await delivery;

      expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "steer" });
      expect(recallSpy).toHaveBeenCalled();
      const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
      expect(call?.prompt).toContain("New instruction (#1)");
      expect(call?.prompt).not.toContain("Possibly related (auto-recall):");
    } finally {
      vi.useRealTimers();
    }
  });

  test("machinery turns never fire recall and never stage a pending envelope", async () => {
    await createService({ busy: false });
    const recallSpy = vi.spyOn(service, "hindsightRecall");
    await service.setMode("auto");
    // A blocked event only wakes the Commander when it carries a decision
    // card (spec 07); attach a pending proposal so the machinery turn fires.
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
      detail: "needs a decision",
      proposal: {
        id: "mcp-mailbox-nudge",
        createdAt: new Date().toISOString(),
        origin: "commander",
        serverId: "test-server",
        targetAgentId: "worker-1",
        message: "Proceed with the plan?",
        deliveryMode: "interrupt",
        reason: "Needs a decision",
        classification: "normal",
        status: "pending",
      },
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ classification: "machinery" });
    expect(recallSpy).not.toHaveBeenCalled();
    expect(setPendingInstructionEnvelope).not.toHaveBeenCalled();
    // The machinery path is unchanged: it rides the startAgentRun seam (its
    // replaceRunning:false settlement wait) and never dispatches a snapshot
    // turn through the mailbox's idle path.
    expect(dispatchSnapshotTurn).not.toHaveBeenCalled();
    // The machinery path opens no instruction ledger row either.
    expect(service.listInstructions()).toEqual([]);
  });

  test("a deny with a revision delivers one mailbox instruction citing the proposal id (never silent)", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });
    const proposal = await service.approvals.createProposal({
      origin: "commander",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Spawn beta-tmp-summarizer on beta: summarize /tmp",
      deliveryMode: "interrupt",
      reason: "Placement",
      classification: "normal",
    });
    const result = await service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "deny",
      editedMessage: "Run it on gamma instead.",
    });
    expect(result).toEqual({ ok: true });
    expect(service.approvals.getProposal(proposal.id)?.status).toBe("denied");
    // Exactly ONE mailbox instruction carries the revision back to the
    // Commander — the same delivery path chat uses.
    const revisionCalls = dispatchLocalPromptModeMock.mock.calls.filter(
      (call) =>
        typeof call[0]?.prompt === "string" &&
        call[0].prompt.includes("was denied with this revision"),
    );
    expect(revisionCalls).toHaveLength(1);
    expect(revisionCalls[0]?.[0]?.prompt).toBe(
      `Your proposal ${proposal.id} was denied with this revision: Run it on gamma instead.`,
    );
    // The ledger opens a row for the revision so the Commander re-proposes.
    const instructions = service.listInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].text).toContain(proposal.id);
    expect(instructions[0].source).toBe("chat");
  });

  test("a plain deny of a commander-origin proposal delivers the no-reason deny notification (never silent)", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });
    const proposal = await service.approvals.createProposal({
      origin: "commander",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Spawn beta-tmp-summarizer on beta: summarize /tmp",
      deliveryMode: "interrupt",
      reason: "Placement",
      classification: "normal",
    });
    const result = await service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "deny",
    });
    expect(result).toEqual({ ok: true });
    expect(service.approvals.getProposal(proposal.id)?.status).toBe("denied");
    // Exactly ONE mailbox instruction tells the Commander the denial, with
    // the summary (first 80 chars) quoted.
    const denyCalls = dispatchLocalPromptModeMock.mock.calls.filter(
      (call) => typeof call[0]?.prompt === "string" && call[0].prompt.endsWith("was denied"),
    );
    expect(denyCalls).toHaveLength(1);
    expect(denyCalls[0]?.[0]?.prompt).toBe(
      `Your proposal ${proposal.id} (Spawn beta-tmp-summarizer on beta: summarize /tmp) was denied`,
    );
    const instructions = service.listInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].text).toContain(proposal.id);
    expect(instructions[0].source).toBe("chat");
  });

  test("a deny with a reason delivers ONE mailbox instruction carrying the reason", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });
    const proposal = await service.approvals.createProposal({
      origin: "commander",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Spawn beta-tmp-summarizer on beta: summarize /tmp",
      deliveryMode: "interrupt",
      reason: "Placement",
      classification: "normal",
    });
    const result = await service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "deny",
      reason: "  Beta has no headroom.  ",
    });
    expect(result).toEqual({ ok: true });
    expect(service.approvals.getProposal(proposal.id)?.status).toBe("denied");
    const reasonCalls = dispatchLocalPromptModeMock.mock.calls.filter(
      (call) => typeof call[0]?.prompt === "string" && call[0].prompt.includes("; reason: "),
    );
    expect(reasonCalls).toHaveLength(1);
    expect(reasonCalls[0]?.[0]?.prompt).toBe(
      `Your proposal ${proposal.id} (Spawn beta-tmp-summarizer on beta: summarize /tmp) was denied; reason: Beta has no headroom.`,
    );
    // The trimmed reason ships; the ledger opens a row so the Commander reacts.
    const instructions = service.listInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].text).toContain("; reason: Beta has no headroom.");
  });

  test("deny with a revision AND a reason delivers ONE combined mailbox instruction", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });
    const proposal = await service.approvals.createProposal({
      origin: "commander",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Spawn beta-tmp-summarizer on beta: summarize /tmp",
      deliveryMode: "interrupt",
      reason: "Placement",
      classification: "normal",
    });
    const result = await service.approvals.resolveProposal({
      proposalId: proposal.id,
      action: "deny",
      editedMessage: "Run it on gamma instead.",
      reason: "Beta has no headroom.",
    });
    expect(result).toEqual({ ok: true });
    expect(service.approvals.getProposal(proposal.id)?.status).toBe("denied");
    // The revision keeps precedence and the reason rides along — ONE delivery
    // combining both, never two notifications.
    const combinedCalls = dispatchLocalPromptModeMock.mock.calls.filter(
      (call) =>
        typeof call[0]?.prompt === "string" &&
        call[0].prompt.includes("was denied with this revision") &&
        call[0].prompt.includes("; reason: "),
    );
    expect(combinedCalls).toHaveLength(1);
    expect(combinedCalls[0]?.[0]?.prompt).toBe(
      `Your proposal ${proposal.id} was denied with this revision: Run it on gamma instead.; reason: Beta has no headroom.`,
    );
    expect(dispatchLocalPromptModeMock.mock.calls).toHaveLength(1);
    const instructions = service.listInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].text).toContain("Run it on gamma instead.");
    expect(instructions[0].text).toContain("; reason: Beta has no headroom.");
  });

  // ==========================================================================
  // Instruction-ledger fallback: a Commander turn that answers in plain prose
  // (no citing post_answer / clarify / proposal card) still closes its ledger
  // rows via synthesized answer cards. Stream events are pushed through the
  // captured agent-manager subscription, exactly as the provider emits them.
  // The finalize DECISION (which ids get a synthetic card) is synchronous at
  // turn_completed, so the synthesize spy settles deterministically; the card
  // LANDING (store row closed) is async and awaited via waitFor.
  // ==========================================================================

  function spySynthesize(): ReturnType<typeof vi.fn> {
    const synthesize = vi.spyOn(
      service as unknown as {
        synthesizeCommanderAnswerCards: (
          agentId: string,
          ids: string[],
          text: string,
        ) => Promise<void>;
      },
      "synthesizeCommanderAnswerCards",
    );
    return synthesize;
  }

  test("a prose-only idle turn synthesizes an answer card that closes its ledger row", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    const result = await service.deliverCommanderInstruction({
      text: "is staging ready?",
      source: "voice",
    });
    expect(result).toEqual({ ok: true, instructionId: "#1", deliveredAs: "run" });
    expect(service.listInstructions()[0]?.status).toBe("open");

    const synthesize = spySynthesize();
    // The snapshot turn starts, the message is steered into it, and the
    // Commander answers in plain prose only — no post_answer card (the live
    // incident shape: assistant_message rows, no respondsTo anywhere).
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Staging is ready. " },
      },
      { seq: 100 },
    );
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Deployed five minutes ago." },
      },
      { seq: 101 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-1" });

    // The finalize decision is synchronous: exactly #1 gets a synthetic card
    // carrying the ordered-joined prose.
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith(
      "commander-1",
      ["#1"],
      "Staging is ready. Deployed five minutes ago.",
    );
    // The card lands through the emitCommanderCard path (closedBy cardId).
    await vi.waitFor(() => {
      expect(service.listInstructions()[0]?.status).toBe("closed");
    });
    const instruction = service.listInstructions()[0];
    expect(instruction?.closedBy).toBe("cardId");
    const answerEvents = service.fetchEvents().filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(1);
    expect(answerEvents[0]?.answer).toMatchObject({
      kind: "generic",
      respondsTo: "#1",
      body: "Staging is ready. Deployed five minutes ago.",
    });
    expect(answerEvents[0]?.headline).toContain("#1");
  });

  test("rapid 3-fire busy steers in one turn close all three rows with one card each", async () => {
    await createService({ busy: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    // The in-flight turn starts first; the three busy steers join it.
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    await service.deliverCommanderInstruction({ text: "deploy beta", source: "chat" });
    await service.deliverCommanderInstruction({ text: "bump the timeout", source: "chat" });
    await service.deliverCommanderInstruction({ text: "check the logs", source: "voice" });
    expect(
      service
        .listInstructions()
        .map((instruction) => instruction.id)
        .sort(),
    ).toEqual(["#1", "#2", "#3"]);

    const synthesize = spySynthesize();
    // One prose reply covering all three — the live incident shape
    // (seq 467 / 469 / 470 assistant rows, no cards).
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Done: beta deployed, " },
      },
      { seq: 467 },
    );
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "timeout bumped to 30s, " },
      },
      { seq: 469 },
    );
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "and the logs look clean." },
      },
      { seq: 470 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-1" });

    // One synthetic card per still-open tracked id — all three in one window.
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith(
      "commander-1",
      ["#1", "#2", "#3"],
      "Done: beta deployed, timeout bumped to 30s, and the logs look clean.",
    );
    await vi.waitFor(() => {
      expect(allInstructionsClosed()).toBe(true);
    });
    // Answer cards are content TO the user and never coalesce: all three are
    // retained and visible in the default feed (no supersession).
    const answerEvents = service.fetchEvents().filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(3);
    expect(answerEvents.map((event) => event.answer?.respondsTo).sort()).toEqual([
      "#1",
      "#2",
      "#3",
    ]);
    for (const event of answerEvents) {
      expect(event.answer?.body).toBe(
        "Done: beta deployed, timeout bumped to 30s, and the logs look clean.",
      );
    }
  });

  test("a genuine post_answer card closes its row and suppresses the synthetic duplicate", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    await service.deliverCommanderInstruction({ text: "is staging ready?", source: "chat" });
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    // The Commander answers with a REAL citing card (the post_answer tool
    // path) — this closes the row at card-creation time.
    await service.emitCommanderCard({
      kind: "answer",
      headline: "Staging is ready",
      answer: {
        kind: "generic",
        headline: "Staging is ready",
        body: "Deployed.",
        respondsTo: "#1",
      },
    });
    const synthesize = spySynthesize();
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Staging is ready." },
      },
      { seq: 200 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-1" });

    // The fallback sees the row already closed and emits nothing.
    expect(synthesize).not.toHaveBeenCalled();
    expect(service.listInstructions()[0]?.status).toBe("closed");
    const answerEvents = service.fetchEvents().filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(1);
    expect(answerEvents[0]?.answer?.respondsTo).toBe("#1");
    expect(answerEvents[0]?.headline).toBe("Staging is ready");
  });

  test("a genuine clarify card closes its row and suppresses the synthetic duplicate", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    await service.deliverCommanderInstruction({ text: "which host?", source: "chat" });
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    await service.emitCommanderCard({
      kind: "clarification",
      headline: "Which host do you mean?",
      clarification: {
        question: "Which host do you mean?",
        options: ["beta", "gamma"],
        allowFreeText: true,
        respondsTo: "#1",
      },
    });
    const synthesize = spySynthesize();
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Which host do you mean?" },
      },
      { seq: 300 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-1" });

    expect(synthesize).not.toHaveBeenCalled();
    expect(service.listInstructions()[0]?.status).toBe("closed");
    // The clarification closed the row; no synthetic answer card ever lands.
    expect(service.fetchEvents().filter((event) => event.kind === "answer")).toHaveLength(0);
  });

  test("a failed turn with prose never closes its row; the id stays pending for recovery", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    await service.deliverCommanderInstruction({ text: "is staging ready?", source: "chat" });
    const synthesize = spySynthesize();
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Staging is" },
      },
      { seq: 400 },
    );
    pushStream({
      type: "turn_failed",
      provider: "omp",
      error: "provider timeout",
      turnId: "turn-1",
    });

    // Failed turn: no card, no closure — the id stays pending for recovery.
    expect(synthesize).not.toHaveBeenCalled();
    expect(service.listInstructions()[0]?.status).toBe("open");
    expect(service.fetchEvents().filter((event) => event.kind === "answer")).toHaveLength(0);

    // Recovery: the next turn completes with real prose → the row closes.
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-2" });
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Staging is ready now." },
      },
      { seq: 401 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-2" });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith("commander-1", ["#1"], "Staging is ready now.");
    await vi.waitFor(() => {
      expect(service.listInstructions()[0]?.status).toBe("closed");
    });
    const answerEvents = service.fetchEvents().filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(1);
    expect(answerEvents[0]?.answer?.body).toBe("Staging is ready now.");
  });

  test("an unrelated pre-existing open instruction is never closed by another turn's synthesis", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });

    // An older row restored on boot / opened outside the mailbox: it was
    // never staged into a delivery window, so no turn may close it.
    const store = (service as unknown as { store: MissionControlStore }).store;
    store.openInstruction({ text: "old unrelated ask", source: "chat" });
    expect(service.listInstructions().find((instruction) => instruction.id === "#1")?.status).toBe(
      "open",
    );

    await service.deliverCommanderInstruction({ text: "is staging ready?", source: "voice" });
    expect(service.listInstructions().find((instruction) => instruction.id === "#2")?.status).toBe(
      "open",
    );
    const synthesize = spySynthesize();
    pushStream({ type: "turn_started", provider: "omp", turnId: "turn-1" });
    pushStream(
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Staging is ready." },
      },
      { seq: 500 },
    );
    pushStream({ type: "turn_completed", provider: "omp", turnId: "turn-1" });

    // Only the tracked delivery-window id (#2) is a candidate.
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith("commander-1", ["#2"], "Staging is ready.");
    await vi.waitFor(() => {
      expect(instructionStatus("#2")).toBe("closed");
    });
    expect(service.listInstructions().find((instruction) => instruction.id === "#1")?.status).toBe(
      "open",
    );
    const answerEvents = service.fetchEvents().filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(1);
    expect(answerEvents[0]?.answer?.respondsTo).toBe("#2");
  });

  test("three instructions answered across serialized turns each close via a synthetic card", async () => {
    await createService({ busy: false, snapshotInFlight: true });
    vi.spyOn(service, "hindsightRecall").mockResolvedValue({ ok: true, matches: [] });
    const synthesize = spySynthesize();

    const texts = ["deploy beta", "bump the timeout", "check the logs"];
    for (const [index, text] of texts.entries()) {
      const result = await service.deliverCommanderInstruction({ text, source: "chat" });
      expect(result).toEqual({ ok: true, instructionId: `#${index + 1}`, deliveredAs: "run" });
      const turnId = `turn-${index + 1}`;
      pushStream({ type: "turn_started", provider: "omp", turnId });
      pushStream(
        {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: `answer to ${text}` },
        },
        { seq: 600 + index },
      );
      pushStream({ type: "turn_completed", provider: "omp", turnId });
      expect(synthesize).toHaveBeenCalledTimes(index + 1);
      expect(synthesize).toHaveBeenNthCalledWith(
        index + 1,
        "commander-1",
        [`#${index + 1}`],
        `answer to ${text}`,
      );
      await vi.waitFor(() => {
        expect(instructionStatus(`#${index + 1}`)).toBe("closed");
      });
    }
    const answerEvents = service
      .fetchEvents({ includeSuperseded: true })
      .filter((event) => event.kind === "answer");
    expect(answerEvents).toHaveLength(3);
    expect(answerEvents.map((event) => event.answer?.respondsTo).sort()).toEqual([
      "#1",
      "#2",
      "#3",
    ]);
  });
});
