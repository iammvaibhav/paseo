// Commander Voice — dual-channel contract unit tests (spec 03 / 05).
// Every digest builder and executor returns { spoken, data }; typed ids
// live in data, never in spoken; the announce/pending_updates buffer retains
// proposalId, agentId, and kind.
//
// Run: node --test scripts/commander-voice/test/dual-channel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFleetRosterDigest,
  buildFleetInventoryDigest,
  DaemonConnection,
} from "../lib/daemon.js";
import { executeTool } from "../lib/tools.js";

const ID_PATTERNS = [
  /wks_[a-zA-Z0-9]+/,
  /prj_[a-zA-Z0-9]+/,
  /mcp_[a-zA-Z0-9]+/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];

function assertNoIdsInSpoken(spoken, label = "spoken text") {
  assert.equal(typeof spoken, "string", `${label} must be a string`);
  for (const pattern of ID_PATTERNS) {
    assert.doesNotMatch(
      spoken,
      pattern,
      `${label} must not contain raw ids matching ${pattern}: "${spoken}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. buildFleetRosterDigest
// ---------------------------------------------------------------------------

test("buildFleetRosterDigest returns { spoken, data } with server-computed buckets", () => {
  const agents = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      shortId: "11111111",
      title: "Worker Alpha",
      name: "worker-alpha",
      description: "Handles alpha tasks",
      host: "macbook",
      workspaceId: "wks_alpha",
      projectId: "prj_fleet",
      bucket: "running",
      reportStatus: ["Starting up", "Processing batch 1"],
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      shortId: "22222222",
      title: "Worker Beta",
      name: "worker-beta",
      description: "Beta reviewer",
      host: "macbook",
      workspaceId: "wks_beta",
      projectId: "prj_fleet",
      bucket: "needs_you",
      reportStatus: ["Blocked on permission"],
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      shortId: "33333333",
      title: "Worker Gamma",
      name: "worker-gamma",
      host: "server-2",
      bucket: "ready",
    },
    {
      id: "44444444-4444-4444-4444-444444444444",
      shortId: "44444444",
      title: "Worker Delta",
      name: "worker-delta",
      host: "server-2",
      bucket: "done",
    },
    {
      id: "55555555-5555-5555-5555-555555555555",
      shortId: "55555555",
      title: "Worker Epsilon",
      name: "worker-epsilon",
      host: "server-2",
      bucket: "idle",
    },
  ];

  const result = buildFleetRosterDigest(agents);
  assert.ok(result && typeof result === "object");
  assertNoIdsInSpoken(result.spoken, "roster digest spoken");

  // Spoken counts match data buckets.
  assert.match(
    result.spoken,
    /Across 2 hosts: 1 needs you, 1 running, 1 ready, 1 done, 1 idle\. Idle is not needs-you\./,
  );
  assert.match(result.spoken, /On macbook: Worker Alpha \(running\), Worker Beta \(needs you\)\./);
  assert.match(
    result.spoken,
    /On server-2: Worker Gamma \(ready\), Worker Delta \(done\), Worker Epsilon \(idle\)\./,
  );

  // Data channel carries verbatim ids and typed fields.
  assert.equal(result.data.agents.length, 5);
  const a1 = result.data.agents[0];
  assert.equal(a1.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(a1.shortId, "11111111");
  assert.equal(a1.title, "Worker Alpha");
  assert.equal(a1.name, "worker-alpha");
  assert.equal(a1.description, "Handles alpha tasks");
  assert.equal(a1.host, "macbook");
  assert.equal(a1.workspaceId, "wks_alpha");
  assert.equal(a1.projectId, "prj_fleet");
  assert.equal(a1.bucket, "running");
  assert.equal(a1.lastReport, "Processing batch 1");

  // Sum of bucket counts in data matches spoken.
  const dataCounts = result.data.agents.reduce((acc, a) => {
    acc[a.bucket] = (acc[a.bucket] || 0) + 1;
    return acc;
  }, {});
  assert.equal(dataCounts.needs_you, 1);
  assert.equal(dataCounts.running, 1);
  assert.equal(dataCounts.ready, 1);
  assert.equal(dataCounts.done, 1);
  assert.equal(dataCounts.idle, 1);
});

test("buildFleetRosterDigest falls back to pre-bucket predicate without bucket field", () => {
  const agents = [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      shortId: "aaaaaaaa",
      title: "Legacy Runner",
      host: "local",
      status: "running",
    },
    {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      shortId: "bbbbbbbb",
      title: "Legacy Attention",
      host: "local",
      status: "idle",
      requiresAttention: true,
    },
    {
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      shortId: "cccccccc",
      title: "Legacy Error",
      host: "local",
      status: "error",
    },
    {
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      shortId: "dddddddd",
      title: "Legacy Idle",
      host: "local",
      status: "idle",
    },
  ];

  const result = buildFleetRosterDigest(agents);
  assertNoIdsInSpoken(result.spoken, "fallback roster digest spoken");
  assert.match(
    result.spoken,
    /Across 1 host: 2 need you, 1 running, 0 ready, 0 done, 1 idle\. Idle is not needs-you\./,
  );
  assert.equal(result.data.agents[0].bucket, "running");
  assert.equal(result.data.agents[1].bucket, "needs_you");
  assert.equal(result.data.agents[2].bucket, "needs_you");
  assert.equal(result.data.agents[3].bucket, "idle");
});

test("buildFleetRosterDigest drops raw uuid when title and name are absent", () => {
  const agents = [
    {
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      shortId: "ffffffff",
      host: "local",
      status: "idle",
    },
  ];
  const result = buildFleetRosterDigest(agents);
  assertNoIdsInSpoken(result.spoken, "nameless agent spoken");
  assert.match(result.spoken, /On local: an untitled agent \(idle\)\./);
  assert.doesNotMatch(result.spoken, /ffffffff/);
  assert.equal(result.data.agents[0].id, "ffffffff-ffff-ffff-ffff-ffffffffffff");
});

test("buildFleetRosterDigest handles empty and null rosters", () => {
  const empty = buildFleetRosterDigest([]);
  assert.deepEqual(empty, { spoken: "No agents in the fleet.", data: { agents: [] } });

  const nullRoster = buildFleetRosterDigest(null);
  assert.deepEqual(nullRoster, { spoken: "No agents in the fleet.", data: { agents: [] } });
});

// ---------------------------------------------------------------------------
// 2. buildFleetInventoryDigest
// ---------------------------------------------------------------------------

test("buildFleetInventoryDigest returns { spoken, data } without query", () => {
  const hosts = [
    {
      host: "macbook",
      reachable: true,
      projects: [
        {
          id: "prj_0011223344556677",
          title: "Paseo",
          workspaces: [
            {
              id: "wks_1122334455667788",
              title: "evil-toad",
              kind: "worktree",
              cwd: "/home/ubuntu/paseo/wt/evil-toad",
            },
            {
              id: "wks_2233445566778899",
              title: "charming-seal",
              kind: "worktree",
              cwd: "/home/ubuntu/paseo/wt/charming-seal",
            },
          ],
        },
      ],
    },
    {
      host: "local",
      reachable: true,
      projects: [
        {
          id: "prj_aabbccddeeff0011",
          title: "Commander",
          workspaces: [
            {
              id: "wks_3344556677889900",
              title: "Main",
              kind: "directory",
              cwd: "/home/ubuntu/commander",
            },
          ],
        },
      ],
    },
  ];

  const result = buildFleetInventoryDigest(hosts);
  assertNoIdsInSpoken(result.spoken, "inventory digest spoken (no query)");
  assert.match(result.spoken, /Across 2 hosts: 2 projects, 3 workspaces\./);
  assert.match(
    result.spoken,
    /On macbook: project Paseo \(2 workspaces: evil-toad, charming-seal\)\./,
  );
  assert.match(result.spoken, /On local: project Commander \(1 workspace: Main\)\./);

  // Data channel carries verbatim prj_ and wks_ ids and cwd paths.
  assert.equal(result.data.hosts.length, 2);
  const h1 = result.data.hosts[0];
  assert.equal(h1.projects[0].id, "prj_0011223344556677");
  assert.equal(h1.projects[0].workspaces[0].id, "wks_1122334455667788");
  assert.equal(h1.projects[0].workspaces[0].cwd, "/home/ubuntu/paseo/wt/evil-toad");
});

test("buildFleetInventoryDigest with query returns match without prj_ id in spoken", () => {
  const hosts = [
    {
      host: "macbook",
      reachable: true,
      projects: [
        {
          id: "prj_0011223344556677",
          title: "Paseo",
          workspaces: [
            {
              id: "wks_1122334455667788",
              title: "evil-toad",
              kind: "worktree",
              cwd: "/home/ubuntu/paseo/wt/evil-toad",
            },
          ],
        },
      ],
    },
  ];

  const result = buildFleetInventoryDigest(hosts, "paseo");
  assertNoIdsInSpoken(result.spoken, "inventory query match spoken");
  assert.equal(
    result.spoken,
    'Closest to "paseo": project Paseo on macbook. Workspaces: evil-toad.',
  );
  assert.equal(result.data.hosts[0].projects[0].id, "prj_0011223344556677");
});

test("buildFleetInventoryDigest reports no match and empty hosts", () => {
  const hosts = [
    { host: "macbook", reachable: true, projects: [] },
    { host: "local", reachable: true, projects: [] },
  ];
  const noMatch = buildFleetInventoryDigest(hosts, "nonexistent");
  assert.equal(noMatch.spoken, 'No match for "nonexistent". Hosts: macbook, local.');
  assert.equal(noMatch.data.hosts.length, 2);

  const empty = buildFleetInventoryDigest(hosts);
  assert.equal(empty.spoken, "Across 2 hosts: no projects or workspaces.");
});

// ---------------------------------------------------------------------------
// 3. DaemonConnection catalog read tools return dual-channel results
// ---------------------------------------------------------------------------

test("daemon fleet read methods project { spoken, data } with verbatim ids", async () => {
  const structuredByTool = {
    tag_message: { recorded: true },
    fleet_recall: {
      ok: true,
      matches: [
        {
          text: "Decided on SQLite for persistence",
          bank: "paseo-fleet",
          occurredStart: "2026-08-10T12:00:00Z",
          attribution: {
            agentId: "12345678-1234-1234-1234-123456789abc",
            agentTitle: "Architect",
            agentName: "architect-1",
            workspaceId: "wks_arch",
          },
        },
      ],
    },
    fleet_context: {
      ok: true,
      runRecords: [
        {
          id: "rr_1",
          agentId: "12345678-1234-1234-1234-123456789abc",
          agentTitle: "Architect",
          agentName: "architect-1",
          serverId: "local",
          workspaceId: "wks_arch",
          projectId: "prj_main",
          outcome: "success",
          brief: "Build the store",
        },
      ],
      workspaceRollup: {
        kind: "workspace",
        workspaceId: "wks_arch",
        workspaceTitle: "Architecture Worktree",
        runs: [{ agentId: "12345678-1234-1234-1234-123456789abc", open: [] }],
      },
    },
    fleet_search: {
      matches: [
        {
          host: "macbook",
          agentId: "12345678-1234-1234-1234-123456789abc",
          name: "architect-1",
          title: "Architect",
          snippet: "fixed the auth bug",
        },
      ],
    },
    fleet_get_agent_activity: {
      agentId: "12345678-1234-1234-1234-123456789abc",
      content: "Ran build and verified tests.",
    },
    fleet_list_agents: {
      agents: [
        {
          id: "12345678-1234-1234-1234-123456789abc",
          shortId: "12345678",
          title: "Architect",
          host: "local",
          status: "running",
          bucket: "running",
        },
      ],
    },
    fleet_list_inventory: {
      hosts: [
        {
          host: "local",
          reachable: true,
          projects: [
            {
              id: "prj_main",
              title: "Main",
              workspaces: [{ id: "wks_arch", title: "arch", kind: "worktree", cwd: "/arch" }],
            },
          ],
        },
      ],
    },
  };

  const client = {
    missionControlToolsExecute: async ({ name }) => ({
      ok: true,
      name,
      structuredContent: structuredByTool[name] ?? {},
      content: "",
    }),
  };
  const daemon = Object.create(DaemonConnection.prototype);
  daemon.client = client;

  // fleetListAgents
  const roster = await daemon.fleetListAgents();
  assertNoIdsInSpoken(roster.spoken, "fleetListAgents spoken");
  assert.equal(roster.data.agents[0].id, "12345678-1234-1234-1234-123456789abc");

  // fleetListInventory
  const inventory = await daemon.fleetListInventory({ query: "main" });
  assertNoIdsInSpoken(inventory.spoken, "fleetListInventory spoken");
  assert.equal(inventory.data.hosts[0].projects[0].id, "prj_main");

  // fleetGetAgentActivity
  const activity = await daemon.fleetGetAgentActivity({
    host: "local",
    agentId: "12345678-1234-1234-1234-123456789abc",
  });
  assert.equal(activity.spoken, "Ran build and verified tests.");
  assert.equal(activity.data.agentId, "12345678-1234-1234-1234-123456789abc");

  // fleetSearch
  const search = await daemon.fleetSearch({ query: "auth" });
  assertNoIdsInSpoken(search.spoken, "fleetSearch spoken");
  assert.match(search.spoken, /1 match for "auth": architect-1 on macbook\./);
  assert.equal(search.data.matches[0].agentId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(search.data.matches[0].host, "macbook");

  // fleetRecall
  const recall = await daemon.fleetRecall({ query: "sqlite" });
  assertNoIdsInSpoken(recall.spoken, "fleetRecall spoken");
  assert.match(recall.spoken, /1 memory: Architect: Decided on SQLite/);
  assert.equal(recall.data.matches[0].agentId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(recall.data.matches[0].workspaceId, "wks_arch");

  // fleetContext
  const context = await daemon.fleetContext({ agentId: "12345678-1234-1234-1234-123456789abc" });
  assertNoIdsInSpoken(context.spoken, "fleetContext spoken");
  assert.match(context.spoken, /workspace "Architecture Worktree"/);
  assert.match(context.spoken, /Architect \(success\) — Build the store\./);
  assert.equal(context.data.runRecords[0].agentId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(context.data.runRecords[0].workspaceId, "wks_arch");
  assert.equal(context.data.runRecords[0].projectId, "prj_main");
  assert.equal(context.data.runRecords[0].serverId, "local");
  assert.equal(context.data.workspaceRollup.workspaceId, "wks_arch");

  // tagMessage
  const tagged = await daemon.tagMessage({
    agentIds: ["12345678-1234-1234-1234-123456789abc"],
  });
  assertNoIdsInSpoken(tagged.spoken, "tagMessage spoken");
  assert.match(tagged.spoken, /Tagged the current user turn to 1 agent\./);
  assert.deepEqual(tagged.data.agentIds, ["12345678-1234-1234-1234-123456789abc"]);
});

// ---------------------------------------------------------------------------
// 4. Update buffer retains ids and drainUpdates returns dual-channel
// ---------------------------------------------------------------------------

test("buffer retains proposalId and agentId and drainUpdates returns { spoken, data }", () => {
  const daemon = Object.create(DaemonConnection.prototype);
  daemon.buffer = [];
  daemon.updateBufferCap = 64;
  daemon.correlatedAgentIds = new Set(["agent-uuid-123"]);
  daemon.correlatedProposalIds = new Set();
  daemon.onAnnounce = () => false; // forces inject-classified events into buffer
  daemon.monitoredAgents = new Set();
  daemon.fleetMonitored = false;

  // Proposal event with proposal.id and agentId
  daemon.handleEvent({
    id: "mce_prop_1",
    ts: "2026-08-16T12:00:00Z",
    kind: "proposal",
    severity: "blocker",
    headline: "Approve spawn of Worker Beta",
    detail: "provider: omp",
    agentId: "commander-uuid-000",
    proposal: { id: "mcp_01HXYZ123456789ABCDEFGHJK", status: "pending" },
  });

  // Routine finished event for correlated agent
  daemon.handleEvent({
    id: "mce_fin_1",
    ts: "2026-08-16T12:01:00Z",
    kind: "finished",
    severity: "info",
    headline: "Worker Alpha finished",
    detail: "all tests green",
    agentId: "agent-uuid-123",
  });

  assert.equal(daemon.buffer.length, 2);
  const entry0 = daemon.buffer[0]; // newest-first: finished event
  assert.equal(entry0.id, "mce_fin_1");
  assert.equal(entry0.kind, "finished");
  assert.equal(entry0.agentId, "agent-uuid-123");

  const entry1 = daemon.buffer[1]; // proposal event
  assert.equal(entry1.id, "mce_prop_1");
  assert.equal(entry1.kind, "proposal");
  assert.equal(entry1.proposalId, "mcp_01HXYZ123456789ABCDEFGHJK");
  assert.equal(entry1.agentId, "commander-uuid-000");

  // Drain into dual-channel result
  const drained = daemon.drainUpdates();
  assertNoIdsInSpoken(drained.spoken, "drainUpdates spoken");
  assert.match(drained.spoken, /Here's what happened while you weren't asking\./);
  assert.match(drained.spoken, /Worker Alpha finished — all tests green/);
  assert.match(drained.spoken, /Approve spawn of Worker Beta — provider: omp/);

  assert.equal(drained.data.entries.length, 2);
  assert.equal(drained.data.entries[1].proposalId, "mcp_01HXYZ123456789ABCDEFGHJK");
  assert.equal(drained.data.entries[0].agentId, "agent-uuid-123");

  // Buffer is empty after drain
  assert.equal(daemon.buffer.length, 0);
  const emptyDrain = daemon.drainUpdates();
  assert.deepEqual(emptyDrain, {
    spoken: "No updates since you last asked.",
    data: { entries: [] },
  });
});

// ---------------------------------------------------------------------------
// 5. Local executors return dual-channel results
// ---------------------------------------------------------------------------

test("local executors return { spoken, data } with ids in data only", async () => {
  const daemon = {
    dispatch: async () => ({
      ok: true,
      agentId: "99999999-9999-9999-9999-999999999999",
    }),
    respondProposal: async () => ({ ok: true }),
    drainUpdates: () => ({
      spoken: "Here's what happened. Alpha finished.",
      data: { entries: [{ kind: "finished", agentId: "agent-1" }] },
    }),
    executeCatalogTool: async (name) => {
      if (name === "fleet_list_models") {
        return {
          ok: true,
          structuredContent: {
            host: "macbook",
            defaultWorkerModel: "omp/fast-model",
            models: { omp: ["fast-model"] },
          },
        };
      }
      if (name === "fleet_create_agent") {
        return {
          ok: true,
          structuredContent: {
            agentId: null,
            status: "pending-approval",
            guidance:
              "Spawn request sent for approval (proposal mcp_01ABC). The agent will be created once approved.",
          },
        };
      }
      if (name === "fleet_meta") {
        return {
          ok: true,
          structuredContent: { ok: true, status: "pending", proposalId: "mcp_02DEF" },
        };
      }
      if (name === "clarify") {
        return { ok: true, structuredContent: { ok: true, eventId: "mce_clarify_1" } };
      }
      if (name === "post_answer") {
        return { ok: true, structuredContent: { ok: true, eventId: "mce_answer_1" } };
      }
      return { ok: true, structuredContent: {} };
    },
  };

  // commander_dispatch
  const dispatched = await executeTool(
    "commander_dispatch",
    { message: "do work" },
    { daemon, voiceMode: "relay" },
  );
  assert.equal(dispatched.spoken, "Dispatched to the Commander — on it.");
  assert.equal(dispatched.data.agentId, "99999999-9999-9999-9999-999999999999");
  assertNoIdsInSpoken(dispatched.spoken, "commander_dispatch spoken");

  // proposal_respond (no mcp_ in spoken!)
  const approved = await executeTool(
    "proposal_respond",
    { proposalId: "mcp_01ABC", action: "approve" },
    { daemon, voiceMode: "relay" },
  );
  assert.equal(approved.spoken, "Proposal approved.");
  assert.equal(approved.data.proposalId, "mcp_01ABC");
  assert.equal(approved.data.action, "approve");
  assertNoIdsInSpoken(approved.spoken, "proposal_respond spoken");

  // pending_updates
  const updates = await executeTool("pending_updates", {}, { daemon, voiceMode: "relay" });
  assert.match(updates.spoken, /Alpha finished/);
  assert.equal(updates.data.entries[0].agentId, "agent-1");

  // fleet_list_models
  const models = await executeTool(
    "fleet_list_models",
    { host: "macbook" },
    { daemon, voiceMode: "relay" },
  );
  assert.match(models.spoken, /Default worker model on macbook: omp\/fast-model\./);
  assert.equal(models.data.host, "macbook");
  assert.equal(models.data.defaultWorkerModel, "omp/fast-model");

  // fleet_create_agent in direct mode (pending: no mcp_ in spoken)
  const created = await executeTool(
    "fleet_create_agent",
    { host: "local", provider: "omp/fast-model", initialPrompt: "build X" },
    { daemon, voiceMode: "direct" },
  );
  assertNoIdsInSpoken(created.spoken, "fleet_create_agent spoken");
  assert.match(created.spoken, /Spawn request sent for approval/);
  assert.equal(created.data.proposalId, "mcp_01ABC");

  // fleet_create_agent in direct mode (auto-spawned: no uuid in spoken)
  daemon.executeCatalogTool = async (name) => {
    if (name === "fleet_create_agent") {
      return {
        ok: true,
        structuredContent: {
          agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          workspaceId: "wks_target",
          status: "running",
        },
      };
    }
    return { ok: true, structuredContent: {} };
  };
  const spawnedAuto = await executeTool(
    "fleet_create_agent",
    { host: "local", provider: "omp/fast-model", initialPrompt: "build X" },
    { daemon, voiceMode: "direct" },
  );
  assertNoIdsInSpoken(spawnedAuto.spoken, "fleet_create_agent auto spoken");
  assert.equal(spawnedAuto.spoken, "Agent created on local.");
  assert.equal(spawnedAuto.data.agentId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(spawnedAuto.data.workspaceId, "wks_target");

  // fleet_rename_agent_title (meta-split tool) in direct mode: no mcp_ in spoken
  daemon.executeCatalogTool = async (name) => {
    if (name === "fleet_rename_agent_title") {
      return {
        ok: true,
        structuredContent: { ok: true, status: "pending", proposalId: "mcp_02DEF" },
      };
    }
    return { ok: true, structuredContent: {} };
  };
  const meta = await executeTool(
    "fleet_rename_agent_title",
    { agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "archimedes" },
    { daemon, voiceMode: "direct" },
  );
  assertNoIdsInSpoken(meta.spoken, "fleet_rename_agent_title spoken");
  assert.equal(meta.spoken, "Meta proposal created for approval.");
  assert.equal(meta.data.proposalId, "mcp_02DEF");
});
