import { describe, expect, test, vi, beforeEach } from "vitest";
import type { Logger } from "pino";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  formatSystemNotificationPrompt,
  startAgentRun,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { MissionControlDigest, isPureAckReply } from "./digest.js";

vi.mock("../agent/agent-prompt.js", () => ({
  formatSystemNotificationPrompt: (reason: string) => `<paseo-system>\n${reason}\n</paseo-system>`,
  startAgentRun: vi.fn(async () => ({ outOfBand: false })),
  waitForAgentRunStartWithTimeout: vi.fn(async () => undefined),
}));

const startAgentRunMock = vi.mocked(startAgentRun);
const waitForAgentRunStartWithTimeoutMock = vi.mocked(waitForAgentRunStartWithTimeout);

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

function makeDigestEvent(): MissionControlEvent {
  return {
    id: "mce_test",
    ts: new Date().toISOString(),
    agentId: "worker-1",
    agentTitle: "Worker One",
    kind: "milestone",
    source: "system",
    severity: "info",
    headline: "Fixed the build",
  };
}

interface DigestHarness {
  digest: MissionControlDigest;
  push: (event: AgentManagerEvent) => void;
  removeTimelineRows: ReturnType<typeof vi.fn>;
  logs: LogRecord[];
}

function makeHarness(): DigestHarness {
  const subscribers: Array<(event: AgentManagerEvent) => void> = [];
  const removeTimelineRows = vi.fn(async () => undefined);
  const commander = {
    id: "commander-1",
    labels: { "paseo.mission-control": "commander" },
    lifecycle: "idle",
  };
  const agentManager = {
    listAgents: vi.fn(() => [commander]),
    getAgent: vi.fn(() => commander),
    hasInFlightRun: vi.fn(() => false),
    clearAgentAttention: vi.fn(async () => undefined),
    removeTimelineRows,
    subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscribers.push(callback);
      return () => undefined;
    }),
  } as unknown as AgentManager;
  const agentStorage = { list: vi.fn(async () => []) } as unknown as AgentStorage;
  const { logger, logs } = makeLogCapture();
  const digest = new MissionControlDigest({
    agentManager,
    agentStorage,
    logger,
  });
  return {
    digest,
    push: (event) => {
      for (const callback of subscribers) {
        callback(event);
      }
    },
    removeTimelineRows,
    logs,
  };
}

describe("isPureAckReply", () => {
  test("accepts single-token acknowledgments with optional punctuation", () => {
    for (const text of [
      "ok",
      "OK",
      "Ok.",
      "okay",
      "ok!",
      "k",
      "kk",
      "got it",
      "ack",
      "acknowledged",
      "roger",
      "understood",
      "noted",
      "done",
      "sounds good",
      "will do",
      "sure",
      "yep",
      "yes",
      "fine",
      "10-4",
      "👍",
    ]) {
      expect(isPureAckReply(text), text).toBe(true);
    }
  });

  test("accepts no-action phrases", () => {
    for (const text of [
      "nothing to do",
      "No action needed.",
      "Nothing needs action",
      "no action required",
      "nothing to report",
      "all clear",
      "No changes needed.",
    ]) {
      expect(isPureAckReply(text), text).toBe(true);
    }
  });

  test("accepts multi-clause standby acknowledgments (context-pack boot replies)", () => {
    for (const text of [
      "Acknowledged — fleet snapshot received. Standing by.",
      "Acknowledged. Standing by.",
      "Received. Standing by.",
      "Understood — fleet context loaded. Ready.",
      "ok — snapshot received. On standby.",
    ]) {
      expect(isPureAckReply(text), text).toBe(true);
    }
  });

  test("never drops standby replies that contain action or decision verbs", () => {
    for (const text of [
      "Acknowledged stall — dispatched recovery to worker-1. Standing by.",
      "Acknowledged. I'll create a new workspace. Standing by.",
      "Received — spawning verifier for worker-2. Ready.",
    ]) {
      expect(isPureAckReply(text), text).toBe(false);
    }
  });
  test("never drops empty, multiline, or long replies", () => {
    expect(isPureAckReply("")).toBe(false);
    expect(isPureAckReply("   ")).toBe(false);
    expect(isPureAckReply("ok\nok")).toBe(false);
    expect(isPureAckReply("ok ".repeat(30))).toBe(false);
  });

  test("never drops replies containing a question", () => {
    for (const text of ["ok?", "Anything else?", "Should I dispatch a verifier?", "ok?"]) {
      expect(isPureAckReply(text), text).toBe(false);
    }
  });

  test("never drops replies containing a proposal or offer to act", () => {
    for (const text of [
      "I can check the logs if you want",
      "Want me to look into it?",
      "Let me verify that first",
      "I'll send a steer",
      "Shall I nudge the worker?",
      "Happy to investigate",
      "ok, I will dispatch",
    ]) {
      expect(isPureAckReply(text), text).toBe(false);
    }
  });

  test("never drops replies with tool-call-like or structured content", () => {
    for (const text of [
      "<paseo-system>ok</paseo-system>",
      "```json\n{}\n```",
      "run `fleet_list_agents`",
    ]) {
      expect(isPureAckReply(text), text).toBe(false);
    }
  });
});

describe("MissionControlDigest ack suppression", () => {
  beforeEach(() => {
    startAgentRunMock.mockClear();
    startAgentRunMock.mockResolvedValue({ outOfBand: false });
    waitForAgentRunStartWithTimeoutMock.mockClear();
    waitForAgentRunStartWithTimeoutMock.mockResolvedValue(undefined);
  });

  test("retracts a pure-ack reply from a digest-initiated turn and logs the drop", async () => {
    const { digest, push, removeTimelineRows, logs } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-1" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 7,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-1" },
      });

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
    } finally {
      digest.stop();
    }
  });

  test("retracts a multi-chunk ack reply as one message", async () => {
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-2" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "got " },
        },
        seq: 8,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "it" },
        },
        seq: 9,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-2" },
      });

      await vi.waitFor(() => expect(removeTimelineRows).toHaveBeenCalledTimes(1));
      expect(removeTimelineRows).toHaveBeenCalledWith("commander-1", [8, 9], "ack-drop");
    } finally {
      digest.stop();
    }
  });

  test("keeps replies that contain a question", async () => {
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-3" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "Want me to dig into it?" },
        },
        seq: 10,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-3" },
      });

      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removeTimelineRows).not.toHaveBeenCalled();
    } finally {
      digest.stop();
    }
  });

  test("keeps replies from a turn that used a tool call", async () => {
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-4" },
      });
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
        seq: 11,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 12,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-4" },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removeTimelineRows).not.toHaveBeenCalled();
    } finally {
      digest.stop();
    }
  });

  test("never classifies a turn the digest did not initiate", async () => {
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      // A user interrupt cancels the digest turn; the follow-up user turn must
      // not be classified even though it is pure-ack shaped.
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-5" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 13,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_canceled", provider: "omp", reason: "user interrupt" },
      });

      // User-prompted turn: arrives without ackDropArmed.
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-6" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 14,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-6" },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removeTimelineRows).not.toHaveBeenCalled();
    } finally {
      digest.stop();
    }
  });

  test("out-of-band dispatch disarms and never classifies", async () => {
    startAgentRunMock.mockResolvedValue({ outOfBand: true });
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-7" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 15,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-7" },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removeTimelineRows).not.toHaveBeenCalled();
    } finally {
      digest.stop();
    }
  });

  test("dispatch failure (user-prompt race) disarms and keeps the buffer", async () => {
    startAgentRunMock.mockRejectedValue(new Error("raced a user prompt"));
    const { digest, push, removeTimelineRows } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-8" },
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 16,
      });
      push({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-8" },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removeTimelineRows).not.toHaveBeenCalled();
    } finally {
      digest.stop();
    }
  });

  test("digest prompt no longer carries the orchestrator reminder", async () => {
    const { digest } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      const prompt = startAgentRunMock.mock.calls[0]?.[2] as string;
      expect(prompt).toContain("Fleet digest: 1 event.");
      expect(prompt).toContain("<paseo-system>");
      expect(prompt).not.toMatch(/Reminder: you are the orchestrator/);
    } finally {
      digest.stop();
    }
  });

  test("formatSystemNotificationPrompt still wraps digests", () => {
    const wrapped = formatSystemNotificationPrompt("Fleet digest: 1 event.");
    expect(wrapped).toMatch(/^<paseo-system>\nFleet digest: 1 event\.\n<\/paseo-system>$/);
  });
});

describe("MissionControlDigest context snapshot reprime", () => {
  function makeReprimeHarness() {
    const subscribers: Array<(event: AgentManagerEvent) => void> = [];
    const commander = {
      id: "commander-1",
      labels: { "paseo.mission-control": "commander" },
      lifecycle: "idle",
      persistence: { provider: "omp", sessionId: "session-A" },
    };
    const agentManager = {
      listAgents: vi.fn(() => [commander]),
      getAgent: vi.fn(() => commander),
      hasInFlightRun: vi.fn(() => false),
      clearAgentAttention: vi.fn(async () => undefined),
      removeTimelineRows: vi.fn(async () => undefined),
      subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
        subscribers.push(callback);
        return () => undefined;
      }),
    } as unknown as AgentManager;
    const { logger } = makeLogCapture();
    const deltaBlock = vi.fn(async (fresh?: boolean) =>
      fresh ? "<paseo-system> Fleet context snapshot:\n# Fleet map" : null,
    );
    const digest = new MissionControlDigest({
      agentManager,
      agentStorage: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
      } as unknown as AgentStorage,
      logger,
      contextProvider: { deltaBlock },
    });
    return {
      digest,
      commander,
      deltaBlock,
      push: (event: AgentManagerEvent) => {
        for (const callback of subscribers) {
          callback(event);
        }
      },
    };
  }

  test("a changed commander session id requests a full snapshot on the next digest", async () => {
    startAgentRunMock.mockClear();
    const harness = makeReprimeHarness();
    harness.digest.start();
    try {
      harness.digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
      expect(harness.deltaBlock).toHaveBeenCalledWith(false);

      // Session restart: the provider hands back a fresh session id.
      harness.commander.persistence = { provider: "omp", sessionId: "session-B" };
      startAgentRunMock.mockClear();
      harness.digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      expect(harness.deltaBlock).toHaveBeenLastCalledWith(true);
      const prompt = startAgentRunMock.mock.calls[0]?.[2] as string;
      expect(prompt).toContain("Fleet context snapshot:");
    } finally {
      harness.digest.stop();
    }
  });

  test("a compaction event on the commander stream requests a full snapshot", async () => {
    startAgentRunMock.mockClear();
    const harness = makeReprimeHarness();
    harness.digest.start();
    try {
      harness.digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
      expect(harness.deltaBlock).toHaveBeenCalledWith(false);

      startAgentRunMock.mockClear();
      harness.push({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "compaction", status: "completed" },
        },
        seq: 99,
        timestamp: new Date().toISOString(),
      } as AgentManagerEvent);
      harness.digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));

      expect(harness.deltaBlock).toHaveBeenLastCalledWith(true);
      const prompt = startAgentRunMock.mock.calls[0]?.[2] as string;
      expect(prompt).toContain("Fleet context snapshot:");
    } finally {
      harness.digest.stop();
    }
  });

  test("digest prompt instructs no prose when nothing needs action", async () => {
    startAgentRunMock.mockClear();
    const { digest } = makeHarness();
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
      const prompt = startAgentRunMock.mock.calls[0]?.[2] as string;
      expect(prompt).toMatch(/acknowledgment token/);
      expect(prompt).toMatch(/No summaries, no narration/);
    } finally {
      digest.stop();
    }
  });

  test("digest with a context block carries exactly one paseo-system envelope", async () => {
    startAgentRunMock.mockClear();
    const subscribers: Array<(event: AgentManagerEvent) => void> = [];
    const commander = {
      id: "commander-1",
      labels: { "paseo.mission-control": "commander" },
      lifecycle: "idle",
      persistence: { provider: "omp", sessionId: "session-A" },
    };
    const agentManager = {
      listAgents: vi.fn(() => [commander]),
      getAgent: vi.fn(() => commander),
      hasInFlightRun: vi.fn(() => false),
      clearAgentAttention: vi.fn(async () => undefined),
      removeTimelineRows: vi.fn(async () => undefined),
      subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
        subscribers.push(callback);
        return () => undefined;
      }),
    } as unknown as AgentManager;
    const { logger } = makeLogCapture();
    const digest = new MissionControlDigest({
      agentManager,
      agentStorage: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
      } as unknown as AgentStorage,
      logger,
      contextProvider: {
        deltaBlock: vi.fn(async (fresh?: boolean) =>
          fresh ? "Fleet context snapshot:\n# Fleet map" : "Context update:\n- changed x",
        ),
      },
    });
    digest.start();
    try {
      digest.enqueue(makeDigestEvent(), { serverId: "s1", hostName: "h1" });
      await vi.waitFor(() => expect(startAgentRunMock).toHaveBeenCalledTimes(1));
      const prompt = startAgentRunMock.mock.calls[0]?.[2] as string;
      expect(prompt).toMatch(/^<paseo-system>\n/);
      expect(prompt).toMatch(/\n<\/paseo-system>$/);
      expect((prompt.match(/<paseo-system>/g) ?? []).length).toBe(1);
      expect(prompt).toContain("Context update:");
    } finally {
      digest.stop();
    }
  });
});
