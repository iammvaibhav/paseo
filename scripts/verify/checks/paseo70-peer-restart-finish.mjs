import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnDaemonHost, waitForDaemonHealth } from "../lib/daemon.mjs";

export const meta = {
  name: "paseo70-peer-restart-finish",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "PASEO-70: a /mcp/fleet notifyOnFinish watch on a peer agent survives the peer's daemon restart mid-run. The webhook gets a non-final paseo.agent.interrupted, then exactly one paseo.agent.finished for the run the peer resumes, with that run's turnId and last message.",
};

// The MCP SDK and bcryptjs live in the server package, not the repo root.
const serverRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/package.json"),
);
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "paseo70-peer-restart";
const TOKEN = randomBytes(24).toString("hex");
const CONTEXT = "paseo70-peer-restart";
// Long enough that the run is still going when the peer restarts.
const LONG_RUN = "mock/one-minute-stream";

let webhook;
const received = [];
const state = {};

async function pollUntil(fetchValue, { timeoutMs = 240_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** One tool call on a fresh /mcp/fleet connection to the commander. */
async function call(ctx, name, args) {
  const { Client } = await importFromServer("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await importFromServer(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ctx.host("commander").httpUrl}/mcp/fleet`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    });
    const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return result.structuredContent;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const ours = () => received.filter((entry) => entry.event.context === CONTEXT);

export const steps = [
  {
    id: "setup",
    label: "Register a remote MCP client with a webhook; enable the mock provider on the peer",
    narrate: "A bcrypt-hashed client token, a local webhook receiver, and mock agents on peer-b.",
    async run(ctx) {
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      webhook = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        received.push({ at: new Date().toISOString(), event: JSON.parse(raw) });
        res.end("{}");
      });
      const listening = Promise.withResolvers();
      webhook.listen(0, "127.0.0.1", () => listening.resolve());
      await listening.promise;
      const hookUrl = `http://127.0.0.1:${webhook.address().port}/hook`;

      const commanderConfigPath = path.join(ctx.host("commander").home, "config.json");
      const commanderConfig = JSON.parse(await fsp.readFile(commanderConfigPath, "utf8"));
      commanderConfig.daemon = commanderConfig.daemon ?? {};
      commanderConfig.daemon.mcp = commanderConfig.daemon.mcp ?? {};
      commanderConfig.daemon.mcp.remoteClients = [
        { name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4), notify: { url: hookUrl } },
      ];
      await fsp.writeFile(commanderConfigPath, JSON.stringify(commanderConfig, null, 2));

      const peerConfigPath = path.join(ctx.host("peer-b").home, "config.json");
      const peerConfig = JSON.parse(await fsp.readFile(peerConfigPath, "utf8"));
      peerConfig.agents.providers.mock = { enabled: true };
      await fsp.writeFile(peerConfigPath, JSON.stringify(peerConfig, null, 2));
      return `webhook ${hookUrl}`;
    },
  },
  {
    id: "arm",
    label: "Create a long-running agent on peer-b with notifyOnFinish",
    narrate: "fleet_create_agent on peer-b, notifyOnFinish armed by the commander.",
    async run(ctx) {
      const cwd = path.join(ctx.host("peer-b").home, "projects", "paseo70");
      await fsp.mkdir(cwd, { recursive: true });
      const created = await call(ctx, "fleet_create_agent", {
        host: "peer-b",
        cwd,
        isolation: "local",
        provider: LONG_RUN,
        title: "paseo70 peer restart",
        initialPrompt: "paseo70: stream.",
        notifyOnFinish: true,
        notifyContext: CONTEXT,
      });
      ctx.expect(Boolean(created.agentId), "peer agent created");
      ctx.expect(created.notify?.armed === true, "notifyOnFinish armed");
      state.agentId = created.agentId;
      state.firstTurn = created.turnId;
      // Let the run stream some text before the restart cuts it.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return JSON.stringify(state);
    },
  },
  {
    id: "restart-peer",
    label: "Restart the peer daemon mid-run (as a deploy does)",
    narrate: "SIGTERM peer-b, wait for exit, boot a new peer daemon on the same home and port.",
    async run(ctx) {
      const peer = ctx.host("peer-b");
      const pidInfo = JSON.parse(readFileSync(path.join(peer.home, "paseo.pid"), "utf8"));
      process.kill(pidInfo.pid, "SIGTERM");
      ctx.expect(await waitForExit(pidInfo.pid, 60_000), `peer daemon ${pidInfo.pid} exited`);
      if (peer.pid && peer.pid !== pidInfo.pid) await waitForExit(peer.pid, 30_000);
      spawnDaemonHost({
        hostName: "peer-b",
        homeDir: peer.home,
        port: peer.port,
        password: ctx.password,
      });
      const boot = await waitForDaemonHealth({
        homeDir: peer.home,
        expectedPort: peer.port,
        timeoutMs: 60_000,
      });
      state.restartedAt = new Date().toISOString();
      return `stopped pid ${pidInfo.pid}; new peer daemon healthy on ${boot.port} in ${boot.bootMs}ms`;
    },
  },
  {
    id: "interrupted",
    label: "The webhook gets a non-final paseo.agent.interrupted, not a finish",
    narrate: "The closed run is reported as interrupted with final false.",
    async run(ctx) {
      // The commander marks the peer unreachable while it restarts and reconnects on backoff.
      const event = await pollUntil(() => ours()[0], { timeoutMs: 240_000 });
      ctx.expect(Boolean(event), "a webhook arrived for the interrupted run");
      const body = event.event;
      ctx.log(`first webhook: ${JSON.stringify(body)}`);
      ctx.expect(
        body.type === "paseo.agent.interrupted",
        `first event is paseo.agent.interrupted, got ${body.type}/${body.reason}`,
      );
      ctx.expect(body.final === false, "interrupted event is not final");
      // "closed" when the peer's close reached the commander, "pending" when the
      // connection dropped first and the restarted peer no longer knew the turn.
      ctx.expect(
        body.agent.status === "closed" || body.agent.status === "pending",
        `agent status is closed or pending, got ${body.agent.status}`,
      );
      ctx.expect(body.agent.turnId === state.firstTurn, "bound to the create turn");
      return `${body.type} reason=${body.reason} final=${body.final} status=${body.agent.status}`;
    },
  },
  {
    id: "nudge",
    label: "Resume the agent on the peer the way the deploy nudge does",
    narrate: "The interrupted agent gets a resume prompt on its restarted host.",
    async run(ctx) {
      const sent = await call(ctx, "fleet_send_prompt", {
        host: "peer-b",
        agentId: state.agentId,
        prompt: "Deploy finished; the daemon restarted. Continue.",
        mode: "steer",
      });
      state.resumedTurn = sent?.turnId ?? null;
      return JSON.stringify(sent);
    },
  },
  {
    id: "finished",
    label: "Exactly one final paseo.agent.finished arrives for the resumed run",
    narrate: "The resumed run's finish reaches the webhook with its turn and last message.",
    async run(ctx) {
      const finished = await pollUntil(() =>
        ours().find((entry) => entry.event.type === "paseo.agent.finished"),
      );
      // Give a duplicate the chance to show up before counting.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const journalPath = path.join(
        ctx.host("commander").home,
        "mcp-fleet",
        "finish-watches.jsonl",
      );
      const journal = existsSync(journalPath)
        ? readFileSync(journalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      const proof = {
        state,
        webhooks: ours(),
        journal: journal.filter((entry) => entry.agentId === state.agentId),
      };
      await fsp.writeFile(
        path.join(ctx.artifactsDir, "paseo70-peer-restart-finish.json"),
        JSON.stringify(proof, null, 2),
      );
      const log = await ctx.readDaemonLog("commander");
      await fsp.writeFile(
        path.join(ctx.artifactsDir, "paseo70-commander-watch.log"),
        log
          .split("\n")
          .filter((line) => line.includes("mcp finish watch") && line.includes(state.agentId))
          .join("\n"),
      );
      ctx.expect(Boolean(finished), `paseo.agent.finished arrived (got ${ours().length} webhooks)`);
      const body = finished.event;
      ctx.log(`final webhook: ${JSON.stringify(body)}`);
      ctx.expect(body.final === true, "finished event is final");
      ctx.expect(body.reason === "finished", `reason finished, got ${body.reason}`);
      ctx.expect(
        body.agent.turnId !== state.firstTurn,
        "bound to the resumed turn, not the closed one",
      );
      if (state.resumedTurn) {
        ctx.expect(body.agent.turnId === state.resumedTurn, "bound to the turn the nudge started");
      }
      ctx.expect(
        typeof body.agent.lastMessage === "string" && body.agent.lastMessage.length > 0,
        "carries the resumed run's last message",
      );
      const types = ours().map((entry) => entry.event.type);
      ctx.expect(
        JSON.stringify(types) ===
          JSON.stringify(["paseo.agent.interrupted", "paseo.agent.finished"]),
        `exactly one interrupted then one finished: ${JSON.stringify(types)}`,
      );
      return `events ${JSON.stringify(types)}; final turn ${body.agent.turnId}`;
    },
  },
  {
    id: "cleanup",
    label: "Close the webhook receiver",
    narrate: "Receiver closed.",
    async run() {
      webhook?.close();
      return "closed";
    },
  },
];
