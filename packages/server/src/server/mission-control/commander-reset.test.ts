import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";

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

describe("MissionControlService reset + machinery turns", () => {
  let dir: string;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
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

  test("an AUTO-mode blocked event dispatches a machinery turn to the Commander", async () => {
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

  test("AUTO mode dispatches a machinery turn for a stalled escalation", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: "Stalled (no response for 5 min)",
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

  test("a dispatched agent's finished event triggers a follow-up machinery turn in ASK mode", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "machinery",
      replaceOrigin: "machinery",
    });
    expect(call?.prompt).toContain("[finished] Finished");
    // The follow-up tail carries the decision rule, not the needs-you ack rule.
    expect(call?.prompt).toContain("follow-up on a worker you dispatched");
    expect(call?.prompt).toContain("(a) propose a follow-up action");
    expect(call?.prompt).toContain("(b) post_answer");
    expect(call?.prompt).toContain("(c) nothing when the feed card already says it all");
    expect(call?.prompt).not.toContain("reply with a single short acknowledgment token");
  });

  test("a dispatched agent's finished event triggers a follow-up machinery turn in AUTO mode", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toContain("[finished] Finished");
  });

  test("a dispatched agent's failed and interrupted events also trigger follow-up turns in ASK mode", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "failed",
      source: "system",
      severity: "attention",
      headline: "Failed with an error",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    expect(dispatchLocalPromptModeMock.mock.calls[0]?.[0]?.prompt).toContain("[failed]");
    // A new run (started bumps the epoch) earns a fresh slot for the next
    // terminal kind.
    service.publishEvent({
      agentId: "worker-1",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started",
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "interrupted",
      source: "system",
      severity: "info",
      headline: "Interrupted by you",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(2));
    expect(dispatchLocalPromptModeMock.mock.calls[1]?.[0]?.prompt).toContain("[interrupted]");
  });

  test("a non-dispatched agent's finished event stays silent in ASK mode", async () => {
    await createService({ storedAgents: [commanderRecord("commander-1")] });
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

  test("an adopted agent's terminal event triggers a follow-up turn", async () => {
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
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
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

  test("terminal follow-up turns are rate-limited to one per agent run epoch", async () => {
    await createService({
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    await service.setMode("auto");
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    // Same epoch: a second terminal event must not re-alert.
    service.publishEvent({
      agentId: "worker-1",
      kind: "failed",
      source: "system",
      severity: "attention",
      headline: "Failed with an error",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1);
    // A new run (started bumps the epoch) earns a fresh follow-up turn.
    service.publishEvent({
      agentId: "worker-1",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started",
    });
    service.publishEvent({
      agentId: "worker-1",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(2));
  });
});
