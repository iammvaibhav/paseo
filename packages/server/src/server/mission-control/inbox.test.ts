import { describe, expect, test } from "vitest";
import type {
  MissionControlEvent,
  MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import { buildMissionControlInbox, type InboxAgentIdentity, type InboxInput } from "./inbox.js";
import { EMPTY_REVIEW_STATE, type MissionControlReviewStateRecord } from "./store.js";

let seq = 0;

function event(
  agentId: string,
  kind: MissionControlEvent["kind"],
  ts: string,
  extra: Partial<MissionControlEvent> = {},
): MissionControlEvent {
  seq += 1;
  return {
    id: `mce_${seq}`,
    seq,
    ts,
    agentId,
    agentTitle: agentId,
    kind,
    source: "system",
    severity: "info",
    headline: kind,
    runEpoch: 1,
    ...extra,
  };
}

function proposal(id: string, extra: Partial<MissionControlProposal> = {}): MissionControlProposal {
  return {
    id,
    createdAt: "2026-09-30T10:00:00.000Z",
    origin: "verifier",
    serverId: "srv_local",
    targetAgentId: "worker-1",
    message: "send the proof",
    deliveryMode: "steer",
    reason: "Verifier proof demand",
    classification: "normal",
    status: "pending",
    ...extra,
  };
}

function ready(updatedAt: string): MissionControlReviewStateRecord {
  return { ...EMPTY_REVIEW_STATE, reviewState: "ready", updatedAt };
}

function worker(labels: Record<string, string> = {}): InboxAgentIdentity {
  return { labels, internal: false, archived: false };
}

function input(overrides: Partial<InboxInput>): InboxInput {
  return {
    proposals: [],
    events: [],
    reviewStates: new Map(),
    agents: new Map(),
    localCommander: null,
    fleetCommanderAgentId: "commander-1",
    ...overrides,
  };
}

const screenshot = { kind: "image" as const, path: "/tmp/proof.png" };
const testRun = { kind: "command" as const, excerpt: "12 passed" };

describe("mission control inbox: pending proposals", () => {
  test("returns only pending, non-verbose proposals, oldest first", () => {
    const inbox = buildMissionControlInbox(
      input({
        proposals: [
          proposal("mcp_3", { createdAt: "2026-09-30T10:03:00.000Z" }),
          proposal("mcp_1", { createdAt: "2026-09-30T10:01:00.000Z" }),
          proposal("mcp_sent", { status: "sent" }),
          proposal("mcp_denied", { status: "denied" }),
          proposal("mcp_nudge", { verboseOnly: true, origin: "stall" }),
        ],
      }),
    );
    expect(inbox.pendingProposals.map((row) => row.id)).toEqual(["mcp_1", "mcp_3"]);
  });
});

describe("mission control inbox: open clarifications", () => {
  const clarification = {
    question: "Which host?",
    options: ["macbook", "blrofc3"],
    allowFreeText: true,
  };

  test("keeps the Commander's clarifications newer than its last user message", () => {
    const events = [
      event("commander-1", "clarification", "2026-09-30T10:00:00.000Z", {
        id: "answered",
        clarification,
      }),
      event("commander-1", "clarification", "2026-09-30T10:10:00.000Z", {
        id: "open",
        clarification,
      }),
      event("worker-1", "clarification", "2026-09-30T10:11:00.000Z", {
        id: "not-commander",
        clarification,
      }),
      event("commander-1", "answer", "2026-09-30T10:12:00.000Z", { id: "answer" }),
    ];
    const inbox = buildMissionControlInbox(
      input({
        events,
        localCommander: {
          agentId: "commander-1",
          lastUserMessageAt: "2026-09-30T10:05:00.000Z",
        },
      }),
    );
    expect(inbox.openClarifications.map((row) => row.id)).toEqual(["open"]);
  });

  test("every clarification is open before the user ever messaged the Commander", () => {
    const events = [
      event("commander-1", "clarification", "2026-09-30T10:00:00.000Z", { clarification }),
    ];
    const inbox = buildMissionControlInbox(
      input({ events, localCommander: { agentId: "commander-1", lastUserMessageAt: null } }),
    );
    expect(inbox.openClarifications).toHaveLength(1);
  });

  test("a host without a local Commander returns none", () => {
    const events = [
      event("commander-1", "clarification", "2026-09-30T10:00:00.000Z", { clarification }),
    ];
    expect(buildMissionControlInbox(input({ events })).openClarifications).toEqual([]);
  });
});

describe("mission control inbox: review facts", () => {
  test("counts distinct proofs of the current run only", () => {
    const events = [
      event("worker-1", "started", "2026-09-30T09:00:00.000Z", { runEpoch: 1 }),
      event("worker-1", "milestone", "2026-09-30T09:10:00.000Z", {
        source: "self",
        runEpoch: 1,
        proof: [screenshot],
      }),
      event("worker-1", "started", "2026-09-30T10:00:00.000Z", { runEpoch: 2 }),
      event("worker-1", "milestone", "2026-09-30T10:10:00.000Z", {
        source: "self",
        runEpoch: 2,
        proof: [screenshot, testRun],
      }),
      // The run-end card coalesced over the report and inherited its proofs.
      event("worker-1", "finished", "2026-09-30T10:20:00.000Z", {
        runEpoch: 2,
        proof: [screenshot, testRun],
      }),
    ];
    const inbox = buildMissionControlInbox(
      input({
        events,
        reviewStates: new Map([["worker-1", ready("2026-09-30T10:20:01.000Z")]]),
        agents: new Map([["worker-1", worker()]]),
      }),
    );
    expect(inbox.review).toEqual([
      {
        agentId: "worker-1",
        reviewState: "ready",
        proofCount: 2,
        dispatched: false,
        readyAt: "2026-09-30T10:20:01.000Z",
      },
    ]);
  });

  test("a verdict after a daemon restart (epoch bumped, no new start) belongs to the ready run", () => {
    const events = [
      event("worker-1", "started", "2026-09-30T10:00:00.000Z", { runEpoch: 4 }),
      event("worker-1", "finished", "2026-09-30T10:20:00.000Z", {
        runEpoch: 4,
        proof: [screenshot],
      }),
      event("worker-1", "verdict", "2026-09-30T11:00:00.000Z", {
        runEpoch: 5,
        source: "verifier",
        headline: "Insufficient",
        detail: "No red run before the fix",
      }),
    ];
    const [fact] = buildMissionControlInbox(
      input({
        events,
        reviewStates: new Map([["worker-1", ready("2026-09-30T10:20:01.000Z")]]),
        agents: new Map([["worker-1", worker()]]),
      }),
    ).review;
    expect(fact?.proofCount).toBe(1);
    expect(fact?.insufficientVerdict).toEqual({
      summary: "No red run before the fix",
      at: "2026-09-30T11:00:00.000Z",
    });
  });

  test("a later state-only verdict settles an earlier insufficient one", () => {
    const events = [
      event("worker-1", "started", "2026-09-30T10:00:00.000Z"),
      event("worker-1", "verdict", "2026-09-30T10:30:00.000Z", {
        source: "verifier",
        detail: "missing proof",
      }),
      event("worker-1", "verdict", "2026-09-30T10:40:00.000Z", {
        headline: "Marked done",
        detail: "Marked done",
        stateOnly: true,
      }),
    ];
    const [fact] = buildMissionControlInbox(
      input({
        events,
        reviewStates: new Map([["worker-1", ready("2026-09-30T10:50:00.000Z")]]),
        agents: new Map([["worker-1", worker()]]),
      }),
    ).review;
    expect(fact).toBeDefined();
    expect(fact?.insufficientVerdict).toBeUndefined();
  });

  test("an insufficient verdict from a previous run does not carry over", () => {
    const events = [
      event("worker-1", "started", "2026-09-30T09:00:00.000Z"),
      event("worker-1", "verdict", "2026-09-30T09:30:00.000Z", {
        source: "verifier",
        detail: "missing proof",
      }),
      event("worker-1", "started", "2026-09-30T10:00:00.000Z"),
    ];
    const [fact] = buildMissionControlInbox(
      input({
        events,
        reviewStates: new Map([["worker-1", ready("2026-09-30T10:30:00.000Z")]]),
        agents: new Map([["worker-1", worker()]]),
      }),
    ).review;
    expect(fact?.insufficientVerdict).toBeUndefined();
  });

  test("dispatched: parent is the fleet Commander, or the Commander adopted the agent", () => {
    const reviewStates = new Map([
      ["spawned", ready("2026-09-30T10:00:00.000Z")],
      ["adopted", ready("2026-09-30T10:01:00.000Z")],
      ["subagent", ready("2026-09-30T10:02:00.000Z")],
      ["hand-started", ready("2026-09-30T10:03:00.000Z")],
    ]);
    const agents = new Map([
      ["spawned", worker({ "paseo.parent-agent-id": "commander-1" })],
      ["adopted", worker({ "paseo.commander-adopted-at": "2026-09-30T09:00:00.000Z" })],
      ["subagent", worker({ "paseo.parent-agent-id": "some-other-agent" })],
      ["hand-started", worker()],
    ]);
    const dispatchedById = (fleetCommanderAgentId: string | null) =>
      Object.fromEntries(
        buildMissionControlInbox(input({ reviewStates, agents, fleetCommanderAgentId })).review.map(
          (fact) => [fact.agentId, fact.dispatched],
        ),
      );
    expect(dispatchedById("commander-1")).toEqual({
      spawned: true,
      adopted: true,
      subagent: false,
      "hand-started": false,
    });
    // Commander unresolvable (peer host, commander host asleep): only the
    // adoption label proves dispatch.
    expect(dispatchedById(null)).toEqual({
      spawned: false,
      adopted: true,
      subagent: false,
      "hand-started": false,
    });
  });

  test("returns ready rows only and excludes system-owned, archived, internal, and unknown agents", () => {
    const at = "2026-09-30T10:00:00.000Z";
    const reviewStates = new Map<string, MissionControlReviewStateRecord>([
      ["worker-1", ready(at)],
      ["done-worker", { ...EMPTY_REVIEW_STATE, reviewState: "done", updatedAt: at }],
      ["commander-1", ready(at)],
      ["verifier-1", ready(at)],
      ["build-stamp", ready(at)],
      ["archived", ready(at)],
      ["internal", ready(at)],
      ["deleted", ready(at)],
    ]);
    const agents = new Map<string, InboxAgentIdentity>([
      ["worker-1", worker()],
      ["done-worker", worker()],
      ["commander-1", worker({ "paseo.mission-control": "commander" })],
      ["verifier-1", worker({ "paseo.mission-control": "verifier" })],
      ["build-stamp", worker({ "paseo.mission-control.build-hash": "abc123" })],
      ["archived", { ...worker(), archived: true }],
      ["internal", { ...worker(), internal: true }],
    ]);
    const inbox = buildMissionControlInbox(input({ reviewStates, agents }));
    expect(inbox.review.map((fact) => fact.agentId)).toEqual(["worker-1"]);
  });
});
