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

describe("MissionControlService reset + machinery turns", () => {
  let dir: string;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
      getAgent?: () => ManagedAgent | null;
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
});
