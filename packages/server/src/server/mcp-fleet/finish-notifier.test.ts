import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import { createMcpFinishNotifier } from "./finish-notifier.js";

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
  turnId: "turn-1",
  title: "Essay writer",
  bucket: "ready",
  lastMessage: "Done.",
  error: null,
  ...fields,
});

describe("createMcpFinishNotifier", () => {
  let server: Server;
  let url: string;
  let received: Received[];
  let statuses: number[];

  beforeEach(async () => {
    received = [];
    statuses = [];
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.statusCode = statuses.shift() ?? 200;
      res.end("{}");
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterEach(() => {
    server.close();
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

  it("posts one group event after the last agent finishes, plus per-agent events", async () => {
    const finishOrder: string[] = [];
    await notifier().armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_1",
      agents: [
        { agentId: "a", turnId: "t-a" },
        { agentId: "b", turnId: "t-b" },
      ],
      perAgent: true,
      tool: "fleet_notify_on_finish",
      context: "batch-3",
      waitForAgent: async (input) => {
        // b blocks on a permission once, then both finish.
        if (input.agentId === "b" && !finishOrder.includes("b-perm")) {
          finishOrder.push("b-perm");
          return result({
            agentId: "b",
            status: "permission",
            finished: false,
            needsPermission: true,
            turnId: "t-b",
          });
        }
        finishOrder.push(input.agentId);
        return result({ agentId: input.agentId, turnId: input.turnId ?? null });
      },
    });
    const types = received.map((r) => r.body.type);
    expect(types.filter((t) => t === "paseo.agent.finished")).toHaveLength(2);
    expect(types.filter((t) => t === "paseo.agent.needs_permission")).toHaveLength(1);
    expect(types.at(-1)).toBe("paseo.agents.group_finished");
    expect(received.at(-1)!.body).toMatchObject({
      groupId: "grp_1",
      context: "batch-3",
      agents: [
        { id: "a", turnId: "t-a", status: "idle" },
        { id: "b", turnId: "t-b", status: "idle" },
      ],
    });
  });

  it("group-only mode posts no per-agent finished events", async () => {
    await notifier().armGroup({
      client: "grok-bot",
      target: { url },
      groupId: "grp_2",
      agents: [{ agentId: "a" }, { agentId: "b" }],
      perAgent: false,
      tool: "fleet_notify_on_finish",
      context: null,
      waitForAgent: async (input) => result({ agentId: input.agentId }),
    });
    expect(received.map((r) => r.body.type)).toEqual(["paseo.agents.group_finished"]);
  });
});
