/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import type { FeedCardEvent } from "./feed-card";
import {
  classifyThreadRow,
  isTagMessageTool,
  prettyDispatchToolLeaf,
  type ThreadRow,
} from "./thread-classification";

// proposal-card (imported via thread-classification) reads the toast context
// at module scope in some build shapes; keep the import graph test-safe.
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: () => {}, show: () => {}, copied: () => {} }),
}));

function event(overrides: Partial<FeedCardEvent> = {}): FeedCardEvent {
  return {
    id: "event-1",
    ts: new Date().toISOString(),
    agentId: "agent-1",
    agentTitle: "Original event title",
    kind: "failed",
    source: "self",
    severity: "attention",
    headline: "Failed",
    serverId: "server-1",
    serverLabel: "MacBook-Pro-89.local",
    ...overrides,
  };
}

function verboseOnlyStallNudge(): FeedCardEvent {
  return event({
    kind: "proposal",
    headline: "Proposal sent",
    severity: "info",
    verboseOnly: true,
    proposal: {
      id: "proposal-nudge",
      createdAt: new Date().toISOString(),
      origin: "stall",
      serverId: "server-1",
      targetAgentId: "agent-1",
      message: "You've been quiet for a while. Post a one-line report_status.",
      deliveryMode: "steer",
      reason: "No recent status",
      classification: "normal",
      status: "sent",
    },
  });
}

describe("classifyThreadRow", () => {
  it("classifies a verbose-only stall nudge as skip in normal mode and card in verbose mode", () => {
    const row: ThreadRow = { kind: "event", event: verboseOnlyStallNudge(), ts: 1_752_000_000_000 };
    // Normal mode: the machinery row renders nothing and takes no height.
    expect(classifyThreadRow(row, false)).toBe("skip");
    // Verbose flip: the same row becomes a visible card — live re-classify.
    expect(classifyThreadRow(row, true)).toBe("card");
  });

  it("classifies a blocked needs-you card in both modes", () => {
    const row: ThreadRow = {
      kind: "event",
      event: event({ kind: "blocked", severity: "blocker", headline: "Waiting for permission" }),
      ts: 1_752_000_000_000,
    };
    // Blocked is NOT in the skip list (spec 07): a blocker is a needs-you
    // card for the user and stays visible in normal mode.
    expect(classifyThreadRow(row, false)).toBe("card");
    expect(classifyThreadRow(row, true)).toBe("card");
  });

  it("skips machinery status kinds in normal mode and renders them in verbose mode", () => {
    const kinds = [
      "started",
      "finished",
      "milestone",
      "finding",
      "interrupted",
      "diverged",
      "stalled",
      "failed",
    ] as const;
    for (const kind of kinds) {
      const row: ThreadRow = { kind: "event", event: event({ kind }), ts: 1_752_000_000_000 };
      expect(classifyThreadRow(row, false)).toBe("skip");
      expect(classifyThreadRow(row, true)).toBe("card");
    }
  });

  it("skips a state-only verdict card in normal mode and renders it in verbose mode", () => {
    const row: ThreadRow = {
      kind: "event",
      event: event({ kind: "verdict", stateOnly: true, headline: "Marked done" }),
      ts: 1_752_000_000_000,
    };
    expect(classifyThreadRow(row, false)).toBe("skip");
    expect(classifyThreadRow(row, true)).toBe("card");
  });

  it("renders a verdict-insufficient card (no stateOnly stamp) in both modes", () => {
    const row: ThreadRow = {
      kind: "event",
      event: event({ kind: "verdict", headline: "Done — insufficient", detail: "proofs missing" }),
      ts: 1_752_000_000_000,
    };
    // The item stays needs-you: the card is a decision, never hidden.
    expect(classifyThreadRow(row, false)).toBe("card");
    expect(classifyThreadRow(row, true)).toBe("card");
  });

  it("renders proposals in both modes when they are not machinery stall nudges", () => {
    const row: ThreadRow = {
      kind: "event",
      event: event({
        kind: "proposal",
        severity: "blocker",
        headline: "Proposal (commander): needs your review",
        proposal: {
          id: "proposal-card",
          createdAt: new Date().toISOString(),
          origin: "commander",
          serverId: "server-1",
          targetAgentId: "agent-1",
          message: "Approve the spawn?",
          deliveryMode: "interrupt",
          reason: "Needs a decision",
          classification: "normal",
          status: "pending",
        },
      }),
      ts: 1_752_000_000_000,
    };
    expect(classifyThreadRow(row, false)).toBe("card");
    expect(classifyThreadRow(row, true)).toBe("card");
  });

  it("renders clarification and answer cards in both modes", () => {
    for (const kind of ["clarification", "answer"] as const) {
      const row: ThreadRow = {
        kind: "event",
        event: event({ kind }),
        ts: 1_752_000_000_000,
      };
      expect(classifyThreadRow(row, false)).toBe("card");
      expect(classifyThreadRow(row, true)).toBe("card");
    }
  });

  it("verbose mode renders every event kind", () => {
    const kinds = [
      "started",
      "finished",
      "failed",
      "blocked",
      "stalled",
      "milestone",
      "finding",
      "diverged",
      "proposal",
      "verdict",
      "interrupted",
      "clarification",
      "answer",
    ] as const;
    for (const kind of kinds) {
      const row: ThreadRow = { kind: "event", event: event({ kind }), ts: 1_752_000_000_000 };
      expect(classifyThreadRow(row, true)).toBe("card");
    }
  });

  it("classifies commander rows (messages, tool calls) as gap in both modes", () => {
    const commanderRow: ThreadRow = {
      kind: "commander",
      item: { id: "cmd-1", kind: "assistant_message", timestamp: new Date(), text: "working" },
      ts: 1_752_000_000_000,
    };
    expect(classifyThreadRow(commanderRow, false)).toBe("gap");
    expect(classifyThreadRow(commanderRow, true)).toBe("gap");
  });
});

describe("pretty dispatch tool gating (normal-mode thread visibility)", () => {
  it("keeps fleet_create_agent a pretty dispatch (normal mode shows it)", () => {
    expect(prettyDispatchToolLeaf("fleet_create_agent")).toBe("fleet_create_agent");
    expect(prettyDispatchToolLeaf("mcp__paseo__fleet_create_agent")).toBe("fleet_create_agent");
    expect(prettyDispatchToolLeaf("paseo.fleet_create_agent")).toBe("fleet_create_agent");
  });

  it("treats the other fleet dispatch tools as pretty", () => {
    expect(prettyDispatchToolLeaf("fleet_send_prompt")).toBe("fleet_send_prompt");
    expect(prettyDispatchToolLeaf("fleet_list_agents")).toBe("fleet_list_agents");
    expect(prettyDispatchToolLeaf("fleet_search")).toBe("fleet_search");
  });

  it("treats create_agent (the local subagent spawn) as machinery: verbose-only", () => {
    // A subagent spawn row is machinery even though it renders pretty
    // ("Spawned …") in verbose — normal mode must gate it out.
    expect(prettyDispatchToolLeaf("create_agent")).toBeNull();
    expect(prettyDispatchToolLeaf("paseo.create_agent")).toBeNull();
  });

  it("keeps omp task/subagent spawns and tag_message verbose-only", () => {
    expect(prettyDispatchToolLeaf("task")).toBeNull();
    expect(prettyDispatchToolLeaf("subagent")).toBeNull();
    expect(prettyDispatchToolLeaf("tag_message")).toBeNull();
    expect(isTagMessageTool("tag_message")).toBe(true);
    expect(isTagMessageTool("paseo.tag_message")).toBe(true);
  });
});
