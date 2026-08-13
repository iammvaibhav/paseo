// Commander Voice — logic harness. Drives the voice proxy with TEXT turns
// (the Live API accepts text in the same session protocol) against the dev
// daemon, and asserts daemon effects. No microphone needed.
//
// Run:  node --test test/   (against the dev daemon on 127.0.0.1:6768)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { startVoiceServer } from "../server.js";
import {
  classifyEvent,
  buildFleetRosterDigest,
  buildFleetInventoryDigest,
  DaemonConnection,
} from "../lib/daemon.js";
import { executeTool } from "../lib/tools.js";

const require = createRequire(import.meta.url);
const CLIENT_APP_VERSION = require("../../../packages/client/package.json").version;

const PROXY_PORT = Number(process.env.PROXY_PORT || 8799);
const DEV_WS = process.env.PASEO_WS_URL || "ws://127.0.0.1:6768/ws";
const DEV_PASSWORD = process.env.PASEO_PASSWORD || "vaibhav123";

const HARNESS_PROMPT =
  "You are a terse voice relay for the Commander. When asked for the fleet status, call fleet_list_agents " +
  "and read its result aloud in one sentence. When asked to dispatch something, call commander_dispatch " +
  "with the raw user message verbatim. When the user asks for updates, call pending_updates. " +
  "When a proposal announcement includes a proposal id and the user approves or denies it, call " +
  "proposal_respond with that id and action. Keep every reply under 20 words.";

let voiceServer = null;
let control = null; // harness-side daemon client (proposals, fixture, commander)

function parseFrame(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { audio: data };
  }
}

/** A headless browser client: init, then drive with text turns. */
class VoiceClient {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws`);
    this.ws.binaryType = "arraybuffer";
    this.frames = [];
    this.audioBytes = 0;
    this.waiters = [];
    this.ws.on("message", (data) => {
      const frame = parseFrame(data);
      this.frames.push(frame);
      if (frame.audio) {
        this.audioBytes += frame.audio.byteLength ?? frame.audio.length;
      }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.pred(frame)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
      }
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(obj) {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  /** Wait until a frame matches (JSON frames only). */
  waitFor(pred, { timeoutMs = 90_000, label = "frame" } = {}) {
    const existing = this.frames.find((f) => f.parsed && pred(f.parsed));
    if (existing) {
      return Promise.resolve(existing.parsed);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        pred: (f) => Boolean(f.parsed && pred(f.parsed)),
        resolve: (f) => resolve(f.parsed),
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  framesOf(type) {
    return this.frames.filter((f) => f.parsed && f.parsed.type === type).map((f) => f.parsed);
  }

  async init() {
    await this.connect();
    this.send({ type: "init", systemInstruction: HARNESS_PROMPT });
    await this.waitFor((m) => m.type === "setupAck", { timeoutMs: 60_000, label: "setupAck" });
  }

  close() {
    this.ws.close();
  }
}

async function makeControlClient() {
  const client = new DaemonClient({
    url: DEV_WS,
    clientId: `voice-harness-${process.pid}`,
    clientType: "cli",
    appVersion: CLIENT_APP_VERSION,
    password: DEV_PASSWORD,
    connectTimeoutMs: 15_000,
    webSocketFactory: (u, o) => new WebSocket(u, o?.protocols, { headers: o?.headers }),
    reconnect: { enabled: false },
  });
  await client.connect();
  return client;
}

async function findCommanderId(client) {
  const res = await client.fetchAgents({
    filter: { labels: { "paseo.mission-control": "commander" } },
  });
  const candidates = res.entries
    .map((e) => e.agent)
    .filter((a) => !a.archivedAt && a.status !== "closed");
  candidates.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  assert.ok(candidates.length > 0, "dev daemon must have a live commander agent");
  return candidates[0].id;
}

async function pollPromptIndex(client, agentId, needle, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.listAgentTimelinePrompts(agentId);
    const hit = last.prompts?.find((p) => p.preview.includes(needle));
    if (hit) {
      return hit;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `prompt "${needle}" never appeared on agent ${agentId}; last prompts: ${JSON.stringify(
      last?.prompts?.slice(-5) ?? [],
    )}`,
  );
}

test.before(async () => {
  voiceServer = await startVoiceServer({ port: PROXY_PORT, updateBufferCap: 64 });
  assert.equal(voiceServer.getDaemonReady(), true, "voice server must connect to the dev daemon");
  control = await makeControlClient();
  const commanderId = await findCommanderId(control);
  assert.ok(commanderId, "dev daemon has no commander");
});

test.after(async () => {
  if (control) {
    await control.close();
  }
  if (voiceServer) {
    await voiceServer.close();
  }
});

test("announce-policy filter classifies events", () => {
  const proposal = (status) => ({
    kind: "proposal",
    severity: "blocker",
    proposal: { id: "mcp_1", status },
  });
  assert.equal(classifyEvent(proposal("pending")), "inject");
  assert.equal(classifyEvent(proposal("approved")), "buffer");
  assert.equal(classifyEvent({ kind: "blocked", severity: "blocker", headline: "x" }), "inject");
  assert.equal(
    classifyEvent({ kind: "clarification", severity: "attention", headline: "x" }),
    "inject",
  );
  assert.equal(classifyEvent({ kind: "verdict", severity: "blocker", headline: "x" }), "inject");
  assert.equal(classifyEvent({ kind: "finished", severity: "info", headline: "x" }), "buffer");
  assert.equal(classifyEvent({ kind: "milestone", severity: "info", headline: "x" }), "buffer");
  assert.equal(classifyEvent({ kind: "stalled", severity: "attention", headline: "x" }), "buffer");
  assert.equal(classifyEvent({ kind: "answer", severity: "info", headline: "x" }), "waiting");
});

test("fleet_list_agents digest counts needs-you vs idle from catalog-shaped rows", () => {
  const agents = [
    { id: "a1", title: "Alpha", host: "macbook", status: "running" },
    { id: "a2", title: "Beta", host: "macbook", status: "idle", requiresAttention: true },
    { id: "a3", title: "Gamma", host: "macbook", status: "idle" },
    { id: "a4", title: "Delta", host: "server-2", status: "error" },
    { id: "a5", title: "Epsilon", host: "server-2", status: "running" },
  ];
  const digest = buildFleetRosterDigest(agents);
  assert.match(
    digest,
    /Across 2 hosts: 2 running, 2 need you, 1 idle\. Idle is not needs-you\./,
    "leads with fleet-wide bucket counts",
  );
  assert.match(
    digest,
    /On macbook: Alpha \(running\), Beta \(needs you\), Gamma \(idle\)\./,
    "groups by host with per-agent buckets",
  );
  assert.match(digest, /On server-2: Delta \(needs you\), Epsilon \(running\)\./);
  // Idle is NOT needs-you: Gamma stays idle despite the fleet having needs-you rows.
  assert.match(digest, /Gamma \(idle\)/);
  assert.doesNotMatch(digest, /Gamma \(needs you\)/);
});

test("fleet_list_agents digest handles singular hosts and empty rosters", () => {
  assert.equal(buildFleetRosterDigest([]), "No agents in the fleet.");
  assert.equal(buildFleetRosterDigest(null), "No agents in the fleet.");
  const digest = buildFleetRosterDigest([
    { id: "a1", title: "Solo", host: "local", status: "idle" },
  ]);
  assert.match(digest, /Across 1 host: 0 running, 0 need you, 1 idle\. Idle is not needs-you\./);
  assert.match(digest, /On local: Solo \(idle\)\./);
});

test("fleet_list_inventory digest uses titles and leads with the project, not the host, when the query is a project name", () => {
  const hosts = [
    {
      host: "macbook",
      reachable: true,
      projects: [
        {
          id: "prj_paseo",
          title: "Paseo",
          workspaces: [
            { id: "wks_evil", title: "evil-toad", kind: "worktree", cwd: "/x/evil-toad" },
            { id: "wks_charming", title: "charming-seal", kind: "worktree", cwd: "/x/charming" },
          ],
        },
      ],
    },
  ];
  const digest = buildFleetInventoryDigest(hosts, "paseo");
  assert.match(
    digest,
    /Closest to "paseo": project Paseo on macbook \(id prj_paseo\)\. Workspaces: evil-toad, charming-seal\./,
    "project title first, host after, ids only for the project, workspace titles never raw ids",
  );
  assert.doesNotMatch(digest, /On paseo/, "the query is never treated as a host");
  assert.doesNotMatch(digest, /wks_evil/, "raw workspace ids never surface in speech");
});

test("fleet_list_inventory digest reports no match and lists host names", () => {
  const hosts = [
    { host: "macbook", reachable: true, projects: [] },
    { host: "local", reachable: true, projects: [] },
  ];
  const digest = buildFleetInventoryDigest(hosts, "stackmod");
  assert.match(digest, /No match for "stackmod"\. Hosts: macbook, local\./);
});

test("fleet_list_inventory digest leads with fleet-wide counts without a query", () => {
  const hosts = [
    {
      host: "macbook",
      reachable: true,
      projects: [
        {
          id: "prj_paseo",
          title: "Paseo",
          workspaces: [
            { id: "wks_evil", title: "evil-toad", kind: "worktree", cwd: "/x/evil-toad" },
            { id: "wks_charming", title: "charming-seal", kind: "worktree", cwd: "/x/charming" },
          ],
        },
      ],
    },
    {
      host: "local",
      reachable: true,
      projects: [
        {
          id: "prj_cmd",
          title: "commander",
          workspaces: [{ id: "wks_cmd", title: "Commander", kind: "directory", cwd: "/y" }],
        },
      ],
    },
  ];
  const digest = buildFleetInventoryDigest(hosts);
  assert.match(
    digest,
    /Across 2 hosts: 2 projects, 3 workspaces\./,
    "leads with fleet-wide counts",
  );
  assert.match(
    digest,
    /On macbook: project Paseo \(2 workspaces: evil-toad, charming-seal\)\./,
    "names projects and workspaces by title per host",
  );
  assert.match(digest, /On local: project commander \(1 workspace: Commander\)\./);
  assert.doesNotMatch(digest, /prj_|wks_/, "raw ids never surface in speech");
});

test("daemon fleet read methods execute catalog tools by name (no second implementation)", async () => {
  const calls = [];
  const client = {
    missionControlToolsExecute: async ({ name, args }) => {
      calls.push({ name, args });
      const structuredContent =
        name === "tag_message"
          ? { recorded: true }
          : name === "fleet_recall"
            ? { ok: true, matches: [] }
            : name === "fleet_context"
              ? { runRecords: [], ok: true }
              : name === "fleet_search"
                ? { matches: [] }
                : name === "fleet_list_inventory"
                  ? {
                      hosts: [
                        {
                          host: "local",
                          reachable: true,
                          projects: [
                            {
                              id: "prj_paseo",
                              title: "Paseo",
                              workspaces: [
                                {
                                  id: "wks_evil",
                                  title: "evil-toad",
                                  kind: "worktree",
                                  cwd: "/x/evil-toad",
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    }
                  : { agents: [] };
      return { ok: true, name, structuredContent, content: "" };
    },
  };
  const daemon = Object.create(DaemonConnection.prototype);
  daemon.client = client;

  const roster = await daemon.fleetListAgents({ statuses: ["running"] });
  assert.deepEqual(calls.at(-1), {
    name: "fleet_list_agents",
    args: { statuses: ["running"] },
  });
  assert.match(roster.result, /No agents in the fleet\./);

  const activity = await daemon.fleetGetAgentActivity({ host: "local", agentId: "a1", limit: 5 });
  assert.deepEqual(calls.at(-1), {
    name: "fleet_get_agent_activity",
    args: { host: "local", agentId: "a1", limit: 5 },
  });
  assert.equal(activity.result, "No activity to display.");

  const search = await daemon.fleetSearch({ query: "archimedes" });
  assert.deepEqual(calls.at(-1), { name: "fleet_search", args: { query: "archimedes" } });
  assert.match(search.result, /No matches for "archimedes"\./);

  const recall = await daemon.fleetRecall({ query: "decision" });
  assert.deepEqual(calls.at(-1), { name: "fleet_recall", args: { query: "decision" } });
  assert.match(recall.result, /No memories match "decision"\./);

  const context = await daemon.fleetContext({ agentId: "a1" });
  assert.deepEqual(calls.at(-1), { name: "fleet_context", args: { agentId: "a1" } });
  assert.match(context.result, /No run records in the mission-control store yet\./);

  const tagged = await daemon.tagMessage({ agentIds: ["a1"] });
  assert.deepEqual(calls.at(-1), { name: "tag_message", args: { agentIds: ["a1"] } });
  assert.match(tagged.result, /Tagged the current user turn to 1 agent\./);

  const models = await daemon.executeCatalogTool("fleet_list_models", { host: "local" });
  assert.deepEqual(calls.at(-1), {
    name: "fleet_list_models",
    args: { host: "local" },
  });
  assert.equal(models.ok, true);

  const inventory = await daemon.fleetListInventory({ query: "paseo" });
  assert.deepEqual(calls.at(-1), {
    name: "fleet_list_inventory",
    args: { query: "paseo" },
  });
  assert.match(
    inventory.result,
    /Closest to "paseo": project Paseo on local \(id prj_paseo\)\. Workspaces: evil-toad\./,
    "the daemon shapes the catalog inventory into a spoken digest",
  );
});

test("fleet_list_models executor returns the default worker model", async () => {
  const daemon = {
    executeCatalogTool: async (name) => {
      assert.equal(name, "fleet_list_models");
      return {
        ok: true,
        structuredContent: {
          host: "macbook",
          models: {
            omp: ["opencode-zen/deepseek-v4-flash-free", "anthropic/claude-sonnet-4"],
            "omp.modelRoles": ["task: opencode-zen/deepseek-v4-flash-free"],
          },
          defaultWorkerModel: "opencode-zen/deepseek-v4-flash-free",
        },
        content: "",
      };
    },
  };
  const result = await executeTool("fleet_list_models", { host: "macbook" }, { daemon });
  assert.match(
    result.result,
    /Default worker model on macbook: opencode-zen\/deepseek-v4-flash-free\./,
  );
  assert.match(
    result.result,
    /omp: opencode-zen\/deepseek-v4-flash-free, anthropic\/claude-sonnet-4/,
  );
  assert.doesNotMatch(
    result.result,
    /omp\.modelRoles/,
    "role mapping is never echoed as a provider",
  );
});

test("direct-mode mutating executors ride the catalog gate", async () => {
  const calls = [];
  const daemon = {
    executeCatalogTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "fleet_create_agent") {
        return {
          ok: true,
          structuredContent: {
            agentId: null,
            type: "omp",
            status: "pending-approval",
            guidance:
              "Spawn request sent for approval (proposal mcp_1). The agent will be created once approved.",
          },
          content: "",
        };
      }
      if (name === "fleet_meta") {
        return {
          ok: true,
          structuredContent: { ok: true, status: "pending", proposalId: "mcp_2" },
          content: "",
        };
      }
      return { ok: true, structuredContent: {}, content: "" };
    },
  };
  const spawned = await executeTool(
    "fleet_create_agent",
    { host: "local", provider: "omp/x", initialPrompt: "do it" },
    { daemon, voiceMode: "direct" },
  );
  assert.deepEqual(calls.at(-1), {
    name: "fleet_create_agent",
    args: { host: "local", provider: "omp/x", initialPrompt: "do it" },
  });
  assert.match(spawned.result, /proposal mcp_1/);

  const meta = await executeTool(
    "fleet_meta",
    { metaPlan: { action: "rename", targetLabel: "glowing-otter", newValue: "archimedes" } },
    { daemon, voiceMode: "direct" },
  );
  assert.deepEqual(calls.at(-1), {
    name: "fleet_meta",
    args: { metaPlan: { action: "rename", targetLabel: "glowing-otter", newValue: "archimedes" } },
  });
  assert.match(meta.result, /Meta proposal mcp_2 created for approval\./);

  // Relay mode still refuses mutating tools.
  const relayed = await executeTool(
    "fleet_create_agent",
    { host: "local", provider: "omp/x", initialPrompt: "do it" },
    { daemon, voiceMode: "relay" },
  );
  assert.match(relayed.error, /not declared in relay mode/);
});

test("fleet_list_agents executor returns a roster digest", async () => {
  const result = await executeTool(
    "fleet_list_agents",
    {},
    {
      daemon: voiceServer.daemon,
      voiceMode: "relay",
    },
  );
  assert.ok(result.result, "fleet_list_agents returns a result");
  assert.match(result.result, /Across \d+ host/, "digest leads with fleet-wide counts");
  assert.match(result.result, /Idle is not needs-you/, "digest distinguishes idle from needs-you");
  assert.match(result.result, /On /, "roster names its hosts");
  assert.match(result.result, /\(/, "roster rows carry statuses");
});

test("text turn drives the model to call fleet_list_agents (Live API path)", async () => {
  const client = new VoiceClient();
  await client.init();
  client.send({ type: "text", text: "what is the fleet status?" });
  const toolLog = await client.waitFor(
    (m) => m.type === "toolLog" && m.name === "fleet_list_agents",
    { label: "fleet_list_agents toolLog" },
  );
  assert.equal(toolLog.name, "fleet_list_agents");
  await client.waitFor(() => client.audioBytes > 500, {
    label: "spoken reply audio",
    timeoutMs: 60_000,
  });
  assert.ok(client.audioBytes > 500, "model streams an audio reply");
  client.close();
});

test("commander_dispatch reaches the Commander agent record", async () => {
  const marker = `HARNESS-DISPATCH-${Date.now()}`;
  const client = new VoiceClient();
  await client.init();
  client.send({
    type: "text",
    text: `dispatch this to the commander: ${marker} run a fixture agent that replies OK`,
  });
  const toolLog = await client.waitFor(
    (m) => m.type === "toolLog" && m.name === "commander_dispatch",
    { label: "commander_dispatch toolLog" },
  );
  assert.ok(typeof toolLog.args?.message === "string", "dispatch carries the message");
  const commanderId = await findCommanderId(control);
  // The message lands as a user prompt on the Commander's timeline.
  await pollPromptIndex(control, commanderId, marker);
  client.close();
});

test("a proposal push produces an injected (spoken) turn", async () => {
  const marker = `HARNESS-PROPOSAL-${Date.now()}`;
  const created = await control.missionControlProposalsCreate({
    message: marker,
    reason: "voice harness",
  });
  assert.equal(created.ok, true, "proposal created on the dev daemon");
  const client = new VoiceClient();
  await client.init();
  const injected = await client.waitFor(
    (m) => m.type === "injected" && m.event?.kind === "proposal",
    { label: "injected proposal turn" },
  );
  assert.equal(injected.event.kind, "proposal");
  assert.match(injected.text, /Proposal/);
  client.close();
});

test("proposal_respond flips the proposal on the dev daemon", async () => {
  const marker = `HARNESS-RESPOND-${Date.now()}`;
  const created = await control.missionControlProposalsCreate({
    message: marker,
    reason: "voice harness respond",
  });
  assert.equal(created.ok, true);
  const result = await executeTool(
    "proposal_respond",
    { proposalId: created.proposalId, action: "deny" },
    { daemon: voiceServer.daemon },
  );
  assert.match(result.result, /denied/, "respond returns ok");

  // Read the persisted store: the proposal must no longer be pending. The RPC
  // resolves before the store write lands, so poll briefly.
  const fs = await import("node:fs/promises");
  const root = new URL("../../../", import.meta.url).pathname;
  const proposalsPath = `${root}.dev/paseo-home/mission-control/proposals.jsonl`;
  const deadline = Date.now() + 15_000;
  let record = null;
  while (Date.now() < deadline) {
    const lines = (await fs.readFile(proposalsPath, "utf8")).trim().split("\n").filter(Boolean);
    // proposals.jsonl is append-only: status changes append new rows; the
    // latest row for the proposal is the current status.
    const rows = lines.map((l) => JSON.parse(l)).filter((r) => r.id === created.proposalId);
    record = rows[rows.length - 1] ?? null;
    if (record && record.status !== "pending") {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(record, "proposal record persisted");
  assert.equal(record.status, "denied");
});

test("routine events never inject and unrelated ones never buffer", async () => {
  const client = new VoiceClient();
  await client.init();
  const injectedBefore = client.framesOf("injected").length;

  // Spawn a fresh omp fixture agent: its run emits started/finished (routine,
  // info) events. They must not inject, and — because the fixture is not this
  // session's work — they must be dropped, never buffered.
  const created = await control.createAgent({
    title: `voice-fixture-${Date.now()}`,
    provider: "omp",
    model: "opencode-zen/deepseek-v4-flash-free",
    cwd: "/Users/vaibhav/paseo",
    initialPrompt: "Reply with the single word OK and nothing else. Then finish.",
    features: {},
  });
  const fixtureId = created.id;

  // Wait until the finished event actually exists on the daemon (the harness
  // must not assert on events that never arrived).
  const deadline = Date.now() + 90_000;
  let finishedEvent = null;
  while (Date.now() < deadline) {
    const events = await control.missionControlEventsFetch({ limit: 500 });
    finishedEvent = events.events.find((e) => e.agentId === fixtureId && e.kind === "finished");
    if (finishedEvent) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.ok(finishedEvent, "fixture finished event exists on the dev daemon");

  const injectedAfter = client.framesOf("injected").length;
  assert.equal(
    injectedAfter,
    injectedBefore,
    "routine events must NOT be injected into the live session",
  );
  client.close();

  // Fixture hygiene: archive the throwaway agent.
  await control.archiveAgent(fixtureId);
});

test("only session-correlated events enter the silent buffer", () => {
  const daemon = voiceServer.daemon;
  daemon.buffer = []; // deterministic start; tests run sequentially

  // An unrelated agent's routine event is dropped, never buffered.
  daemon.handleEvent({
    id: "mce_unrelated",
    ts: new Date().toISOString(),
    kind: "finished",
    severity: "info",
    headline: "Unrelated agent finished",
    agentId: "some-other-agent",
  });
  assert.equal(daemon.buffer.length, 0, "unrelated routine events are dropped");

  // A session-correlated agent's routine event buffers and drains.
  daemon.correlateAgent("session-agent-1");
  daemon.handleEvent({
    id: "mce_correlated",
    ts: new Date().toISOString(),
    kind: "finished",
    severity: "info",
    headline: "Session agent finished",
    agentId: "session-agent-1",
  });
  assert.equal(daemon.buffer.length, 1, "session-correlated events buffer");
  const digest = daemon.drainUpdates();
  assert.match(digest, /Session agent finished/, "pending_updates drains correlated events");
});

test("'any updates?' drains the buffer through the model (Live API path)", async () => {
  const client = new VoiceClient();
  await client.init();
  client.send({ type: "text", text: "any updates?" });
  const toolLog = await client.waitFor(
    (m) => m.type === "toolLog" && m.name === "pending_updates",
    { label: "pending_updates toolLog" },
  );
  assert.equal(toolLog.name, "pending_updates");
  client.close();
});
