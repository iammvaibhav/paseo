import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type {
  MissionControlEvent,
  MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import {
  DEFAULT_RETENTION_DAYS,
  countLifecycle,
  deriveAgentLifecycle,
  groupLifecycleRows,
  lifecycleRowVisible,
  parseVerdictEvent,
} from "./lifecycle";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = DEFAULT_RETENTION_DAYS * DAY_MS;

function makeAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id: "agent-1",
    serverId: "server-1",
    serverLabel: "work server",
    title: null,
    name: null,
    status: "idle",
    lastActivityAt: new Date(NOW - 60_000),
    cwd: "~",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: new Date(NOW - DAY_MS),
    labels: {},
    projectPlacement: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<MissionControlEvent>): MissionControlEvent {
  return {
    id: `mce_${overrides.kind ?? "x"}`,
    ts: new Date(NOW - 60_000).toISOString(),
    agentId: "agent-1",
    agentTitle: "Agent",
    kind: "milestone",
    source: "self",
    severity: "info",
    headline: "Working",
    ...overrides,
  };
}

function makeProposalEvent(
  eventOverrides: Partial<MissionControlEvent> = {},
  proposalOverrides: Partial<MissionControlProposal> = {},
): MissionControlEvent {
  return makeEvent({
    kind: "proposal",
    source: "system",
    severity: "blocker",
    proposal: {
      id: "mcp_1",
      createdAt: new Date(NOW - 60_000).toISOString(),
      origin: "verifier",
      serverId: "server-1",
      targetAgentId: "agent-1",
      message: "Show your proof",
      deliveryMode: "steer",
      reason: "Proof demand",
      classification: "normal",
      status: "pending",
      ...proposalOverrides,
    },
    ...eventOverrides,
  });
}

function derive(agent: AggregatedAgent, events: MissionControlEvent[]) {
  return deriveAgentLifecycle({ agent, events, now: NOW, retentionMs: RETENTION_MS });
}

describe("parseVerdictEvent", () => {
  it("parses a verifier done verdict", () => {
    const parsed = parseVerdictEvent(
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — proofs match the brief",
        detail: "proofs match the brief",
      }),
    );
    expect(parsed).toEqual({
      reviewState: "done",
      verdict: { by: "verifier", summary: "proofs match the brief", at: expect.any(String) },
    });
  });

  it("falls back to the headline when a verifier verdict has no detail", () => {
    const parsed = parseVerdictEvent(
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — checked against the brief",
      }),
    );
    expect(parsed?.verdict.summary).toBe("checked against the brief");
  });

  it("parses a user 'Marked done' verdict", () => {
    const parsed = parseVerdictEvent(
      makeEvent({ kind: "verdict", source: "system", headline: "Marked done" }),
    );
    expect(parsed).toMatchObject({ reviewState: "done", verdict: { by: "user" } });
  });

  it("parses a user 'Cleared' verdict", () => {
    const parsed = parseVerdictEvent(
      makeEvent({ kind: "verdict", source: "system", headline: "Cleared", detail: "Cleared" }),
    );
    expect(parsed).toMatchObject({ reviewState: "cleared", verdict: { by: "user" } });
  });

  it("returns null for non-verdict events", () => {
    expect(
      parseVerdictEvent(makeEvent({ kind: "started", headline: "Started running" })),
    ).toBeNull();
  });
});

describe("deriveAgentLifecycle — review state fold", () => {
  it("starts dormant for an idle agent with no events", () => {
    const state = derive(makeAgent(), []);
    expect(state).toMatchObject({ bucket: "dormant", reviewState: "none", dormant: true });
  });

  it("moves an agent to ready on a finished run", () => {
    const state = derive(makeAgent(), [makeEvent({ kind: "finished", headline: "Finished" })]);
    expect(state).toMatchObject({ bucket: "ready", reviewState: "ready" });
  });

  it("moves a done agent back to running when it starts a new run", () => {
    const done = derive(makeAgent(), [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — looks good",
        detail: "looks good",
      }),
    ]);
    expect(done.bucket).toBe("done");

    const reopened = derive(makeAgent({ status: "running" }), [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — looks good",
        detail: "looks good",
      }),
      makeEvent({ kind: "started", headline: "Started running" }),
    ]);
    expect(reopened).toMatchObject({ bucket: "running", reviewState: "none", verdict: null });
  });

  it("keeps the newest verdict as the row's verdict", () => {
    const state = derive(makeAgent(), [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — insufficient proof",
        detail: "insufficient proof",
      }),
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — proof supplied",
        detail: "proof supplied",
      }),
    ]);
    expect(state).toMatchObject({ bucket: "done", verdict: { summary: "proof supplied" } });
  });

  it("treats a cleared agent as out of the lifecycle (hidden unless toggled)", () => {
    const state = derive(makeAgent(), [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({ kind: "verdict", source: "system", headline: "Marked done" }),
      makeEvent({ kind: "verdict", source: "system", headline: "Cleared", detail: "Cleared" }),
    ]);
    expect(state).toMatchObject({ bucket: "dormant", reviewState: "cleared" });
  });

  it("reports the latest non-proposal headline as the row one-liner", () => {
    const state = derive(makeAgent(), [
      makeEvent({ kind: "milestone", headline: "Root cause found" }),
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeProposalEvent(
        { headline: "Proposal (stall): nudge", source: "system" },
        { origin: "stall" },
      ),
    ]);
    expect(state.lastReportHeadline).toBe("Finished");
  });
});

describe("deriveAgentLifecycle — buckets", () => {
  it("puts permission-blocked agents in needs_you even while running", () => {
    const state = derive(makeAgent({ status: "running", pendingPermissionCount: 1 }), [
      makeEvent({ kind: "started", headline: "Started running" }),
    ]);
    expect(state.bucket).toBe("needs_you");
  });

  it("puts failed agents in needs_you", () => {
    const state = derive(makeAgent({ status: "error" }), [
      makeEvent({ kind: "failed", headline: "Failed with an error" }),
    ]);
    expect(state.bucket).toBe("needs_you");
  });

  it("puts agents with a pending proposal in needs_you", () => {
    const state = derive(makeAgent(), [
      makeProposalEvent({ headline: "Proposal (verifier): proof demand", source: "verifier" }),
    ]);
    expect(state.bucket).toBe("needs_you");
    expect(state.pendingProposalCount).toBe(1);
  });

  it("ignores expired/denied proposals for the needs_you bucket", () => {
    const state = derive(makeAgent(), [
      makeProposalEvent({ headline: "Proposal expired" }, { status: "expired" }),
    ]);
    expect(state.pendingProposalCount).toBe(0);
    expect(state.bucket).toBe("dormant");
  });

  it("keeps running agents in running", () => {
    const state = derive(makeAgent({ status: "running" }), [
      makeEvent({ kind: "started", headline: "Started running" }),
    ]);
    expect(state.bucket).toBe("running");
  });

  it("keeps initializing agents in running", () => {
    const state = derive(makeAgent({ status: "initializing" }), []);
    expect(state.bucket).toBe("running");
  });

  it("keeps a done agent in done even when its attention still reads finished", () => {
    // The daemon does not clear requiresAttention on a verdict; the verdict
    // card must outrank the stale finished attention.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "system",
        headline: "Marked done",
        detail: "Marked done",
      }),
    ]);
    expect(state.bucket).toBe("done");
  });

  it("keeps finished-attention agents dormant without a recorded reviewState (pre-rollout)", () => {
    // Spec: Ready for review accrues only from rollout onward — a finished
    // attention flag alone (no finished event, no reviewState) is pre-rollout
    // history and must not flood the Ready bucket.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), []);
    expect(state.bucket).toBe("dormant");
  });
});

describe("visibility window", () => {
  it("hides dormant rows by default and shows them under the toggle", () => {
    const row = derive(makeAgent(), []);
    expect(lifecycleRowVisible(row, false)).toBe(false);
    expect(lifecycleRowVisible(row, true)).toBe(true);
  });

  it("hides out-of-window done rows by default, reveals them under the toggle", () => {
    const agent = makeAgent({ lastActivityAt: new Date(NOW - 40 * DAY_MS) });
    const row = derive(agent, [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "system",
        headline: "Marked done",
        detail: "Marked done",
      }),
    ]);
    expect(row.withinWindow).toBe(false);
    expect(lifecycleRowVisible(row, false)).toBe(false);
    expect(lifecycleRowVisible(row, true)).toBe(true);
  });

  it("keeps in-window done rows visible", () => {
    const agent = makeAgent({ lastActivityAt: new Date(NOW - 5 * DAY_MS) });
    const row = derive(agent, [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "system",
        headline: "Marked done",
        detail: "Marked done",
      }),
    ]);
    expect(row.withinWindow).toBe(true);
    expect(lifecycleRowVisible(row, false)).toBe(true);
  });
});

describe("groupLifecycleRows", () => {
  it("sorts running rows by name ascending and ready/done by time descending", () => {
    const mkAgent = (id: string, name: string, status: string, activityAgoMs: number) =>
      makeAgent({
        id,
        name,
        title: `Title ${name}`,
        status: status as AggregatedAgent["status"],
        lastActivityAt: new Date(NOW - activityAgoMs),
      });
    const running = [
      {
        agent: mkAgent("a", "zeta", "running", 1000),
        ...derive(mkAgent("a", "zeta", "running", 1000), []),
      },
      {
        agent: mkAgent("b", "alpha", "running", 50_000),
        ...derive(mkAgent("b", "alpha", "running", 50_000), []),
      },
    ].map((row) => Object.assign({}, row, { sortTime: 0 }));
    const ready = [
      {
        agent: mkAgent("c", "one", "idle", 10_000),
        ...derive(mkAgent("c", "one", "idle", 10_000), [
          makeEvent({ kind: "finished", headline: "Finished" }),
        ]),
      },
      {
        agent: mkAgent("d", "two", "idle", 100_000),
        ...derive(mkAgent("d", "two", "idle", 100_000), [
          makeEvent({ kind: "finished", headline: "Finished" }),
        ]),
      },
    ].map((row, i) => Object.assign({}, row, { sortTime: i === 0 ? 2000 : 1000 }));

    const groups = groupLifecycleRows([...ready, ...running], false);
    const runningGroup = groups.find((group) => group.bucket === "running");
    const readyGroup = groups.find((group) => group.bucket === "ready");
    expect(runningGroup?.rows.map((row) => row.agent.name)).toEqual(["alpha", "zeta"]);
    expect(readyGroup?.rows.map((row) => row.agent.name)).toEqual(["one", "two"]);
  });

  it("omits dormant rows unless showAll", () => {
    const dormant = makeAgent();
    const dormantRow = { ...derive(dormant, []), agent: dormant, sortTime: 0 };
    expect(groupLifecycleRows([dormantRow], false)).toEqual([]);
    expect(groupLifecycleRows([dormantRow], true).map((group) => group.bucket)).toEqual([
      "dormant",
    ]);
  });

  it("counts working and ready agents", () => {
    const working = makeAgent({ id: "w", status: "running" });
    const ready = makeAgent({ id: "r", requiresAttention: true, attentionReason: "finished" });
    const done = makeAgent({ id: "d" });
    const counts = countLifecycle([
      { ...derive(working, []), agent: working, sortTime: 0 },
      {
        ...derive(ready, [makeEvent({ kind: "finished", headline: "Finished" })]),
        agent: ready,
        sortTime: 0,
      },
      {
        ...derive(done, [
          makeEvent({
            kind: "verdict",
            source: "system",
            headline: "Marked done",
            detail: "Marked done",
          }),
        ]),
        agent: done,
        sortTime: 0,
      },
    ]);
    expect(counts).toEqual({ needsYou: 0, working: 1, ready: 1, done: 1 });
  });
});
