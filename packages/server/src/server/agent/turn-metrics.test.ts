import { describe, expect, it } from "vitest";
import {
  MAX_STORED_TURN_METRICS,
  recordTurnMetrics,
  stampTurnCompletionUsage,
} from "./agent-manager.js";
import { toStoredAgentRecord, type ManagedAgent } from "./agent-projections.js";
import { parseStoredAgentRecord } from "./agent-storage.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { projectTimelineRows } from "./timeline-projection.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { AgentUsage } from "./agent-sdk-types.js";

const METRICS: AgentUsage = {
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 1200,
  model: "test-model",
};

function seedTurn(store: InMemoryAgentTimelineStore, agentId: string, turnId: string): void {
  store.initialize(agentId);
  store.append(agentId, { type: "user_message", text: "hi", clientMessageId: "c1" }, { turnId });
  store.append(agentId, { type: "assistant_message", text: "hello" }, { turnId });
}

describe("stampTurnCompletionUsage", () => {
  it("returns undefined when nothing is known", () => {
    expect(
      stampTurnCompletionUsage({ usage: undefined, startedAt: null, model: null }),
    ).toBeUndefined();
  });

  it("creates a usage object when the provider reported none", () => {
    const stamped = stampTurnCompletionUsage({
      usage: undefined,
      startedAt: new Date(),
      model: "m",
    });
    expect(stamped?.model).toBe("m");
    expect(typeof stamped?.durationMs).toBe("number");
  });

  it("stamps duration and model while keeping provider fields", () => {
    const stamped = stampTurnCompletionUsage({
      usage: { inputTokens: 3 },
      startedAt: new Date(Date.now() - 2000),
      model: "mgr-model",
    });
    expect(stamped?.inputTokens).toBe(3);
    expect(stamped?.model).toBe("mgr-model");
    expect(typeof stamped?.durationMs).toBe("number");
    expect(stamped?.durationMs ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("keeps the provider-reported model over the manager model", () => {
    const stamped = stampTurnCompletionUsage({
      usage: { model: "provider-model" },
      startedAt: null,
      model: "manager-model",
    });
    expect(stamped?.model).toBe("provider-model");
  });
});

describe("updateRowMetrics", () => {
  it("stamps the assistant row of the turn", () => {
    const store = new InMemoryAgentTimelineStore();
    seedTurn(store, "agent-1", "turn-1");
    const updated = store.updateRowMetrics("agent-1", "turn-1", METRICS);
    expect(updated).toMatchObject({ turnId: "turn-1", metrics: METRICS });
    const rows = store.getCommittedRows("agent-1");
    expect(rows.find((row) => row.item.type === "assistant_message")).toMatchObject({
      metrics: METRICS,
    });
    expect(rows.find((row) => row.item.type === "user_message")?.metrics).toBeUndefined();
  });

  it("returns null when the turn has no assistant row", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-2");
    expect(store.updateRowMetrics("agent-2", "missing", METRICS)).toBeNull();
  });
});

describe("turn-metrics projection carry", () => {
  it("carries row metrics onto projected entries across assistant merges", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "assistant_message", text: "a" },
        turnId: "turn-1",
        metrics: METRICS,
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "b" },
        turnId: "turn-1",
        metrics: METRICS,
      },
    ];
    const entries = projectTimelineRows({ rows, mode: "projected" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ metrics: METRICS });
  });
});

describe("recordTurnMetrics size bound", () => {
  it("enforces the bounded size and evicts oldest entries in FIFO order", () => {
    const map = new Map<string, AgentUsage>();
    for (let i = 1; i <= 5; i++) {
      recordTurnMetrics(map, `turn-${i}`, { ...METRICS, inputTokens: i }, 3);
    }
    expect(map.size).toBe(3);
    expect(map.has("turn-1")).toBe(false);
    expect(map.has("turn-2")).toBe(false);
    expect(map.has("turn-3")).toBe(true);
    expect(map.has("turn-4")).toBe(true);
    expect(map.has("turn-5")).toBe(true);
    expect(map.get("turn-5")?.inputTokens).toBe(5);
  });

  it("defaults to MAX_STORED_TURN_METRICS (500)", () => {
    const map = new Map<string, AgentUsage>();
    for (let i = 1; i <= 505; i++) {
      recordTurnMetrics(map, `turn-${i}`, { ...METRICS, inputTokens: i });
    }
    expect(map.size).toBe(MAX_STORED_TURN_METRICS);
    expect(map.has("turn-1")).toBe(false);
    expect(map.has("turn-5")).toBe(false);
    expect(map.has("turn-6")).toBe(true);
    expect(map.has("turn-505")).toBe(true);
  });
});

describe("reAttachMetrics after a rebuild", () => {
  it("re-attaches metrics to assistant rows by matchKey (messageId)", () => {
    const store = new InMemoryAgentTimelineStore();
    // Simulate a timeline rebuilt from provider history (no turnId, but assistant has messageId)
    store.initialize("agent-rebuild");
    store.append("agent-rebuild", { type: "user_message", text: "what is 2+2?" });
    store.append("agent-rebuild", {
      type: "assistant_message",
      text: "4",
      messageId: "msg-assistant-1",
    });

    const metricsMap = new Map<string, AgentUsage>([
      ["msg-assistant-1", { inputTokens: 42, outputTokens: 1, durationMs: 500, model: "e2e-fast" }],
    ]);

    const result = store.reAttachMetrics("agent-rebuild", metricsMap);
    expect(result.attachedCount).toBe(1);
    expect(result.droppedKeys).toEqual([]);

    const rows = store.getCommittedRows("agent-rebuild");
    const assistantRow = rows.find((r) => r.item.type === "assistant_message");
    expect(assistantRow?.metrics).toEqual({
      inputTokens: 42,
      outputTokens: 1,
      durationMs: 500,
      model: "e2e-fast",
    });

    // Also check projected fetch result
    const page = store.fetch("agent-rebuild");
    const projectedAssistant = page.rows.find((r) => r.item.type === "assistant_message");
    expect(projectedAssistant?.metrics).toEqual({
      inputTokens: 42,
      outputTokens: 1,
      durationMs: 500,
      model: "e2e-fast",
    });
  });
});

describe("turn without a matching row is dropped", () => {
  it("drops metrics when no assistant row matches the matchKey", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-orphan");
    store.append("agent-orphan", { type: "user_message", text: "hello" });
    // Assistant message has id 'msg-real'
    store.append("agent-orphan", {
      type: "assistant_message",
      text: "hi",
      messageId: "msg-real",
    });

    const metricsMap = new Map<string, AgentUsage>([
      ["msg-real", { inputTokens: 10, outputTokens: 2 }],
      ["msg-orphaned-turn", { inputTokens: 99, outputTokens: 99 }],
    ]);

    const result = store.reAttachMetrics("agent-orphan", metricsMap);
    expect(result.attachedCount).toBe(1);
    expect(result.droppedKeys).toEqual(["msg-orphaned-turn"]);

    const rows = store.getCommittedRows("agent-orphan");
    // Only msg-real has metrics
    expect(rows.find((r) => r.item.type === "assistant_message")?.metrics).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
    // No row in the timeline carries the orphaned metrics
    expect(rows.some((r) => r.metrics?.inputTokens === 99)).toBe(false);
  });
});

describe("persist and reload turn metrics", () => {
  it("persists turnMetrics map with stored agent record and reloads it", () => {
    const turnMetricsMap = new Map<string, AgentUsage>([
      ["turn-1-msg", { inputTokens: 10, outputTokens: 5, durationMs: 100, model: "m1" }],
      ["turn-2-msg", { inputTokens: 20, outputTokens: 10, durationMs: 200, model: "m2" }],
    ]);

    const mockAgent: ManagedAgent = {
      id: "agent-persist-test",
      provider: "mock",
      cwd: "/tmp",
      session: null,
      lifecycle: "closed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      pendingReplacementOrigin: null,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      persistence: null,
      historyPrimed: true,
      lastUserMessageAt: null,
      attention: { requiresAttention: false },
      labels: {},
      turnMetrics: turnMetricsMap,
      config: { provider: "mock", cwd: "/tmp" },
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsSessionListing: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    };

    const stored = toStoredAgentRecord(mockAgent);
    expect(stored.turnMetrics).toBeDefined();
    expect(stored.turnMetrics?.["turn-1-msg"]).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 100,
      model: "m1",
    });
    expect(stored.turnMetrics?.["turn-2-msg"]).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 200,
      model: "m2",
    });

    const reloaded = parseStoredAgentRecord(JSON.parse(JSON.stringify(stored)));
    expect(reloaded.turnMetrics).toEqual({
      "turn-1-msg": { inputTokens: 10, outputTokens: 5, durationMs: 100, model: "m1" },
      "turn-2-msg": { inputTokens: 20, outputTokens: 10, durationMs: 200, model: "m2" },
    });
  });
});
