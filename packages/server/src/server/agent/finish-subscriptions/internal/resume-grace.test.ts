import { expect, test } from "vitest";
import type { AgentManagerEvent, ManagedAgent } from "../../agent-manager.js";
import type { StoredAgentRecord } from "../../agent-storage.js";
import { awaitResumedChildRun } from "./resume-grace.js";

function storedChild(overrides: Partial<StoredAgentRecord>): StoredAgentRecord {
  return {
    id: "child",
    provider: "codex",
    cwd: "/tmp",
    title: "Child",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: {},
    lastStatus: "closed",
    ...overrides,
  };
}

function scenario(stored: StoredAgentRecord) {
  const listeners: Array<(event: AgentManagerEvent) => void> = [];
  return {
    resume() {
      const agent = { id: "child", lifecycle: "running" } as ManagedAgent;
      for (const listener of listeners) listener({ type: "agent_state", agent });
    },
    listeners,
    input: {
      agentManager: {
        getAgent: () => null,
        subscribe(listener: (event: AgentManagerEvent) => void) {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        getLastAssistantMessage: async () => "Halfway through the migration",
      },
      agentStorage: { get: async () => stored },
      childAgentId: "child",
      signal: new AbortController().signal,
    },
  };
}

const interruptedByShutdown = { requiresAttention: true, attentionReason: "error" } as const;

test("a child that closed on its own reports its own outcome, not a restart interruption", async () => {
  const { input, listeners } = scenario(storedChild({ lastStatus: "closed" }));
  await expect(awaitResumedChildRun({ ...input, graceMs: 60_000 })).resolves.toBeNull();
  expect(listeners).toHaveLength(0);
});

test("an interrupted child that resumes within the grace period reports nothing yet", async () => {
  const child = scenario(storedChild(interruptedByShutdown));
  const result = awaitResumedChildRun({ ...child.input, graceMs: 60_000 });
  await expect.poll(() => child.listeners.length).toBe(1);
  child.resume();
  await expect(result).resolves.toBeNull();
  expect(child.listeners).toHaveLength(0);
});

test("an interrupted child that never resumes reports the restart interruption", async () => {
  const { input } = scenario(storedChild(interruptedByShutdown));
  const result = await awaitResumedChildRun({ ...input, graceMs: 5 });
  expect(result).toMatchObject({
    status: "error",
    reason: "was interrupted by a daemon restart and did not resume",
    lastMessage: "Halfway through the migration",
  });
});
