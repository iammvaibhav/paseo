import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CommanderSnapshotInjector } from "./commander-snapshot.js";
import { WORLD_SNAPSHOT_MARKER } from "./context.js";

vi.mock("../agent/agent-prompt.js", () => ({
  formatSystemNotificationPrompt: (reason: string) => `<paseo-system>\n${reason}\n</paseo-system>`,
  startAgentRun: vi.fn(async () => ({ outOfBand: false })),
}));

// eslint-disable-next-line import/order
import { startAgentRun } from "../agent/agent-prompt.js";
const startAgentRunMock = vi.mocked(startAgentRun);

interface LogRecord {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  payload: Record<string, unknown>;
}

function makeLogCapture(): { logger: Logger; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const base = createTestLogger();
  const logger = new Proxy(base, {
    get(target, prop: string) {
      if (prop === "child") {
        return () => logger;
      }
      if (["info", "warn", "error", "debug"].includes(prop)) {
        return (payload: Record<string, unknown>, message: string) => {
          if (typeof payload === "string") {
            message = payload;
            payload = {};
          }
          logs.push({ level: prop as LogRecord["level"], message, payload });
        };
      }
      return Reflect.get(target, prop);
    },
  }) as unknown as Logger;
  return { logger, logs };
}

interface Harness {
  injector: CommanderSnapshotInjector;
  removeTimelineRows: Mock;
  fetchTimeline: Mock;
  push: (event: AgentManagerEvent) => void;
  logs: LogRecord[];
  buildSnapshot: Mock;
}

/** Fixture: a commander-labeled agent (the injection target). */
function commanderAgent(id: string): ManagedAgent {
  return {
    id,
    labels: { "paseo.mission-control": "commander" },
    lifecycle: "idle",
    provider: "omp",
    config: { provider: "omp", cwd: "/repo" },
  } as unknown as ManagedAgent;
}

/** Fixture: an ordinary worker agent (never a snapshot target). */
function workerAgent(id: string): ManagedAgent {
  return {
    id,
    labels: {},
    lifecycle: "idle",
    provider: "omp",
    config: { provider: "omp", cwd: "/repo" },
  } as unknown as ManagedAgent;
}

/** Fixture: a committed snapshot row the injector must supersede. */
interface SnapshotTimelineRow {
  seq: number;
  item: { type: "user_message"; text: string };
}

function snapshotRow(seq: number, at = "2026-08-08T00:00:00.000Z"): SnapshotTimelineRow {
  return {
    seq,
    item: {
      type: "user_message",
      text: `<paseo-system>\n${WORLD_SNAPSHOT_MARKER}${at}\n...\n</paseo-system>`,
    },
  };
}

function makeHarness(options: {
  agent: ManagedAgent | null;
  busy?: boolean;
  timelineRows?: SnapshotTimelineRow[];
}): Harness {
  const subscribers: Array<(event: AgentManagerEvent) => void> = [];
  const removeTimelineRows = vi.fn(async () => undefined);
  const fetchTimeline = vi.fn(async () => ({ rows: options.timelineRows ?? [] }));
  const { logger, logs } = makeLogCapture();
  const buildSnapshot = vi.fn(async () => ({
    at: new Date().toISOString(),
    block: `${WORLD_SNAPSHOT_MARKER}${new Date().toISOString()}\n# Fleet map\n- local`,
  }));
  const agentManager = {
    getAgent: (id: string) => (options.agent?.id === id ? options.agent : null),
    hasInFlightRun: () => Boolean(options.busy),
    subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscribers.push(callback);
      return () => {
        const index = subscribers.indexOf(callback);
        if (index >= 0) {
          subscribers.splice(index, 1);
        }
      };
    }),
    removeTimelineRows,
    fetchTimeline,
  } as unknown as Pick<
    AgentManager,
    "getAgent" | "hasInFlightRun" | "subscribe" | "removeTimelineRows" | "fetchTimeline"
  >;
  const injector = new CommanderSnapshotInjector({
    agentManager,
    logger,
    buildSnapshot,
  });
  return {
    injector,
    removeTimelineRows,
    fetchTimeline,
    push: (event) => {
      for (const callback of subscribers) {
        callback(event);
      }
    },
    logs,
    buildSnapshot,
  };
}

describe("CommanderSnapshotInjector", () => {
  beforeEach(() => {
    startAgentRunMock.mockClear();
    startAgentRunMock.mockResolvedValue({ outOfBand: false });
  });

  test("is a no-op for non-commander agents: no snapshot dispatch", async () => {
    const harness = makeHarness({ agent: workerAgent("worker-1") });
    await harness.injector.beforeTurn({
      agentId: "worker-1",
      prompt: "hello",
      replaceRunning: true,
    });
    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(harness.removeTimelineRows).not.toHaveBeenCalled();
  });

  test("never injects a snapshot ahead of the launch first message, but arms its ack-drop", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    await harness.injector.beforeTurn({
      agentId: "commander-1",
      prompt: `<paseo-system>\n${WORLD_SNAPSHOT_MARKER}2026-08-08T00:00:00.000Z\n# Fleet map\n...\n</paseo-system>`,
      replaceRunning: true,
    });
    expect(startAgentRunMock).not.toHaveBeenCalled();
    // The launch turn's pure-ack reply must be retracted like any snapshot
    // turn — armed in the seam because onCommanderCreated fires too late.
    expect(harness.injector.ackDrop.isArmed).toBe(true);
  });

  test("dispatches one fresh snapshot ahead of the delivered message", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    await harness.injector.beforeTurn({
      agentId: "commander-1",
      prompt: "user message",
      replaceRunning: true,
    });
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
    const [manager, agentId, prompt, , options] = (startAgentRunMock.mock.calls[0] ?? []) as [
      unknown,
      string,
      string,
      unknown,
      { replaceRunning: boolean; runOptions: { clientMessageId: string } },
    ];
    // startAgentRun(agentManager, agentId, prompt, logger, options): the
    // injector passes its widened AgentRunController first.
    expect(manager).toMatchObject({
      getAgent: expect.any(Function),
      subscribe: expect.any(Function),
    });
    expect(agentId).toBe("commander-1");
    expect(prompt).toMatch(/^<paseo-system>\n# Fleet state as of /);
    expect(prompt).toContain(WORLD_SNAPSHOT_MARKER);
    // The snapshot turn must be ack-retractable: the no-prose instruction
    // rides the body, and the row is staged via a unique clientMessageId so
    // the delivered message's replacement cannot race it out of the timeline.
    expect(prompt).toContain("reply with a single short acknowledgment token");
    expect(options.replaceRunning).toBe(false);
    expect(options.runOptions.clientMessageId).toMatch(/^snapshot-/);
    expect(
      harness.logs.some((record) => record.message === "mission_control.snapshot.injected"),
    ).toBe(true);
  });

  test("supersedes every current snapshot row (launch + duplicates) before dispatching the fresh one", async () => {
    const harness = makeHarness({
      agent: commanderAgent("commander-1"),
      // Launch row + a duplicate late provider echo of it: both are stale
      // once the fresh snapshot is dispatched.
      timelineRows: [snapshotRow(3), snapshotRow(9)],
    });
    await harness.injector.beforeTurn({
      agentId: "commander-1",
      prompt: "next",
      replaceRunning: true,
    });
    expect(harness.removeTimelineRows).toHaveBeenCalledWith(
      "commander-1",
      [3, 9],
      "snapshot-supersede",
    );
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
  });

  test("skips injection when the Commander is busy (running turn carries the prior row)", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1"), busy: true });
    await harness.injector.beforeTurn({
      agentId: "commander-1",
      prompt: "steer",
      replaceRunning: false,
    });
    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(
      harness.logs.some(
        (record) => record.message === "mission_control.snapshot.skipped_busy_commander",
      ),
    ).toBe(true);
  });

  test("machinery path (replaceRunning:false) waits for the snapshot turn to settle", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    let settled = false;
    const turn = harness.injector
      .beforeTurn({ agentId: "commander-1", prompt: "machinery", replaceRunning: false })
      .then(() => {
        settled = true;
        return null;
      });
    // The snapshot was dispatched; beforeTurn must still be waiting.
    await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    harness.push({
      type: "agent_stream",
      agentId: "commander-1",
      event: { type: "turn_completed", provider: "omp", turnId: "turn-1" },
    } as AgentManagerEvent);
    await turn;
    expect(settled).toBe(true);
  });

  test("user path (replaceRunning:true) does not wait for the snapshot turn", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    let settled = false;
    const turn = harness.injector
      .beforeTurn({ agentId: "commander-1", prompt: "user", replaceRunning: true })
      .then(() => {
        settled = true;
        return null;
      });
    await turn;
    expect(settled).toBe(true);
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
  });

  test("a failed snapshot dispatch never fails the delivered message", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    startAgentRunMock.mockRejectedValueOnce(new Error("provider closed"));
    await expect(
      harness.injector.beforeTurn({
        agentId: "commander-1",
        prompt: "user message",
        replaceRunning: true,
      }),
    ).resolves.toBeUndefined();
    expect(
      harness.logs.some((record) => record.message === "mission_control.snapshot.dispatch_failed"),
    ).toBe(true);
  });

  test("armLaunchTurn attaches and arms the ack-drop for the launch first turn", async () => {
    const harness = makeHarness({ agent: commanderAgent("commander-1") });
    harness.injector.armLaunchTurn("commander-1");
    expect(harness.injector.ackDrop.isArmed).toBe(true);
  });
});
