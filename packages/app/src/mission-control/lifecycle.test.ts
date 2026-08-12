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
  rowActivityMs,
  sortLifecycleRows,
  toLifecycleRow,
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
    lastUserMessageAt: null,
    cwd: "~",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    stoppedBy: null,
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

describe("deriveAgentLifecycle — emit-time identity snapshots", () => {
  it("snapshots the newest event's title as the recorded identity", () => {
    // The board's Done/Ready/Dormant rows render this snapshot, never the
    // live directory title (which the daemon may rewrite later).
    const state = derive(makeAgent({ title: "Live rewritten title" }), [
      makeEvent({ kind: "started", headline: "Started running", agentTitle: "Old title" }),
      makeEvent({ kind: "finished", headline: "Finished", agentTitle: "Terminal title" }),
    ]);
    expect(state).toMatchObject({
      bucket: "ready",
      snapshotTitle: "Terminal title",
    });
  });

  it("snapshots the newest shortDescription that an event carried", () => {
    const state = derive(makeAgent({ shortDescription: "live description" }), [
      makeEvent({
        kind: "started",
        headline: "Started running",
        shortDescription: "First brief",
      }),
      makeEvent({
        kind: "finished",
        headline: "Finished",
        shortDescription: "Final brief",
      }),
    ]);
    expect(state.snapshotShortDescription).toBe("Final brief");
  });

  it("keeps the last known shortDescription when a later event carries none", () => {
    const state = derive(makeAgent(), [
      makeEvent({
        kind: "milestone",
        headline: "Progress",
        shortDescription: "Known brief",
      }),
      makeEvent({ kind: "finished", headline: "Finished" }),
    ]);
    expect(state.snapshotShortDescription).toBe("Known brief");
  });

  it("snapshots the last run's stop origin from its terminal event", () => {
    const state = derive(makeAgent(), [
      makeEvent({ kind: "started", headline: "Started running" }),
      makeEvent({ kind: "interrupted", headline: "Interrupted by you", stoppedBy: "user" }),
    ]);
    expect(state.snapshotStoppedBy).toBe("user");
  });

  it("resets the stop-origin snapshot when a new run starts", () => {
    // The daemon clears the origin before the started card; a later run must
    // not inherit the previous run's stop.
    const state = derive(makeAgent(), [
      makeEvent({ kind: "interrupted", headline: "Interrupted by you", stoppedBy: "user" }),
      makeEvent({ kind: "started", headline: "Started running" }),
    ]);
    expect(state.snapshotStoppedBy).toBeNull();
  });

  it("leaves all snapshots null for agents with no events (pre-rollout dormant)", () => {
    const state = derive(makeAgent({ title: "live title" }), []);
    expect(state).toMatchObject({
      snapshotTitle: null,
      snapshotShortDescription: null,
      snapshotStoppedBy: null,
    });
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

  it("puts idle agents with a pending proposal in needs_you", () => {
    const state = derive(makeAgent(), [
      makeProposalEvent({ headline: "Proposal (verifier): proof demand", source: "verifier" }),
    ]);
    expect(state.bucket).toBe("needs_you");
    expect(state.pendingProposalCount).toBe(1);
  });

  it("keeps a running agent in running even with a pending stall proposal", () => {
    const state = derive(makeAgent({ status: "running" }), [
      makeEvent({ kind: "started", headline: "Started running" }),
      makeProposalEvent({ headline: "Proposal (stall): recovery", source: "system" }),
    ]);
    expect(state.bucket).toBe("running");
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

describe("deriveAgentLifecycle — user-stopped ≠ Needs you", () => {
  it("lands a user-stopped agent in done with the stopped-by-user marker", () => {
    // Live bug: a user-pressed Stop landed the row in Needs-you. The stop
    // origin rides the run's terminal event snapshot (stoppedBy: "user"),
    // so the derivation can tell a user stop from a normal finish without
    // reading the live directory stoppedBy.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "started", headline: "Started running" }),
      makeEvent({ kind: "interrupted", headline: "Interrupted by you", stoppedBy: "user" }),
    ]);
    expect(state).toMatchObject({
      bucket: "done",
      doneReason: "stopped-by-user",
      reviewState: "none",
    });
  });

  it("falls back to the live stoppedBy for a user-stopped agent with no events", () => {
    // Excluded/untracked history: a stopped Commander worker (parent label)
    // never produced MC events, so no event snapshot carries stoppedBy. The
    // live directory stoppedBy (the MC store's stop origin) is the only
    // record of the stop — without it the row would read Needs you forever.
    const state = derive(
      makeAgent({ status: "error", attentionReason: "finished", stoppedBy: "user" }),
      [],
    );
    expect(state).toMatchObject({
      bucket: "done",
      doneReason: "stopped-by-user",
      reviewState: "none",
    });
  });

  it("keeps an event-less, never-stopped error agent in needs_you", () => {
    const state = derive(makeAgent({ status: "error", stoppedBy: null }), []);
    expect(state).toMatchObject({ bucket: "needs_you", doneReason: null });
  });

  it("keeps an event-less, never-stopped idle agent dormant", () => {
    const state = derive(makeAgent({ stoppedBy: null }), []);
    expect(state).toMatchObject({ bucket: "dormant", doneReason: null });
  });

  it("makes a user stop outrank pending proposals and finished attention", () => {
    // The live Needs-you manifestation: after the stop the attention still
    // reads finished and/or a proposal card is pending. The user performed the
    // stop — nothing needs them.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeProposalEvent({
        headline: "Proposal (verifier): proof demand",
        source: "verifier",
        stoppedBy: "user",
      }),
    ]);
    expect(state).toMatchObject({ bucket: "done", doneReason: "stopped-by-user" });
  });

  it("prevents stopped-by-user chip from coexisting with a terminal Finished reviewState", () => {
    // When the agent finished (reviewState "ready"), the ready-for-review
    // semantics take precedence and the stopped-by-user chip is omitted.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "started", headline: "Started running" }),
      makeEvent({ kind: "finished", headline: "Finished", stoppedBy: "user" }),
    ]);
    expect(state).toMatchObject({
      bucket: "ready",
      doneReason: null,
      reviewState: "ready",
    });
  });

  it("keeps machinery stops on the attention path (error → needs_you)", () => {
    const state = derive(makeAgent({ status: "error", attentionReason: "error" }), [
      makeEvent({ kind: "failed", headline: "Failed with an error", stoppedBy: "machinery" }),
    ]);
    expect(state).toMatchObject({ bucket: "needs_you", doneReason: null });
  });

  it("lands abruptly-killed (system origin) agents in needs_you, not done", () => {
    const state = derive(makeAgent({ status: "error", attentionReason: "error" }), [
      makeEvent({ kind: "failed", headline: "Failed with an error", stoppedBy: "system" }),
    ]);
    expect(state).toMatchObject({ bucket: "needs_you", doneReason: null });
  });

  it("keeps a machinery stop with finished attention on the ready path", () => {
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "finished", headline: "Finished", stoppedBy: "machinery" }),
    ]);
    expect(state).toMatchObject({ bucket: "ready", doneReason: null });
  });

  it("returns a user-stopped agent to running when a new run starts (reopen)", () => {
    const state = derive(makeAgent({ status: "running" }), [
      makeEvent({ kind: "started", headline: "Started running" }),
      makeEvent({ kind: "finished", headline: "Finished", stoppedBy: "user" }),
      makeEvent({ kind: "started", headline: "Started running" }),
    ]);
    expect(state).toMatchObject({ bucket: "running", doneReason: null, reviewState: "none" });
  });

  it("does not re-derive done after the user-stopped row is cleared", () => {
    // Clear is bookkeeping on the server; the stop origin snapshot itself is
    // not cleared there, so the cleared reviewState must outrank the marker.
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "finished", headline: "Finished", stoppedBy: "user" }),
      makeEvent({ kind: "verdict", source: "system", headline: "Cleared", detail: "Cleared" }),
    ]);
    expect(state).toMatchObject({ bucket: "dormant", doneReason: null, reviewState: "cleared" });
  });

  it("keeps verdict-done semantics when a verdict lands after a user stop", () => {
    const state = derive(makeAgent({ requiresAttention: true, attentionReason: "finished" }), [
      makeEvent({ kind: "finished", headline: "Finished", stoppedBy: "user" }),
      makeEvent({
        kind: "verdict",
        source: "verifier",
        headline: "Done — looks good",
        detail: "looks good",
      }),
    ]);
    expect(state).toMatchObject({ bucket: "done", doneReason: null });
    expect(state.verdict?.by).toBe("verifier");
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

  it("sorts dormant rows newest-first by real activity, not by the shared boot stamp", () => {
    // Three idle agents share the SAME boot-stamped directory lastActivityAt
    // (7h ago) but have varied real last user messages. sortTime must come
    // from the real activity, so the order is by message recency — a
    // name-sorted or stamp-sorted list would be alphabetical (Alto, Basil,
    // Cedar) or all-equal.
    const mkDormant = (id: string, name: string, lastUserMessageAgoMs: number) => {
      const agent = makeAgent({
        id,
        name,
        lastActivityAt: new Date(NOW - 7 * 60 * 60 * 1000),
        lastUserMessageAt: new Date(NOW - lastUserMessageAgoMs),
      });
      return toLifecycleRow(agent, derive(agent, []));
    };
    const rows = [
      mkDormant("cedar", "Cedar", 30 * DAY_MS),
      mkDormant("alto", "Alto", 2 * DAY_MS),
      mkDormant("basil", "Basil", 12 * DAY_MS),
    ];
    expect(sortLifecycleRows("dormant", rows).map((row) => row.agent.name)).toEqual([
      "Alto",
      "Basil",
      "Cedar",
    ]);
    expect(rows.map((row) => row.sortTime)).toEqual([
      NOW - 2 * DAY_MS,
      NOW - 12 * DAY_MS,
      NOW - 30 * DAY_MS,
    ]);
  });

  it("sorts dormant rows with only a mission-control event by that event, newest first", () => {
    const mkDormant = (id: string, name: string, eventAgoMs: number) => {
      const agent = makeAgent({ id, name, lastUserMessageAt: null });
      const state = derive(agent, [makeEvent({ ts: new Date(NOW - eventAgoMs).toISOString() })]);
      const row = toLifecycleRow(agent, state);
      return row;
    };
    const rows = [mkDormant("a", "Older", 20 * DAY_MS), mkDormant("b", "Newer", 3 * DAY_MS)];
    expect(sortLifecycleRows("dormant", rows).map((row) => row.agent.name)).toEqual([
      "Newer",
      "Older",
    ]);
  });

  it("sorts needs_you rows by time descending like the other review buckets", () => {
    const mkNeedsYou = (id: string, name: string, attentionAgoMs: number) => {
      const agent = makeAgent({
        id,
        name,
        status: "idle",
        requiresAttention: true,
        attentionReason: "permission",
      });
      const state = derive(agent, [
        makeEvent({ kind: "milestone", ts: new Date(NOW - attentionAgoMs).toISOString() }),
      ]);
      expect(state.bucket).toBe("needs_you");
      return toLifecycleRow(agent, state);
    };
    const rows = [mkNeedsYou("a", "Older", 40 * 60_000), mkNeedsYou("b", "Newer", 5 * 60_000)];
    expect(sortLifecycleRows("needs_you", rows).map((row) => row.agent.name)).toEqual([
      "Newer",
      "Older",
    ]);
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

describe("rowActivityMs", () => {
  it("uses the newest mission-control event for dormant rows, not the directory boot fallback", () => {
    // Dormant agent whose directory lastActivityAt is a shared rollout/boot
    // value (18m ago) but whose last real activity was a day earlier.
    const dormant = makeAgent({ lastActivityAt: new Date(NOW - 18 * 60_000) });
    const state = derive(dormant, []);
    const row = {
      ...state,
      agent: dormant,
      sortTime: 0,
      lastEventAt: NOW - DAY_MS,
    };
    expect(rowActivityMs(row)).toBe(NOW - DAY_MS);
  });

  it("uses the last user message as the floor for dormant rows without events, never the shared boot stamp", () => {
    // Pre-rollout dormant agents have NO mission-control events, and the
    // directory lastActivityAt is a shared boot/restore stamp (7h ago for
    // every idle agent). The real last activity is the user message, weeks
    // old and varied across agents.
    const dormant = makeAgent({
      lastActivityAt: new Date(NOW - 7 * 60 * 60 * 1000),
      lastUserMessageAt: new Date(NOW - 21 * DAY_MS),
    });
    const state = derive(dormant, []);
    const row = { ...state, agent: dormant, sortTime: 0, lastEventAt: null };
    expect(rowActivityMs(row)).toBe(NOW - 21 * DAY_MS);
  });

  it("prefers the newest of the mission-control event and the last user message for dormant rows", () => {
    // Event newer than the message: the event wins.
    const withEvent = makeAgent({
      lastActivityAt: new Date(NOW - 18 * 60_000),
      lastUserMessageAt: new Date(NOW - 3 * DAY_MS),
    });
    const eventRow = {
      ...derive(withEvent, []),
      agent: withEvent,
      sortTime: 0,
      lastEventAt: NOW - DAY_MS,
    };
    expect(rowActivityMs(eventRow)).toBe(NOW - DAY_MS);

    // Message newer than the event (user asked something after the agent's
    // last self-reported activity): the message is the real last activity.
    const withMessage = makeAgent({
      lastActivityAt: new Date(NOW - 18 * 60_000),
      lastUserMessageAt: new Date(NOW - 2 * 60_000),
    });
    const messageRow = {
      ...derive(withMessage, []),
      agent: withMessage,
      sortTime: 0,
      lastEventAt: NOW - DAY_MS,
    };
    expect(rowActivityMs(messageRow)).toBe(NOW - 2 * 60_000);
  });

  it("renders no age (null) for a dormant row with no trustworthy timestamp", () => {
    // No events, no user message: the directory stamp is all we have, and it
    // is a shared boot value — a fabricated age is worse than none.
    const dormant = makeAgent({
      lastActivityAt: new Date(NOW - 7 * 60 * 60 * 1000),
      lastUserMessageAt: null,
    });
    const state = derive(dormant, []);
    const row = { ...state, agent: dormant, sortTime: 0, lastEventAt: null };
    expect(rowActivityMs(row)).toBeNull();
  });

  it("keeps the live directory timestamp for non-dormant rows (ticks while running)", () => {
    const running = makeAgent({ status: "running", lastActivityAt: new Date(NOW - 5_000) });
    const state = derive(running, []);
    const row = {
      ...state,
      agent: running,
      sortTime: 0,
      // A running agent's last event is older than its live activity.
      lastEventAt: NOW - 60_000,
    };
    expect(rowActivityMs(row)).toBe(NOW - 5_000);
  });

  it("uses the newest mission-control event for done rows, never the boot-rewritten directory stamp", () => {
    // Done row whose directory lastActivityAt is a shared restore value (18m
    // ago) but whose verdict card — the real "when it ended" — is older.
    const done = makeAgent({ lastActivityAt: new Date(NOW - 18 * 60_000) });
    const state = derive(done, [
      makeEvent({ kind: "finished", headline: "Finished" }),
      makeEvent({
        kind: "verdict",
        source: "system",
        headline: "Marked done",
        detail: "Marked done",
      }),
    ]);
    const row = { ...state, agent: done, sortTime: 0, lastEventAt: NOW - DAY_MS };
    expect(rowActivityMs(row)).toBe(NOW - DAY_MS);
  });

  it("uses the newest mission-control event for ready rows (verdict time included)", () => {
    // Ready rows are history too: the finish card is the last real activity,
    // not the directory stamp rewritten at boot/restore.
    const ready = makeAgent({ lastActivityAt: new Date(NOW - 5_000) });
    const state = derive(ready, [
      makeEvent({
        kind: "finished",
        headline: "Finished",
        ts: new Date(NOW - 2 * DAY_MS).toISOString(),
      }),
    ]);
    const row = { ...state, agent: ready, sortTime: 0, lastEventAt: NOW - 2 * DAY_MS };
    expect(rowActivityMs(row)).toBe(NOW - 2 * DAY_MS);
  });

  it("renders no age (null) for a done row with no event evidence", () => {
    const done = makeAgent({ lastActivityAt: new Date(NOW - 18 * 60_000) });
    const state = derive(done, []);
    const row = {
      ...state,
      agent: done,
      sortTime: 0,
      lastEventAt: null,
      bucket: "done" as const,
    };
    expect(rowActivityMs(row)).toBeNull();
  });
});
