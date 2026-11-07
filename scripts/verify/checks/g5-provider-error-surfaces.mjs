import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  name: "g5-provider-error-surfaces",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "An omp agent whose provider has no credentials fails each turn; over /mcp/fleet, fleet_wait_agent reports status error with the error text and the [System Error] lastMessage, and fleet_get_transcript tags the failure rows with their turn id.",
};

// A provider OMP knows but this host has no credentials for, so every turn fails.
const FAILING_PROVIDER = process.env.G5_FAILING_PROVIDER ?? "omp/google/gemini-3.8-flash";

const serverRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/package.json"),
);
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "g5-smoke";
const TOKEN = randomBytes(24).toString("hex");

let mcp;
const state = {};

async function call(name, args) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return result.structuredContent;
}

function expectFailedTurn(ctx, label, result, turnId) {
  ctx.expect(result.finished === true, `${label}: finished`);
  ctx.expect(result.status === "error", `${label}: status error (got ${result.status})`);
  ctx.expect(result.turnId === turnId, `${label}: bound to ${turnId} (got ${result.turnId})`);
  ctx.expect(
    typeof result.error === "string" && result.error.length > 0,
    `${label}: error populated (got ${JSON.stringify(result.error)})`,
  );
  ctx.expect(
    typeof result.lastMessage === "string" && result.lastMessage.startsWith("[System Error]"),
    `${label}: lastMessage is the system error (got ${JSON.stringify(result.lastMessage)})`,
  );
}

export const steps = [
  {
    id: "connect",
    label: "Register a remote MCP client and connect to /mcp/fleet",
    narrate: "A bcrypt-hashed client token is configured.",
    async run(ctx) {
      const host = ctx.host("commander");
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      const configPath = path.join(host.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.daemon = config.daemon ?? {};
      config.daemon.mcp = config.daemon.mcp ?? {};
      config.daemon.mcp.remoteClients = [{ name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4) }];
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2));

      const { Client } = await importFromServer("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await importFromServer(
        "@modelcontextprotocol/sdk/client/streamableHttp.js",
      );
      mcp = new Client({ name: CLIENT_NAME, version: "1.0.0" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${host.httpUrl}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      return "connected";
    },
  },
  {
    id: "create-failing",
    label: `fleet_create_agent with ${FAILING_PROVIDER}; its first turn fails`,
    narrate: "The agent is created and its first turn fails on missing credentials.",
    async run(ctx) {
      const host = ctx.host("commander");
      const cwd = path.join(host.home, "projects", "g5-failing");
      await fsp.mkdir(cwd, { recursive: true });
      const created = await call("fleet_create_agent", {
        host: "commander",
        cwd,
        isolation: "local",
        provider: FAILING_PROVIDER,
        title: "g5 failing provider",
        initialPrompt: "Reply with exactly: TURN-ONE. Do not use tools.",
      });
      ctx.expect(Boolean(created.agentId), "agent created");
      ctx.expect(
        typeof created.turnId === "string",
        `create returned a turnId (${created.turnId})`,
      );
      state.agentId = created.agentId;
      state.turn1 = created.turnId;
      return JSON.stringify({
        agentId: created.agentId,
        turnId: created.turnId,
        status: created.status,
        lastMessage: created.lastMessage,
      });
    },
  },
  {
    id: "wait-turn-1",
    label: "fleet_wait_agent bound to the failed first turn surfaces the error",
    narrate: "The wait reports status error with the provider's message.",
    async run(ctx) {
      const result = await call("fleet_wait_agent", {
        agentId: state.agentId,
        turnId: state.turn1,
        timeoutSeconds: 120,
      });
      expectFailedTurn(ctx, "turn 1", result, state.turn1);
      return JSON.stringify(result);
    },
  },
  {
    id: "send-and-wait-turn-2",
    label:
      "A second prompt fails too; the wait bound to it (live, then re-read) surfaces the error",
    narrate: "Both a live wait and a re-read of the ended turn report the error.",
    async run(ctx) {
      const sent = await call("fleet_send_prompt", {
        agentId: state.agentId,
        prompt: "Reply with exactly: TURN-TWO. Do not use tools.",
        mode: "queue",
      });
      ctx.expect(typeof sent.turnId === "string", `send returned a turnId (${sent.turnId})`);
      state.turn2 = sent.turnId;
      const live = await call("fleet_wait_agent", {
        agentId: state.agentId,
        turnId: state.turn2,
        timeoutSeconds: 120,
      });
      expectFailedTurn(ctx, "turn 2 live", live, state.turn2);
      // Ended turn, re-read from the timeline (the path that returned idle/null before).
      const reread = await call("fleet_wait_agent", {
        agentId: state.agentId,
        turnId: state.turn2,
        timeoutSeconds: 5,
      });
      expectFailedTurn(ctx, "turn 2 re-read", reread, state.turn2);
      const turn1Again = await call("fleet_wait_agent", {
        agentId: state.agentId,
        turnId: state.turn1,
        timeoutSeconds: 5,
      });
      expectFailedTurn(ctx, "turn 1 re-read", turn1Again, state.turn1);
      return JSON.stringify({ live, reread });
    },
  },
  {
    id: "transcript-turn-ids",
    label: "fleet_get_transcript tags each [System Error] row with its turn's id",
    narrate: "Every failure row carries the id of the turn that failed.",
    async run(ctx) {
      const page = await call("fleet_get_transcript", { agentId: state.agentId, limit: 50 });
      const failures = page.entries.filter(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.startsWith("[System Error]"),
      );
      ctx.expect(failures.length === 2, `two failure rows (got ${failures.length})`);
      ctx.expect(
        failures[0]?.turnId === state.turn1,
        `first failure row turnId ${failures[0]?.turnId} === ${state.turn1}`,
      );
      ctx.expect(
        failures[1]?.turnId === state.turn2,
        `second failure row turnId ${failures[1]?.turnId} === ${state.turn2}`,
      );
      await mcp.close();
      return JSON.stringify(
        page.entries.map((entry) => ({
          seq: entry.seq,
          turnId: entry.turnId,
          type: entry.item.type,
          text: entry.item.text?.slice(0, 80),
        })),
      );
    },
  },
];
