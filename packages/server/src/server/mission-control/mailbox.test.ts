import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";
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
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: vi.fn(() => commanderAgent("commander-1")),
        listAgents: vi.fn(() => [commanderAgent("commander-1")]),
        hasInFlightRun,
        subscribe: vi.fn((_cb: (event: AgentManagerEvent) => void) => {
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
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
      detail: "needs a decision",
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
});
