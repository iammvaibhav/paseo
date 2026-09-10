// Commander Voice — fleet_monitor announce-policy unit tests (spec 03).
// Drives DaemonConnection.handleEvent directly (no daemon needed: the client
// only connects on connect()) and the fleet_agent_status / fleet_monitor
// executors with a canned catalog. Run: node --test test/monitor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DaemonConnection } from "../lib/daemon.js";
import { executeTool } from "../lib/tools.js";

function makeDaemon() {
  const daemon = new DaemonConnection({
    url: "ws://127.0.0.1:1/ws",
    password: "pw",
    appVersion: "0.0.0-test",
    clientId: "monitor-test",
    updateBufferCap: 64,
  });
  daemon.buffer = [];
  daemon.correlatedAgentIds = new Set();
  daemon.correlatedProposalIds = new Set();
  daemon.monitoredAgents = new Set();
  daemon.fleetMonitored = false;
  const announced = [];
  daemon.onAnnounce = (announcedEvent) => {
    announced.push(announcedEvent);
    return false; // no live session → the entry buffers
  };
  return { daemon, announced };
}

function event(overrides) {
  return {
    id: "mce_1",
    ts: "2026-08-16T10:00:00.000Z",
    agentId: "agent-1",
    agentTitle: "Auth refactor",
    kind: "finished",
    source: "system",
    severity: "info",
    headline: "Finished",
    ...overrides,
  };
}

test("fleet_monitor start -> finish on a watched agent -> exactly one announce entry with agentId", () => {
  const { daemon, announced } = makeDaemon();
  daemon.syncMonitorSubscriptions([{ scope: "agent", agentId: "agent-1", startedAt: "t" }]);

  daemon.handleEvent(event({ id: "mce_fin", kind: "finished", headline: "All done" }));

  assert.equal(announced.length, 1, "the watched agent's finish is announced");
  assert.equal(announced[0].agentId, "agent-1");
  assert.equal(daemon.buffer.length, 1, "no live session -> exactly one buffered announce entry");
  assert.equal(daemon.buffer[0].agentId, "agent-1", "the buffer entry carries the agentId");
  assert.equal(daemon.buffer[0].kind, "finished");
});

test("an unmonitored agent's finish is never announced and never buffered", () => {
  const { daemon, announced } = makeDaemon();
  daemon.handleEvent(event({ id: "mce_fin", agentId: "agent-9", headline: "Finished" }));

  assert.equal(announced.length, 0, "no announce attempt for an unmonitored finish");
  assert.equal(daemon.buffer.length, 0, "no buffer entry either");
});

test("stop ends announcements: after stop, the finish is dropped", () => {
  const { daemon, announced } = makeDaemon();
  daemon.syncMonitorSubscriptions([{ scope: "agent", agentId: "agent-1", startedAt: "t" }]);
  daemon.syncMonitorSubscriptions([]); // the fleet_monitor stop response

  daemon.handleEvent(event({ id: "mce_fin", kind: "finished" }));

  assert.equal(announced.length, 0);
  assert.equal(daemon.buffer.length, 0);
});

test("a fleet-scope watch announces any agent's finish", () => {
  const { daemon, announced } = makeDaemon();
  daemon.syncMonitorSubscriptions([{ scope: "fleet", startedAt: "t" }]);

  daemon.handleEvent(event({ id: "mce_fin", agentId: "agent-42", kind: "finished" }));

  assert.equal(announced.length, 1);
  assert.equal(announced[0].agentId, "agent-42");
});

test("blocked and failed announce for a watched agent; watched-scope started/milestones never announce", () => {
  const { daemon, announced } = makeDaemon();
  daemon.syncMonitorSubscriptions([{ scope: "agent", agentId: "agent-1", startedAt: "t" }]);

  daemon.handleEvent(
    event({
      id: "mce_blocked",
      kind: "blocked",
      severity: "blocker",
      headline: "Needs permission",
    }),
  );
  daemon.handleEvent(event({ id: "mce_fail", kind: "failed", headline: "Broke" }));
  daemon.handleEvent(event({ id: "mce_start", kind: "started", headline: "Started" }));
  daemon.handleEvent(
    event({ id: "mce_mile", kind: "milestone", source: "self", headline: "Progress!" }),
  );

  assert.equal(announced.length, 2, "blocked + failed announce; started/milestone never");
  assert.deepEqual(
    announced.map((e) => e.id),
    ["mce_blocked", "mce_fail"],
  );
});

test("proposal and clarification always announce, independent of the monitor", () => {
  const { daemon, announced } = makeDaemon();

  daemon.handleEvent(
    event({
      id: "mce_prop",
      kind: "proposal",
      headline: "Proposal (stall): silent",
      proposal: { id: "mcp_1", status: "pending" },
    }),
  );
  daemon.handleEvent(
    event({
      id: "mce_clar",
      kind: "clarification",
      headline: "Which host?",
      clarification: { question: "Which host?", options: ["a"], allowFreeText: false },
    }),
  );

  assert.equal(announced.length, 2);
  assert.equal(announced[0].id, "mce_prop");
  assert.equal(announced[1].id, "mce_clar");
});

test("status lists active subscriptions and reconciles the announce engine", () => {
  const { daemon } = makeDaemon();
  daemon.syncMonitorSubscriptions([
    { scope: "agent", agentId: "agent-1", startedAt: "t" },
    { scope: "agent", agentId: "agent-2", startedAt: "t" },
    { scope: "fleet", startedAt: "t" },
  ]);
  assert.equal(daemon.monitoredAgents.has("agent-1"), true);
  assert.equal(daemon.monitoredAgents.has("agent-2"), true);
  assert.equal(daemon.fleetMonitored, true);

  // A stop of one agent watch keeps the rest.
  daemon.syncMonitorSubscriptions([
    { scope: "agent", agentId: "agent-2", startedAt: "t" },
    { scope: "fleet", startedAt: "t" },
  ]);
  assert.equal(daemon.monitoredAgents.has("agent-1"), false);
  assert.equal(daemon.monitoredAgents.has("agent-2"), true);
  assert.equal(daemon.fleetMonitored, true);
});

test("buffer entries are id-carrying: proposalId, agentId, kind, agentTitle ride the entry", () => {
  const { daemon } = makeDaemon();
  daemon.syncMonitorSubscriptions([{ scope: "agent", agentId: "agent-1", startedAt: "t" }]);
  daemon.handleEvent(
    event({
      id: "mce_fin",
      kind: "finished",
      headline: "Done",
      proposal: { id: "mcp_9", status: "sent" },
    }),
  );
  assert.equal(daemon.buffer.length, 1);
  assert.equal(daemon.buffer[0].agentId, "agent-1");
  assert.equal(daemon.buffer[0].proposalId, "mcp_9");
  assert.equal(daemon.buffer[0].kind, "finished");
  assert.equal(daemon.buffer[0].agentTitle, "Auth refactor");
});

// --- Executors (dual-channel {spoken, data}) --------------------------------

function catalogStub(payload) {
  return {
    executeCatalogTool: async () => ({
      ok: true,
      structuredContent: payload,
      content: "",
      error: null,
    }),
    syncMonitorSubscriptions: () => {},
  };
}

test("fleet_agent_status executor speaks identity + bucket + last report and returns ids in data", async () => {
  const daemon = catalogStub({
    agentId: "agent-1",
    name: "turing",
    title: "Auth refactor",
    bucket: "running",
    host: "local",
    lastReport: {
      headline: "Tests are green",
      detail: "Full suite",
      ts: "t",
      reportKind: "milestone",
    },
    fresh: false,
  });
  const result = await executeTool(
    "fleet_agent_status",
    { agentId: "agent-1" },
    { daemon, voiceMode: "relay" },
  );
  assert.equal(result.error, undefined);
  assert.match(result.spoken, /Auth refactor is running/);
  assert.match(result.spoken, /Last report: Tests are green/);
  assert.equal(result.data.agentId, "agent-1");
  assert.equal(result.data.title, "Auth refactor");
});

test("fleet_agent_status executor surfaces the fresh timeout note", async () => {
  const daemon = catalogStub({
    agentId: "agent-1",
    name: null,
    title: null,
    bucket: "idle",
    host: "local",
    lastReport: null,
    fresh: false,
    note: "No fresh report_status within 60s; showing the last known status.",
  });
  const result = await executeTool(
    "fleet_agent_status",
    { agentId: "agent-1", fresh: true },
    { daemon, voiceMode: "direct" },
  );
  assert.match(result.spoken, /No fresh report_status within 60s/);
  assert.equal(result.data.fresh, false);
});

test("fleet_monitor executor reconciles the announce engine from the daemon registry", async () => {
  const subscriptions = [
    { scope: "agent", agentId: "agent-1", startedAt: "t" },
    { scope: "fleet", startedAt: "t" },
  ];
  const daemon = {
    executeCatalogTool: async () => ({
      ok: true,
      structuredContent: { ok: true, action: "start", subscriptions },
      content: "",
      error: null,
    }),
    syncMonitorSubscriptions: (subs) => {
      daemon.synced = subs;
    },
  };
  const result = await executeTool(
    "fleet_monitor",
    { action: "start", scope: "agent", agentId: "agent-1" },
    { daemon, voiceMode: "relay" },
  );
  assert.equal(result.error, undefined);
  assert.match(result.spoken, /Now monitoring agent/);
  assert.equal(daemon.synced, subscriptions, "executor reconciles the local announce engine");
  assert.deepEqual(result.data.subscriptions, subscriptions, "ids ride data, never speech");
});

test("fleet_monitor status with no subscriptions says so", async () => {
  const daemon = catalogStub({ ok: true, action: "status", subscriptions: [] });
  const result = await executeTool(
    "fleet_monitor",
    { action: "status", scope: "fleet" },
    { daemon, voiceMode: "relay" },
  );
  assert.equal(result.spoken, "You are not monitoring anything right now.");
});

test("fleet_monitor requires action and scope", async () => {
  const daemon = catalogStub({});
  const result = await executeTool(
    "fleet_monitor",
    { scope: "fleet" },
    { daemon, voiceMode: "relay" },
  );
  assert.match(result.error, /requires action and scope/);
});

test("fleet_agent_status requires agentId", async () => {
  const daemon = catalogStub({});
  const result = await executeTool("fleet_agent_status", {}, { daemon, voiceMode: "relay" });
  assert.match(result.error, /requires agentId/);
});
