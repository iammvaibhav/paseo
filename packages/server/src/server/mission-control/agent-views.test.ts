import { describe, expect, test } from "vitest";
import { AgentViewTracker, VIEW_GRACE_MS, VIEW_STALE_MS } from "./agent-views.js";

function tracker() {
  let now = 1_000_000;
  const views = new AgentViewTracker(() => now);
  return {
    views,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("AgentViewTracker", () => {
  test("an agent is viewed while a visible client shows it, and only that agent", () => {
    const { views } = tracker();
    views.noteHeartbeat("app", { agentId: "a1", appVisible: true });
    expect(views.isViewed("a1")).toBe(true);
    expect(views.isViewed("a2")).toBe(false);
  });

  test("a hidden app does not count", () => {
    const { views } = tracker();
    views.noteHeartbeat("app", { agentId: "a1", appVisible: false });
    expect(views.isViewed("a1")).toBe(false);
  });

  test("switching away still counts for the grace window, then stops", () => {
    const { views, advance } = tracker();
    views.noteHeartbeat("app", { agentId: "a1", appVisible: true });
    advance(10_000);
    views.noteHeartbeat("app", { agentId: "a2", appVisible: true });
    advance(VIEW_GRACE_MS - 1);
    expect(views.isViewed("a1")).toBe(true);
    advance(2);
    expect(views.isViewed("a1")).toBe(false);
    expect(views.isViewed("a2")).toBe(true);
  });

  test("a client that stops sending heartbeats goes stale", () => {
    const { views, advance } = tracker();
    views.noteHeartbeat("app", { agentId: "a1", appVisible: true });
    advance(VIEW_STALE_MS + 1);
    expect(views.isViewed("a1")).toBe(false);
  });

  test("a disconnected client keeps the agent viewed only for the grace window", () => {
    const { views, advance } = tracker();
    views.noteHeartbeat("app", { agentId: "a1", appVisible: true });
    views.noteGone("app");
    expect(views.isViewed("a1")).toBe(true);
    advance(VIEW_GRACE_MS + 1);
    expect(views.isViewed("a1")).toBe(false);
  });

  test("another client still viewing keeps the agent viewed", () => {
    const { views, advance } = tracker();
    views.noteHeartbeat("desktop", { agentId: "a1", appVisible: true });
    views.noteHeartbeat("phone", { agentId: "a1", appVisible: true });
    views.noteGone("phone");
    advance(VIEW_GRACE_MS + 1);
    views.noteHeartbeat("desktop", { agentId: "a1", appVisible: true });
    expect(views.isViewed("a1")).toBe(true);
  });
});
