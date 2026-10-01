import { describe, expect, it } from "vitest";
import { stampTurnCompletionUsage } from "./agent-manager.js";
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
