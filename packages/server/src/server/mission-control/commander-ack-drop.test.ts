import { describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import { CommanderAckDrop } from "./commander-ack-drop.js";

interface LogRecord {
  level: "info" | "warn" | "error";
  payload: Record<string, unknown>;
  message: string;
}

function makeLogCapture(): { logger: Logger; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const logger = {
    child: () => logger,
    info: (payload: unknown, message: string) =>
      logs.push({ level: "info", payload: payload as Record<string, unknown>, message }),
    warn: (payload: unknown, message: string) =>
      logs.push({ level: "warn", payload: payload as Record<string, unknown>, message }),
    error: (payload: unknown, message: string) =>
      logs.push({ level: "error", payload: payload as Record<string, unknown>, message }),
    trace: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    silent: () => undefined,
  } as unknown as Logger;
  return { logger, logs };
}

interface Harness {
  ackDrop: CommanderAckDrop;
  push: (event: AgentManagerEvent) => void;
  removeTimelineRows: ReturnType<typeof vi.fn>;
  logs: LogRecord[];
}

function makeHarness(): Harness {
  const subscribers: Array<(event: AgentManagerEvent) => void> = [];
  const removeTimelineRows = vi.fn(async () => undefined);
  const agentManager = {
    subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscribers.push(callback);
      return () => undefined;
    }),
    removeTimelineRows,
  } as unknown as AgentManager;
  const { logger, logs } = makeLogCapture();
  const ackDrop = new CommanderAckDrop({ agentManager, logger });
  ackDrop.attach("commander-1");
  return {
    ackDrop,
    push: (event) => {
      for (const callback of subscribers) {
        callback(event);
      }
    },
    removeTimelineRows,
    logs,
  };
}

function turnStarted(turnId: string): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: "commander-1",
    event: { type: "turn_started", provider: "omp", turnId },
  };
}

function assistantMessage(text: string, seq: number): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: "commander-1",
    event: {
      type: "timeline",
      provider: "omp",
      item: { type: "assistant_message", text },
    },
    seq,
  };
}

function turnCompleted(turnId: string): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: "commander-1",
    event: { type: "turn_completed", provider: "omp", turnId },
  };
}

describe("CommanderAckDrop", () => {
  test("retracts a pure-ack reply from an armed machinery turn and logs the drop", async () => {
    const { ackDrop, push, removeTimelineRows, logs } = makeHarness();
    ackDrop.arm();

    push(turnStarted("turn-1"));
    push(assistantMessage("ok", 7));
    push(turnCompleted("turn-1"));

    await vi.waitFor(() => expect(removeTimelineRows).toHaveBeenCalledTimes(1));
    expect(removeTimelineRows).toHaveBeenCalledWith("commander-1", [7], "ack-drop");
    const dropLog = logs.find((record) => record.message === "mission_control.digest.ack_drop");
    expect(dropLog).toBeDefined();
    expect(dropLog?.payload).toMatchObject({
      component: "digest",
      agentId: "commander-1",
      seqs: [7],
      text: "ok",
    });
    expect(ackDrop.isArmed).toBe(false);
  });

  test("never classifies a user turn (not armed)", async () => {
    const { push, removeTimelineRows } = makeHarness();
    push(turnStarted("turn-user"));
    push(assistantMessage("ok", 1));
    push(turnCompleted("turn-user"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });

  test("keeps an armed turn's reply when it contains a question", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    ackDrop.arm();

    push(turnStarted("turn-q"));
    push(assistantMessage("Want me to dig into it?", 3));
    push(turnCompleted("turn-q"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });

  test("keeps an armed turn's reply when the turn used a tool call", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    ackDrop.arm();

    push(turnStarted("turn-tool"));
    push({
      type: "agent_stream",
      agentId: "commander-1",
      event: {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "fleet_list_agents",
          status: "completed",
          payload: {
            source: "agent",
            data: { name: "fleet_list_agents", detail: { type: "plain_text" } },
          },
        },
      },
      seq: 4,
    });
    push(assistantMessage("ok", 5));
    push(turnCompleted("turn-tool"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });

  test("arming is one-shot: only the first turn after arm() is classified", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    ackDrop.arm();

    // A machinery turn starts and completes.
    push(turnStarted("turn-m1"));
    push(assistantMessage("ok", 10));
    push(turnCompleted("turn-m1"));
    await vi.waitFor(() => expect(removeTimelineRows).toHaveBeenCalledTimes(1));

    // A later user turn that races in is never classified.
    push(turnStarted("turn-u2"));
    push(assistantMessage("ok", 11));
    push(turnCompleted("turn-u2"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).toHaveBeenCalledTimes(1);
  });

  test("an armed dispatch that starts no turn expires when the in-flight turn settles", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    // The Commander is mid-user-turn when the machinery delivery lands as an
    // out-of-band steer: no new turn starts, and the in-flight turn's settle
    // must disarm the tracker so the NEXT user turn is never classified.
    push(turnStarted("turn-busy"));
    ackDrop.arm();
    push(turnCompleted("turn-busy"));
    expect(ackDrop.isArmed).toBe(false);

    push(turnStarted("turn-next-user"));
    push(assistantMessage("ok", 12));
    push(turnCompleted("turn-next-user"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });

  test("a failed or canceled armed turn never classifies a partial reply", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    ackDrop.arm();

    push(turnStarted("turn-x"));
    push(assistantMessage("ok", 13));
    push({
      type: "agent_stream",
      agentId: "commander-1",
      event: { type: "turn_canceled", provider: "omp", reason: "user interrupt" },
    });

    push(turnStarted("turn-y"));
    push(assistantMessage("ok", 14));
    push(turnCompleted("turn-y"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });

  test("disarm() cancels an armed dispatch", async () => {
    const { ackDrop, push, removeTimelineRows } = makeHarness();
    ackDrop.arm();
    ackDrop.disarm();

    push(turnStarted("turn-z"));
    push(assistantMessage("ok", 15));
    push(turnCompleted("turn-z"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeTimelineRows).not.toHaveBeenCalled();
  });
});
