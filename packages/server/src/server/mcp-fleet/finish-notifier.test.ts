import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import {
  createMcpFinishNotifier,
  type McpClientBinding,
  type McpFinishLocalAgents,
  type McpFinishRunStart as RunStart,
} from "./finish-notifier.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const result = (fields: Partial<FleetAgentWaitResult>): FleetAgentWaitResult => ({
  ok: true,
  host: "blrofc3",
  agentId: "agent-1",
  status: "idle",
  finished: true,
  needsPermission: false,
  timedOut: false,
  turnId: null,
  title: "Essay writer",
  bucket: "ready",
  lastMessage: "Done.",
  error: null,
  ...fields,
});

// The agent's run never resumes; the watch is only ever suspended.
const neverStarts = () => Promise.withResolvers<RunStart>().promise;

// The agent's run never resumes; the wait ends when the notifier gives up on it.
function rejectsOnAbort(_agentId: string, signal: AbortSignal): Promise<RunStart> {
  const never = Promise.withResolvers<RunStart>();
  signal.addEventListener("abort", () => never.reject(signal.reason), { once: true });
  return never.promise;
}

describe("createMcpFinishNotifier", () => {
  let server: Server;
  let url: string;
  let received: Received[];
  let statuses: number[];
  let firstRequest: PromiseWithResolvers<void>;
  // Resolves once this many webhook requests have arrived.
  let awaitedCount = Number.POSITIVE_INFINITY;
  let countReached: PromiseWithResolvers<void>;
  let dir: string;
  let journalPath: string;

  beforeEach(async () => {
    received = [];
    statuses = [];
    firstRequest = Promise.withResolvers<void>();
    countReached = Promise.withResolvers<void>();
    awaitedCount = Number.POSITIVE_INFINITY;
    dir = await mkdtemp(path.join(tmpdir(), "finish-notifier-"));
    journalPath = path.join(dir, "mcp-fleet", "finish-watches.jsonl");
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      firstRequest.resolve();
      if (received.length >= awaitedCount) countReached.resolve();
      res.statusCode = statuses.shift() ?? 200;
      res.end("{}");
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Zero delays: arm() resolves once delivery is done, so tests await it.
  const notifier = () =>
    createMcpFinishNotifier({
      // The ref resolves to the raw key; the "Bearer " prefix stays from the config value.
      resolveSecret: async (value) => (value === "aside://me@x/item1" ? "crsr_secret" : value),
      logger: pino({ level: "silent" }),
      pollMs: 0,
      retryDelaysMs: [0, 0],
    });

  it("posts the finished event with context and a vault-resolved Authorization header", async () => {
    const waits: Array<{ agentId: string; host?: string }> = [];
    await notifier().arm({
      client: "grok-bot",
      target: { url, headers: { Authorization: "Bearer aside://me@x/item1" } },
      agentId: "agent-1",
      host: "blrofc3",
      tool: "fleet_create_agent",
      context: "essay-42",
      waitForAgent: async (input) => {
        waits.push(input);
        // First chunk times out while the agent still runs; the second sees it finish.
        return waits.length === 1
          ? result({ status: "running", finished: false, timedOut: true, lastMessage: null })
          : result({});
      },
    });
    expect(waits).toHaveLength(2);
    expect(waits.every((w) => w.agentId === "agent-1" && w.host === "blrofc3")).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe("Bearer crsr_secret");
    expect(received[0]!.body).toMatchObject({
      type: "paseo.agent.finished",
      reason: "finished",
      final: true,
      client: "grok-bot",
      context: "essay-42",
      agent: {
        id: "agent-1",
        host: "blrofc3",
        title: "Essay writer",
        status: "idle",
        bucket: "ready",
        lastMessage: "Done.",
        error: null,
      },
      trigger: { tool: "fleet_create_agent" },
    });
  });

  it("sends needs_permission once while blocked, then the final event", async () => {
    let calls = 0;
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_send_prompt",
      context: null,
      waitForAgent: async () => {
        calls += 1;
        if (calls <= 3)
          return result({ status: "permission", finished: false, needsPermission: true });
        return result({ status: "error", error: "boom" });
      },
    });
    expect(received.map((r) => r.body.type)).toEqual([
      "paseo.agent.needs_permission",
      "paseo.agent.finished",
    ]);
    expect(received[1]!.body).toMatchObject({
      reason: "errored",
      context: null,
      agent: { error: "boom" },
    });
  });

  it("keeps waiting through a failed or unreachable wait", async () => {
    let calls = 0;
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () => {
        calls += 1;
        if (calls === 1) throw new Error("peer offline");
        if (calls === 2) return result({ ok: false, error: "unreachable" });
        return result({});
      },
    });
    expect(calls).toBe(3);
    expect(received).toHaveLength(1);
  });

  it("retries a 5xx, and never retries a 4xx", async () => {
    statuses = [503];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () => result({}),
    });
    expect(received).toHaveLength(2);

    received = [];
    statuses = [401];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () => result({}),
    });
    expect(received).toHaveLength(1);
  });

  // A peer's daemon restarting (deploy, crash) closes the agent there: its
  // wait ends "closed" without the run having finished. The peer resumes the
  // agent as a new turn shortly after.
  it("a peer run closed by its host restarting: interrupted, then the resumed run's finish", async () => {
    const waits: Array<string | undefined> = [];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      host: "macbook",
      turnId: "turn-1",
      tool: "fleet_create_agent",
      context: "sleep-research",
      waitForAgent: async (input) => {
        waits.push(input.turnId);
        if (input.turnId === "turn-1") {
          return result({ status: "closed", turnId: "turn-1", lastMessage: "Half done." });
        }
        if (input.turnId === "turn-2") {
          return result({ turnId: "turn-2", lastMessage: "Full report." });
        }
        // Unbound probes: the peer is still restarting, then reports the
        // agent idle on the interrupted turn, then running the resumed turn.
        const probes = waits.filter((turnId) => turnId === undefined).length;
        if (probes === 1) return result({ ok: false, error: "peer unreachable" });
        if (probes === 2) return result({ status: "closed", turnId: "turn-1" });
        return result({ status: "running", finished: false, timedOut: true, turnId: "turn-2" });
      },
    });

    expect(received.map((r) => r.body.type)).toEqual([
      "paseo.agent.interrupted",
      "paseo.agent.finished",
    ]);
    expect(received[0]!.body).toMatchObject({
      reason: "interrupted",
      final: false,
      context: "sleep-research",
      agent: { turnId: "turn-1", status: "closed", lastMessage: "Half done." },
    });
    expect(received[1]!.body).toMatchObject({
      reason: "finished",
      final: true,
      context: "sleep-research",
      agent: { turnId: "turn-2", status: "idle", lastMessage: "Full report." },
    });
  });

  it("a peer that restarted before its close reached us: the lost turn is an interruption", async () => {
    const waits: Array<string | undefined> = [];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      host: "macbook",
      turnId: "turn-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async (input) => {
        waits.push(input.turnId);
        const boundWaits = waits.filter((turnId) => turnId === "turn-1").length;
        if (input.turnId === "turn-1") {
          // The connection drops mid-wait; the restarted peer no longer knows the turn.
          if (boundWaits === 1) throw new Error("Transport closed (code 1005)");
          if (boundWaits === 2) return result({ ok: false, error: "peer unreachable" });
          return result({
            status: "pending",
            finished: false,
            turnId: "turn-1",
            lastMessage: null,
          });
        }
        if (input.turnId === "turn-2") return result({ turnId: "turn-2", lastMessage: "Report." });
        return result({ status: "running", finished: false, timedOut: true, turnId: "turn-2" });
      },
    });

    expect(waits).toEqual(["turn-1", "turn-1", "turn-1", undefined, "turn-2"]);
    expect(received.map((r) => [r.body.type, r.body.final])).toEqual([
      ["paseo.agent.interrupted", false],
      ["paseo.agent.finished", true],
    ]);
    expect(received[1]!.body).toMatchObject({
      reason: "finished",
      agent: { turnId: "turn-2", lastMessage: "Report." },
    });
  });

  it("a turn that has not started yet is waited out while the host stays reachable", async () => {
    let calls = 0;
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      host: "macbook",
      turnId: "turn-1",
      tool: "fleet_send_prompt",
      context: null,
      waitForAgent: async () => {
        calls += 1;
        return calls < 3
          ? result({ status: "pending", finished: false, turnId: "turn-1", lastMessage: null })
          : result({ turnId: "turn-1" });
      },
    });
    expect(received.map((r) => [r.body.type, r.body.reason])).toEqual([
      ["paseo.agent.finished", "finished"],
    ]);
  });

  it("a peer run that never resumes after its host closed it ends with reason interrupted", async () => {
    await createMcpFinishNotifier({
      resolveSecret: async (value) => value,
      logger: pino({ level: "silent" }),
      pollMs: 0,
      resumeGraceMs: 20,
    }).arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      host: "macbook",
      turnId: "turn-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () =>
        result({ status: "closed", turnId: "turn-1", lastMessage: "Half." }),
    });

    expect(received.map((r) => [r.body.type, r.body.reason, r.body.final])).toEqual([
      ["paseo.agent.interrupted", "interrupted", false],
      ["paseo.agent.finished", "interrupted", true],
    ]);
    expect(received[1]!.body).toMatchObject({
      agent: { status: "closed", lastMessage: "Half." },
    });
  });

  it("an agent this daemon hosts that is closed reports closed at once", async () => {
    await createMcpFinishNotifier({
      resolveSecret: async (value) => value,
      logger: pino({ level: "silent" }),
      pollMs: 0,
      localAgents: {
        activeTurnId: () => "turn-1",
        waitForRunStart: neverStarts,
        hosts: async () => true,
      },
    }).arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () => result({ status: "closed", turnId: "turn-1" }),
    });

    expect(received.map((r) => [r.body.type, r.body.reason, r.body.final])).toEqual([
      ["paseo.agent.finished", "closed", true],
    ]);
  });

  // A restart: the first notifier is suspended, the second restores from the same journal.
  const daemon = (options: {
    localAgents?: McpFinishLocalAgents;
    retryDelaysMs?: number[];
    resumeGraceMs?: number;
  }) =>
    createMcpFinishNotifier({
      resolveSecret: async (value) => value,
      logger: pino({ level: "silent" }),
      journalPath,
      pollMs: 0,
      retryDelaysMs: options.retryDelaysMs ?? [0, 0],
      resumeGraceMs: options.resumeGraceMs ?? 60_000,
      localAgents: options.localAgents,
    });

  const localAgents = (
    waitForRunStart: McpFinishLocalAgents["waitForRunStart"],
  ): McpFinishLocalAgents => ({
    activeTurnId: () => "turn-1",
    waitForRunStart,
    hosts: async () => true,
  });

  const journal = async () =>
    (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  // The run the client prompted is cut by the shutdown; closing the agent
  // ends the pending wait with "closed", which is not the run's end.
  async function armThenRestart() {
    const shutdownClose = Promise.withResolvers<FleetAgentWaitResult>();
    const before = daemon({ localAgents: localAgents(neverStarts) });
    const armed = before.arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_send_prompt",
      context: "theme-research",
      waitForAgent: () => shutdownClose.promise,
    });
    await before.suspend();
    shutdownClose.resolve(result({ status: "closed" }));
    await armed;
    expect(received).toHaveLength(0);
  }

  it("reports the run the restarted daemon resumes, once", async () => {
    await armThenRestart();

    const resumed = Promise.withResolvers<RunStart>();
    const waits: string[] = [];
    const binding: McpClientBinding = {
      target: { url },
      waitForAgent: async (input) => {
        waits.push(input.agentId);
        // The restored watch is rebound to the resumed run's turn.
        expect(input.turnId).toBe("turn-2");
        return result({ lastMessage: "Screenshots saved.", turnId: "turn-2" });
      },
    };
    const after = daemon({ localAgents: localAgents(() => resumed.promise) });
    const { restored, settled } = await after.restore(async (client) =>
      client === "grok-bot" ? binding : null,
    );
    expect(restored).toBe(1);
    // The watch blocks on the resume, so its closed state is not reported.
    expect(waits).toHaveLength(0);
    resumed.resolve({ local: true, turnId: "turn-2" });
    await settled;

    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({
      type: "paseo.agent.finished",
      reason: "finished",
      client: "grok-bot",
      context: "theme-research",
      agent: {
        id: "agent-1",
        status: "idle",
        turnId: "turn-2",
        lastMessage: "Screenshots saved.",
      },
      trigger: { tool: "fleet_send_prompt" },
    });
    const entries = await journal();
    expect(entries.map((entry) => entry.event)).toEqual([
      "armed",
      "suspended",
      "restored",
      "resumed",
      "fired",
      "delivered",
    ]);
    expect(entries[0]).toMatchObject({ agentId: "agent-1", turnId: "turn-1" });
    expect(entries[3]).toMatchObject({ turnId: "turn-2" });

    const again = await daemon({}).restore(async () => {
      throw new Error("a settled watch is never restored");
    });
    expect(again.restored).toBe(0);
  });

  it("reports interrupted when the agent's run never resumes", async () => {
    await armThenRestart();

    // The notifier's own grace deadline is what this case waits out.
    const after = daemon({ resumeGraceMs: 1, localAgents: localAgents(rejectsOnAbort) });
    const binding: McpClientBinding = {
      target: { url },
      waitForAgent: async () => result({ status: "closed" }),
    };
    const { settled } = await after.restore(async () => binding);
    await settled;

    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({
      type: "paseo.agent.finished",
      reason: "interrupted",
      agent: { status: "closed" },
    });
  });

  it("a restart while waiting on a peer's resume picks that wait back up, without resending", async () => {
    // Remote agent: hosted on a peer, so this daemon's localAgents does not host it.
    const remote = (waitForRunStart: McpFinishLocalAgents["waitForRunStart"]) => ({
      ...localAgents(waitForRunStart),
      hosts: async () => false,
    });
    const probing = Promise.withResolvers<void>();
    const before = daemon({ localAgents: remote(neverStarts) });
    const armed = before.arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      host: "macbook",
      turnId: "turn-1",
      tool: "fleet_create_agent",
      context: "sleep-research",
      waitForAgent: (input) => {
        if (input.turnId === "turn-1") {
          return Promise.resolve(result({ status: "closed", turnId: "turn-1" }));
        }
        // The peer is still down when this daemon shuts down.
        probing.resolve();
        return Promise.withResolvers<FleetAgentWaitResult>().promise;
      },
    });
    await probing.promise;
    await before.suspend();
    await armed;
    expect(received.map((r) => r.body.type)).toEqual(["paseo.agent.interrupted"]);

    const waits: Array<string | undefined> = [];
    const after = daemon({ localAgents: remote(rejectsOnAbort) });
    const { restored, settled } = await after.restore(async () => ({
      target: { url },
      waitForAgent: async (input) => {
        waits.push(input.turnId);
        if (input.turnId === "turn-2") return result({ turnId: "turn-2", lastMessage: "Report." });
        if (input.turnId === undefined) {
          return result({ status: "running", finished: false, timedOut: true, turnId: "turn-2" });
        }
        throw new Error(`the interrupted turn is not waited on again: ${input.turnId}`);
      },
    }));
    expect(restored).toBe(1);
    await settled;

    expect(waits).toEqual([undefined, "turn-2"]);
    expect(received.map((r) => r.body.type)).toEqual([
      "paseo.agent.interrupted",
      "paseo.agent.finished",
    ]);
    expect(received[1]!.body).toMatchObject({
      reason: "finished",
      final: true,
      agent: { turnId: "turn-2", lastMessage: "Report." },
    });
    expect((await journal()).map((entry) => entry.event)).toEqual([
      "armed",
      "interrupted",
      "fired",
      "delivered",
      "suspended",
      "restored",
      "resumed",
      "fired",
      "delivered",
    ]);
  });

  it("sends again an event the restart cut off mid-retry", async () => {
    statuses = [503];
    const before = daemon({ retryDelaysMs: [60_000] });
    const armed = before.arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: null,
      waitForAgent: async () => result({}),
    });
    await firstRequest.promise;
    await before.suspend();
    await armed;

    const binding: McpClientBinding = {
      target: { url },
      waitForAgent: async () => {
        throw new Error("a fired event is resent, not re-watched");
      },
    };
    const { settled } = await daemon({}).restore(async () => binding);
    await settled;

    expect(received).toHaveLength(2);
    expect(received[1]!.body).toEqual(received[0]!.body);
    expect((await journal()).at(-1)).toMatchObject({ event: "delivered", status: 200 });
  });

  it("binds every re-wait to the turn the first wait reported", async () => {
    const turnIds: Array<string | undefined> = [];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      tool: "fleet_send_prompt",
      context: null,
      waitForAgent: async (input) => {
        turnIds.push(input.turnId);
        return turnIds.length < 3
          ? result({ status: "running", finished: false, timedOut: true, turnId: "turn-7" })
          : result({ turnId: "turn-7" });
      },
    });
    expect(turnIds).toEqual([undefined, "turn-7", "turn-7"]);
    expect(received[0]!.body).toMatchObject({ agent: { turnId: "turn-7" } });
  });

  it("an armed turnId is bound from the first wait", async () => {
    const turnIds: Array<string | undefined> = [];
    await notifier().arm({
      client: "grok-bot",
      target: { url },
      agentId: "agent-1",
      turnId: "turn-from-send",
      tool: "fleet_send_prompt",
      context: null,
      waitForAgent: async (input) => {
        turnIds.push(input.turnId);
        return result({ turnId: input.turnId ?? null });
      },
    });
    expect(turnIds).toEqual(["turn-from-send"]);
  });

  it("group: one group event once every agent finished; needs_permission still posts per agent", async () => {
    let blocked = false;
    await notifier().armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_1",
      agents: [
        { agentId: "a", turnId: "t-a" },
        { agentId: "b", turnId: "t-b" },
      ],
      perAgent: false,
      tool: "fleet_notify_on_finish",
      context: "batch-3",
      waitForAgent: async (input) => {
        // b blocks on a permission once, then both finish.
        if (input.agentId === "b" && !blocked) {
          blocked = true;
          return result({
            agentId: "b",
            status: "permission",
            finished: false,
            needsPermission: true,
            turnId: "t-b",
          });
        }
        return result({ agentId: input.agentId, turnId: input.turnId ?? null });
      },
    });
    expect(received.map((r) => r.body.type)).toEqual([
      "paseo.agent.needs_permission",
      "paseo.agents.group_finished",
    ]);
    expect(received.at(-1)!.body).toMatchObject({
      groupId: "grp_1",
      context: "batch-3",
      agents: [
        { id: "a", turnId: "t-a", status: "idle" },
        { id: "b", turnId: "t-b", status: "idle" },
      ],
    });
  });

  it("group: a member a peer closed mid-run is reported at the end of its resumed run", async () => {
    await notifier().armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_peer",
      agents: [
        { agentId: "a", turnId: "t-a" },
        { agentId: "b", host: "macbook", turnId: "t-b" },
      ],
      perAgent: false,
      tool: "fleet_notify_on_finish",
      context: null,
      waitForAgent: async (input) => {
        if (input.agentId === "a") return result({ agentId: "a", turnId: "t-a" });
        if (input.turnId === "t-b")
          return result({ agentId: "b", status: "closed", turnId: "t-b" });
        if (input.turnId === undefined) {
          return result({
            agentId: "b",
            status: "running",
            finished: false,
            timedOut: true,
            turnId: "t-b2",
          });
        }
        return result({ agentId: "b", turnId: "t-b2", lastMessage: "B report." });
      },
    });
    expect(received.map((r) => r.body.type)).toEqual([
      "paseo.agent.interrupted",
      "paseo.agents.group_finished",
    ]);
    expect(received[1]!.body).toMatchObject({
      agents: [
        { id: "a", turnId: "t-a", reason: "finished" },
        { id: "b", turnId: "t-b2", reason: "finished", lastMessage: "B report." },
      ],
    });
  });

  it("group with perAgent also posts one finished event per agent", async () => {
    awaitedCount = 3;
    await notifier().armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_2",
      agents: [{ agentId: "a" }, { agentId: "b" }],
      perAgent: true,
      tool: "fleet_notify_on_finish",
      context: null,
      waitForAgent: async (input) => result({ agentId: input.agentId }),
    });
    // The per-agent watches settle on their own schedule; wait for all three events.
    await countReached.promise;
    const types = received.map((r) => r.body.type);
    expect(types.filter((type) => type === "paseo.agent.finished")).toHaveLength(2);
    expect(types.filter((type) => type === "paseo.agents.group_finished")).toHaveLength(1);
  });

  it("group: the group event survives a restart, keeping members that ended before it", async () => {
    // a finishes before the shutdown; b's run is cut by it.
    const aEnded = Promise.withResolvers<void>();
    const shutdownClose = Promise.withResolvers<FleetAgentWaitResult>();
    const before = daemon({ localAgents: localAgents(neverStarts) });
    const armed = before.armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_restart",
      agents: [
        { agentId: "a", turnId: "t-a" },
        { agentId: "b", turnId: "t-b" },
      ],
      perAgent: false,
      tool: "fleet_notify_on_finish",
      context: "batch-9",
      waitForAgent: async (input) => {
        if (input.agentId === "b") return shutdownClose.promise;
        aEnded.resolve();
        return result({ agentId: "a", turnId: "t-a", lastMessage: "A done." });
      },
    });
    await aEnded.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await before.suspend();
    shutdownClose.resolve(result({ agentId: "b", status: "closed", turnId: "t-b" }));
    await armed;
    expect(received).toHaveLength(0);

    const resumed = Promise.withResolvers<RunStart>();
    const resumeWaits: string[] = [];
    const after = daemon({
      localAgents: localAgents((agentId) => {
        resumeWaits.push(agentId);
        return resumed.promise;
      }),
    });
    const { restored, settled } = await after.restore(async () => ({
      target: { url },
      waitForAgent: async (input) => {
        expect(input).toMatchObject({ agentId: "b", turnId: "t-b2" });
        return result({ agentId: "b", turnId: "t-b2", lastMessage: "B done." });
      },
    }));
    expect(restored).toBe(1);
    expect(resumeWaits).toEqual(["b"]);
    resumed.resolve({ local: true, turnId: "t-b2" });
    await settled;

    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({
      type: "paseo.agents.group_finished",
      groupId: "grp_restart",
      context: "batch-9",
      agents: [
        { id: "a", turnId: "t-a", reason: "finished", lastMessage: "A done." },
        { id: "b", turnId: "t-b2", reason: "finished", lastMessage: "B done." },
      ],
    });
    expect((await journal()).map((entry) => entry.event)).toEqual([
      "group_armed",
      "member_ended",
      "suspended",
      "restored",
      "resumed",
      "member_ended",
      "fired",
      "delivered",
    ]);
    const again = await daemon({}).restore(async () => {
      throw new Error("a delivered group is never restored");
    });
    expect(again.restored).toBe(0);
  });

  it("group: sends again a group event the restart cut off mid-retry", async () => {
    statuses = [503];
    const before = daemon({ retryDelaysMs: [60_000] });
    const armed = before.armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_retry",
      agents: [{ agentId: "a", turnId: "t-a" }],
      perAgent: false,
      tool: "fleet_notify_on_finish",
      context: null,
      waitForAgent: async () => result({ agentId: "a", turnId: "t-a" }),
    });
    await firstRequest.promise;
    await before.suspend();
    await armed;

    const { settled } = await daemon({}).restore(async () => ({
      target: { url },
      waitForAgent: async () => {
        throw new Error("a fired group event is resent, not re-watched");
      },
    }));
    await settled;

    expect(received).toHaveLength(2);
    expect(received[1]!.body).toEqual(received[0]!.body);
    expect((await journal()).at(-1)).toMatchObject({
      event: "delivered",
      watchId: "grp_retry",
      status: 200,
    });
  });

  it("a send that joins the turn a watch follows does not post that turn's end twice", async () => {
    const runEnds = Promise.withResolvers<FleetAgentWaitResult>();
    const subject = notifier();
    const arm = (tool: string) =>
      subject.arm({
        client: "grok-bot",
        target: { url },
        agentId: "agent-1",
        turnId: "turn-1",
        tool,
        context: "essay-42",
        waitForAgent: () => runEnds.promise,
      });
    const created = arm("fleet_create_agent");
    // A live steer reports the turn already running.
    const steered = arm("fleet_send_prompt");
    runEnds.resolve(result({ turnId: "turn-1" }));
    await Promise.all([created, steered]);
    expect(received.map((r) => r.body.type)).toEqual(["paseo.agent.finished"]);
  });

  it("an arm subscribes the client to the agent across a restart until it unsubscribes", async () => {
    const binding: McpClientBinding = { target: { url }, waitForAgent: async () => result({}) };
    const before = daemon({});
    await before.arm({
      ...binding,
      client: "grok-bot",
      agentId: "agent-1",
      tool: "fleet_create_agent",
      context: "essay-42",
    });
    expect(before.subscription("grok-bot", "agent-1")).toEqual({ context: "essay-42" });
    expect(before.subscription("grok-bot", "agent-2")).toBeNull();
    expect(before.subscription("other-bot", "agent-1")).toBeNull();
    await before.suspend();

    const after = daemon({});
    await after.restore(async () => binding);
    expect(after.subscription("grok-bot", "agent-1")).toEqual({ context: "essay-42" });
    after.unsubscribe("grok-bot", "agent-1");
    expect(after.subscription("grok-bot", "agent-1")).toBeNull();
    await after.suspend();

    const again = daemon({});
    await again.restore(async () => binding);
    expect(again.subscription("grok-bot", "agent-1")).toBeNull();
  });
});
