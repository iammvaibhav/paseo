import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentFinishWatches } from "./finish-watches.js";

// Agent ids must be UUIDs: the manager validates them.
const CALLER = "0b9c1f7e-1d2a-4c3b-8e4f-5a6b7c8d9e01";
const CHILD = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02";

function fakeAgent(id: string, lifecycle: ManagedAgent["lifecycle"]): ManagedAgent {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", id);
  Reflect.set(agent, "lifecycle", lifecycle);
  Reflect.set(agent, "config", { title: id });
  Reflect.set(agent, "pendingPermissions", new Map());
  return agent;
}

/**
 * One daemon process: an AgentManager hosting the given agents. Each process
 * starts with its own manager, as a restarted daemon does.
 */
function daemonProcess(agents: Map<string, ManagedAgent>) {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  const callerPrompts: string[] = [];
  const agentManager = new AgentManager({ clients: {}, logger: createTestLogger() });
  Reflect.set(agentManager, "getAgent", (agentId: string) => agents.get(agentId) ?? null);
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async (agentId: string) =>
    agentId === CHILD ? "Report written." : null,
  );
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => ({ status: "inactive" }));
  Reflect.set(agentManager, "streamAgent", (agentId: string, prompt: string) => {
    if (agentId === CALLER) callerPrompts.push(prompt);
    return (async function* noop() {})();
  });
  return {
    agentManager,
    callerPrompts,
    emit(agentId: string, lifecycle: ManagedAgent["lifecycle"]) {
      const agent = agents.get(agentId) ?? fakeAgent(agentId, lifecycle);
      agent.lifecycle = lifecycle;
      agents.set(agentId, agent);
      subscriber?.({ type: "agent_state", agent });
    },
  };
}

describe("createAgentFinishWatches", () => {
  let dir: string;
  let journalPath: string;
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) =>
    agentId === CALLER || agentId === CHILD
      ? { title: agentId === CHILD ? "Child" : "Caller", labels: {} }
      : null,
  );

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-finish-watches-"));
    journalPath = path.join(dir, "mcp-fleet", "agent-finish-watches.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const journalEvents = async () =>
    (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const entry: unknown = JSON.parse(line);
        return entry && typeof entry === "object" && "event" in entry ? entry.event : null;
      });

  // The caller armed a watch on its child's run; the daemon shuts down mid-run.
  async function armThenShutDown() {
    const before = daemonProcess(
      new Map([
        [CALLER, fakeAgent(CALLER, "idle")],
        [CHILD, fakeAgent(CHILD, "running")],
      ]),
    );
    const watches = createAgentFinishWatches({
      agentManager: before.agentManager,
      agentStorage,
      logger: createTestLogger(),
      journalPath,
    });
    watches.arm({ childAgentId: CHILD, callerAgentId: CALLER, requireParentOwnership: false });
    await watches.suspend();
    // Shutdown closes every agent; the suspended watch must not report it.
    before.emit(CHILD, "closed");
    await setImmediate();
    expect(before.callerPrompts).toEqual([]);
  }

  it("tells the caller when the child's resumed run finishes after a restart", async () => {
    await armThenShutDown();

    // The restarted daemon has not loaded the child yet; delivery loads the caller.
    const after = daemonProcess(new Map([[CALLER, fakeAgent(CALLER, "idle")]]));
    const watches = createAgentFinishWatches({
      agentManager: after.agentManager,
      agentStorage,
      logger: createTestLogger(),
      journalPath,
    });
    expect(await watches.restore()).toEqual({ restored: 1 });

    // Loading the child replays its closed state; only the resumed run's end counts.
    after.emit(CHILD, "closed");
    after.emit(CHILD, "idle");
    after.emit(CHILD, "running");
    after.emit(CHILD, "idle");
    await vi.waitFor(() => expect(after.callerPrompts).toHaveLength(1));
    expect(after.callerPrompts[0]).toContain(`Agent ${CHILD} (Child) finished.`);
    expect(after.callerPrompts[0]).toContain("Report written.");
    expect(after.callerPrompts[0]).not.toContain("was closed");

    await vi.waitFor(async () =>
      expect(await journalEvents()).toEqual([
        "armed",
        "suspended",
        "restored",
        "resumed",
        "fired",
        "delivered",
      ]),
    );
    const again = createAgentFinishWatches({
      agentManager: daemonProcess(new Map()).agentManager,
      agentStorage,
      logger: createTestLogger(),
      journalPath,
    });
    expect(await again.restore()).toEqual({ restored: 0 });
  });

  it("tells the caller the child was interrupted when its run never resumes", async () => {
    await armThenShutDown();

    const after = daemonProcess(new Map([[CALLER, fakeAgent(CALLER, "idle")]]));
    const watches = createAgentFinishWatches({
      agentManager: after.agentManager,
      agentStorage,
      logger: createTestLogger(),
      journalPath,
      resumeGraceMs: 1,
    });
    await watches.restore();
    await vi.waitFor(() => expect(after.callerPrompts).toHaveLength(1));
    expect(after.callerPrompts[0]).toContain(
      `Agent ${CHILD} (Child) was interrupted by a daemon restart and did not resume.`,
    );
  });
});
