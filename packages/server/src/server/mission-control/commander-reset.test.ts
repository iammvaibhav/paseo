import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type {
  MissionControlEventKind,
  MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { MissionControlService, type MissionControlServiceOptions } from "./service.js";
import type { MissionControlAppendInput } from "./store.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { executeSpawnProposal } from "./spawn-executor.js";

vi.mock("../agent/tools/paseo-tools.js", () => ({
  dispatchLocalPromptMode: vi.fn(async () => "steer"),
}));

const dispatchLocalPromptModeMock = vi.mocked(dispatchLocalPromptMode);

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

function workerAgent(agentId: string, labels: Record<string, string> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "idle",
    labels,
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
  } as unknown as ManagedAgent;
}

/** A pending decision proposal attached to a blocked/stalled event. */
function pendingDecisionProposal(targetAgentId: string): MissionControlProposal {
  return {
    id: "mcp-gate-matrix",
    createdAt: new Date().toISOString(),
    origin: "commander",
    serverId: "test-server",
    targetAgentId,
    message: "Proceed with the plan?",
    deliveryMode: "interrupt",
    reason: "Needs a decision",
    classification: "normal",
    status: "pending",
  };
}

/** Minimal publish payload for a gate-matrix event kind. */
function plainGateEvent(
  kind: MissionControlEventKind,
): Omit<MissionControlAppendInput, "agentTitle"> {
  let severity: "blocker" | "attention" | "info";
  if (kind === "blocked") {
    severity = "blocker";
  } else if (kind === "failed" || kind === "stalled") {
    severity = "attention";
  } else {
    severity = "info";
  }
  return {
    agentId: "worker-1",
    kind,
    source: "system",
    severity,
    headline: `Event ${kind}`,
  };
}

/** A blocked/stalled event carrying a pending-proposal decision card. */
function decisionCardGateEvent(
  kind: "blocked" | "stalled",
): Omit<MissionControlAppendInput, "agentTitle"> {
  return { ...plainGateEvent(kind), proposal: pendingDecisionProposal("worker-1") };
}

describe("MissionControlService reset + machinery turns", () => {
  let dir: string;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
      spawnFromProposal?: MissionControlServiceOptions["spawnFromProposal"];
      getAgent?: (agentId: string) => ManagedAgent | null;
      listAgents?: () => ManagedAgent[];
      storedAgents?: StoredAgentRecord[];
    } = {},
  ): Promise<void> {
    logger = createMockLogger();
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: options.getAgent ?? (() => null),
        listAgents: options.listAgents ?? (() => []),
        subscribe: vi.fn((_cb: (event: AgentManagerEvent) => void) => {
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => options.storedAgents ?? []),
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
      resetCommander: options.resetCommander,
      ...(options.spawnFromProposal ? { spawnFromProposal: options.spawnFromProposal } : {}),
    });
    await service.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-reset-"));
    // The machinery-turn mock is module-level; each test must start from a
    // clean call history or earlier tests' dispatches leak into the counts.
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

  /**
   * Runs one gate combination in a fresh service and asserts the expected
   * dispatch outcome, then stops the service so the next combo starts clean.
   */
  async function gateOutcome(input: {
    mode: "ask" | "auto";
    dispatched: boolean;
    reviewState?: "ready" | "done";
    event: Omit<MissionControlAppendInput, "agentTitle">;
    expectDispatch: boolean;
  }): Promise<void> {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent(
              "worker-1",
              input.dispatched ? { "paseo.parent-agent-id": "commander-1" } : {},
            ),
    });
    if (input.mode === "auto") {
      await service.setMode("auto");
    }
    if (input.reviewState) {
      await service.setReviewState("worker-1", input.reviewState);
    }
    service.publishEvent(input.event);
    if (input.expectDispatch) {
      await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalled());
    } else {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
    }
    await service.stop();
    const internals = service as unknown as {
      store: { appendTail: Promise<void>; persistTail: Promise<void> };
    };
    await Promise.all([internals.store.appendTail, internals.store.persistTail]);
    dispatchLocalPromptModeMock.mockClear();
  }

  test("resetCommander delegates to the injected machinery and returns its result", async () => {
    const resetCommander = vi.fn(async () => ({ ok: true as const, agentId: "commander-new" }));
    await createService({ resetCommander });
    const result = await service.resetCommander();
    expect(resetCommander).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, agentId: "commander-new" });
  });

  test("resetCommander reports an error when the host has no reset machinery", async () => {
    await createService();
    const result = await service.resetCommander();
    expect(result).toEqual({ ok: false, error: "Commander reset is not available on this host" });
  });

  test("an AUTO-mode blocked event without a decision card never dispatches a machinery turn", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
      detail: "needs a decision",
    });
    // Board + badge only (spec 07): a plain blocked event carries no decision
    // card, so the Commander is not consulted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("an AUTO-mode blocked event carrying a pending proposal dispatches a machinery turn", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
      detail: "needs a decision",
      proposal: pendingDecisionProposal("worker-1"),
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "machinery",
      replaceOrigin: "machinery",
    });
    expect(call?.prompt).toMatch(/^<paseo-system>\nNeeds you: \[blocked\] Waiting for permission/);
    expect(call?.prompt).toContain("paseo://h/test-server/agent/worker-1");
    expect(call?.prompt).toContain("reply with a single short acknowledgment token");
    expect(call?.prompt).toContain("needs a decision");
  });

  test("a blocked event carrying a clarification dispatches a machinery turn in AUTO mode", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
      clarification: {
        question: "Approve the override?",
        options: ["Yes", "No"],
        allowFreeText: false,
      },
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toContain("[blocked]");
  });

  test("ASK mode emits no machinery turn for a blocked event", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
    });
    // Give any (wrong) dispatch a chance to fire, then assert none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("AUTO mode ignores non-needs-you events (finished)", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("an AUTO-mode stalled event without a decision card never dispatches", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: "Stalled (no response for 5 min)",
    });
    // Board + badge only: the stalled card carries no decision card.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("an AUTO-mode stalled event carrying a pending proposal dispatches", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: "Stalled (no response for 5 min)",
      proposal: pendingDecisionProposal("worker-1"),
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toContain(
      "[stalled] Stalled (no response for 5 min)",
    );
  });

  test("verdict-insufficient: an AUTO-mode verdict on an unresolved item dispatches", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    // The item is still needs-you (ready-for-review): the verdict does not
    // resolve it, so the Commander is consulted.
    await service.setReviewState("worker-1", "ready");
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "proofs missing",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toContain("[verdict]");
  });

  test("a resolved verdict (item done) never dispatches a machinery turn", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    await service.setReviewState("worker-1", "done", {
      verdict: { by: "user", summary: "Marked done", at: new Date().toISOString() },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("an event about the Commander itself never dispatches a machinery turn", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: () => commanderAgent("commander-1"),
    });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "commander-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("no Commander resolves to no machinery turn", async () => {
    await createService();
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Waiting for permission",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("terminal events never dispatch, even for Commander-dispatched agents, in ASK or AUTO mode", async () => {
    // finished / failed / interrupted stop dispatching (spec 07): the
    // board/feed rail carries the outcome, the Commander is not consulted —
    // regardless of how the agent was started or the mode.
    for (const mode of ["ask", "auto"] as const) {
      for (const dispatched of [false, true]) {
        await createService({
          storedAgents: [commanderRecord("commander-1")],
          getAgent: (agentId) =>
            agentId === "commander-1"
              ? commanderAgent("commander-1")
              : workerAgent(
                  "worker-1",
                  dispatched ? { "paseo.parent-agent-id": "commander-1" } : {},
                ),
        });
        if (mode === "auto") {
          await service.setMode("auto");
        }
        for (const kind of ["finished", "failed", "interrupted"] as const) {
          service.publishEvent({
            agentId: "worker-1",
            kind,
            source: "system",
            severity: kind === "failed" ? "attention" : "info",
            headline: kind === "failed" ? "Failed with an error" : "Finished",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
        await service.stop();
        dispatchLocalPromptModeMock.mockClear();
      }
    }
  });

  test("an adopted agent's terminal event never triggers a follow-up turn", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.commander-adopted-at": "2026-08-08T00:00:00.000Z" }),
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("a follow-up turn carries the worker's last report headline and the verdict line", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    await service.setMode("auto");
    await service.reportSelfStatus("worker-1", {
      status: "working",
      headline: "Root cause found",
      kind: "milestone",
    });
    await service.setReviewState("worker-1", "done", {
      verdict: { by: "user", summary: "Marked done", at: new Date().toISOString() },
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const prompt = dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain("[verdict] Marked done");
    expect(prompt).toContain('Last report: "Root cause found"');
    expect(prompt).toContain("Verdict: Marked done (by user)");
  });

  test("verdicts on a dispatched agent trigger once per run epoch", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "proofs missing",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    // A verifier retry posting another insufficient verdict in the same epoch
    // must not re-alert the Commander.
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "still missing",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1);
  });

  test("terminal events never claim the follow-up slot (only verdicts do)", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    await service.setMode("auto");
    // Terminal events no longer dispatch (spec 07), so they neither fire nor
    // consume the per-epoch slot; a verdict after them still dispatches once.
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "failed",
      source: "system",
      severity: "attention",
      headline: "Failed with an error",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "proofs missing",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    // A second verdict in the same epoch is still deduped.
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "still missing",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1);
  });

  test("BUG-4: a Commander-approved spawn stamps paseo.parent-agent-id and the worker's verdict passes the dispatch gate", async () => {
    // Full loop through the REAL spawn executor: approve a commander-origin
    // spawn-kind proposal → the executor stamps paseo.parent-agent-id =
    // commander-1 on the created plan → the stamped worker's verdict event
    // clears isDispatchedByCommander and dispatches the machinery turn.
    // (Terminal events no longer dispatch — spec 07 — so the gate is proven
    // with the verdict, which still routes for dispatched agents.)
    let createdLabels: Record<string, string> = {};
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", createdLabels),
      spawnFromProposal: (proposal) =>
        executeSpawnProposal(proposal.spawnPlan!, {
          host: {
            serverId: "test-server",
            hostName: "test-host",
            hostAlias: null,
            peerManager: null,
          },
          stampCommanderParentLabel: proposal.origin === "commander",
          resolveCommanderAgentId: () => service.getCommanderAgentId(),
          mkdirp: async () => undefined,
          createLocally: async (plan) => {
            createdLabels = plan.labels ?? {};
            return { ok: true as const, agentId: "worker-1", serverId: "test-server" };
          },
          createOnPeer: async () => ({ ok: false as const, error: "no peer in this test" }),
        }),
    });
    const proposal = await service.approvals.createProposal({
      origin: "commander",
      serverId: "test-server",
      targetAgentId: "",
      message: "Spawn a worker",
      deliveryMode: "interrupt",
      reason: "Commander spawn",
      classification: "normal",
      kind: "spawn",
      spawnPlan: { provider: "omp", summary: "Spawn a worker", host: "local" },
    });
    expect(proposal.status).toBe("pending");
    await service.respondProposal({ proposalId: proposal.id, action: "approve" });
    expect(service.getProposal(proposal.id)?.status).toBe("sent");
    expect(service.getProposal(proposal.id)?.spawnedAgentId).toBe("worker-1");
    // The executor stamped the label on the create (BUG-4).
    expect(createdLabels).toMatchObject({ "paseo.parent-agent-id": "commander-1" });
    // ASK mode: terminal events never dispatch, but the stamped worker's
    // verdict must clear the dispatched gate and trigger the follow-up turn.
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
    service.publishEvent({
      agentId: "worker-1",
      kind: "verdict",
      source: "verifier",
      severity: "info",
      headline: "Done — insufficient",
      detail: "proofs missing",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "machinery",
    });
    expect(call?.prompt).toContain("follow-up on a worker you dispatched");
  });

  describe("spec 07 machinery-turn gate matrix", () => {
    // Event kinds that NEVER trigger a machinery turn in any mode or
    // dispatch state: status cards, terminal events, and cards to the user.
    const neverKinds: MissionControlEventKind[] = [
      "started",
      "finished",
      "failed",
      "milestone",
      "finding",
      "diverged",
      "interrupted",
      "proposal",
      "clarification",
      "answer",
      "blocked",
      "stalled",
    ];

    for (const kind of neverKinds) {
      test(`${kind} never dispatches (dispatched/hand-started × ask/auto)`, async () => {
        for (const mode of ["ask", "auto"] as const) {
          for (const dispatched of [false, true]) {
            await gateOutcome({
              mode,
              dispatched,
              event: plainGateEvent(kind),
              expectDispatch: false,
            });
          }
        }
      });
    }

    for (const kind of ["blocked", "stalled"] as const) {
      test(`${kind} with a pending proposal dispatches except in ask mode for hand-started agents`, async () => {
        await gateOutcome({
          mode: "ask",
          dispatched: false,
          event: decisionCardGateEvent(kind),
          expectDispatch: false,
        });
        await gateOutcome({
          mode: "ask",
          dispatched: true,
          event: decisionCardGateEvent(kind),
          expectDispatch: true,
        });
        await gateOutcome({
          mode: "auto",
          dispatched: false,
          event: decisionCardGateEvent(kind),
          expectDispatch: true,
        });
        await gateOutcome({
          mode: "auto",
          dispatched: true,
          event: decisionCardGateEvent(kind),
          expectDispatch: true,
        });
      });

      test(`${kind} with a clarification dispatches except in ask mode for hand-started agents`, async () => {
        const event: Omit<MissionControlAppendInput, "agentTitle"> = {
          ...plainGateEvent(kind),
          clarification: {
            question: "Approve the override?",
            options: ["Yes", "No"],
            allowFreeText: false,
          },
        };
        await gateOutcome({ mode: "ask", dispatched: false, event, expectDispatch: false });
        await gateOutcome({ mode: "ask", dispatched: true, event, expectDispatch: true });
        await gateOutcome({ mode: "auto", dispatched: false, event, expectDispatch: true });
        await gateOutcome({ mode: "auto", dispatched: true, event, expectDispatch: true });
      });
    }

    test("verdicts on dispatched agents dispatch in both modes", async () => {
      await gateOutcome({
        mode: "ask",
        dispatched: true,
        event: plainGateEvent("verdict"),
        expectDispatch: true,
      });
      await gateOutcome({
        mode: "auto",
        dispatched: true,
        event: plainGateEvent("verdict"),
        expectDispatch: true,
      });
    });

    test("verdict-insufficient (item unresolved) dispatches in auto mode only for hand-started agents", async () => {
      await gateOutcome({
        mode: "ask",
        dispatched: false,
        reviewState: "ready",
        event: plainGateEvent("verdict"),
        expectDispatch: false,
      });
      await gateOutcome({
        mode: "auto",
        dispatched: false,
        reviewState: "ready",
        event: plainGateEvent("verdict"),
        expectDispatch: true,
      });
    });

    test("a state-resolving verdict (item done) never dispatches for hand-started agents", async () => {
      await gateOutcome({
        mode: "ask",
        dispatched: false,
        reviewState: "done",
        event: plainGateEvent("verdict"),
        expectDispatch: false,
      });
      await gateOutcome({
        mode: "auto",
        dispatched: false,
        reviewState: "done",
        event: plainGateEvent("verdict"),
        expectDispatch: false,
      });
    });
  });
});
