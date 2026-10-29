import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnDaemonHost, waitForDaemonHealth } from "../lib/daemon.mjs";

export const meta = {
  name: "finish-watch-restart",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Finish callbacks survive a graceful daemon restart: a /mcp/fleet group watch (group:true, perAgent:true) posts paseo.agents.group_finished, and an agent-to-agent notifyOnFinish (create_agent from agent A) wakes A with the child's real finish instead of 'was closed'.",
};

// The MCP SDK and bcryptjs live in the server package, not the repo root.
const serverRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/package.json"),
);
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "finish-restart";
const TOKEN = randomBytes(24).toString("hex");
// Long enough that every watched run is still going when the daemon stops.
const LONG_RUN = "mock/one-minute-stream";
const FAST_RUN = "mock/e2e-fast-stream";

let webhook;
const received = [];
const ids = {};
let restartedAt = null;

async function pollUntil(fetchValue, { timeoutMs = 180_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function mcpClient(url, headers) {
  const { Client } = await importFromServer("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await importFromServer(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

/** One tool call on a fresh stateless connection, so a daemon restart never strands a client. */
async function call(ctx, name, args, { callerAgentId } = {}) {
  const { httpUrl } = ctx.host("commander");
  const client = callerAgentId
    ? await mcpClient(`${httpUrl}/mcp/agents?callerAgentId=${callerAgentId}`, {
        Authorization: `Bearer ${ctx.password}`,
      })
    : await mcpClient(`${httpUrl}/mcp/fleet`, { Authorization: `Bearer ${TOKEN}` });
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    });
    const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return { ...result, text };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function transcriptText(ctx, agentId) {
  const page = (await call(ctx, "fleet_get_transcript", { agentId, limit: 200 })).structuredContent;
  // Agent notifications land as agent_message tool rows; user rows hold the prompts.
  return (page.entries ?? [])
    .map((entry) =>
      entry.item?.type === "user_message" ? entry.item.text : entry.item?.agentMessage?.text,
    )
    .filter(Boolean)
    .join("\n----\n");
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

export const steps = [
  {
    id: "setup",
    label: "Register a remote MCP client with a webhook receiver",
    narrate: "A bcrypt-hashed client token and a local webhook receiver are configured.",
    async run(ctx) {
      const commander = ctx.host("commander");
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
      const configPath = path.join(commander.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.agents.providers.mock = { enabled: true };
      config.daemon = config.daemon ?? {};
      config.daemon.mcp = config.daemon.mcp ?? {};
      config.daemon.mcp.remoteClients = [
        { name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4), notify: { url: hookUrl } },
      ];
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
      return `webhook ${hookUrl}`;
    },
  },
  {
    id: "arm",
    label: "Arm a group watch on two long runs and an agent-to-agent notifyOnFinish",
    narrate:
      "Two one-minute mock runs under one group watch; agent A creates child C with notifyOnFinish.",
    async run(ctx) {
      const cwd = path.join(ctx.host("commander").home, "projects", "finish-restart");
      await fsp.mkdir(cwd, { recursive: true });
      const create = async (title, provider) => {
        const sc = (
          await call(ctx, "fleet_create_agent", {
            host: "local",
            cwd,
            isolation: "local",
            provider,
            title,
            initialPrompt: `${title}: stream.`,
          })
        ).structuredContent;
        ctx.expect(Boolean(sc.agentId), `${title} created`);
        return sc;
      };
      const g1 = await create("group one", LONG_RUN);
      const g2 = await create("group two", LONG_RUN);
      ids.g1 = g1.agentId;
      ids.g2 = g2.agentId;
      const armed = (
        await call(ctx, "fleet_notify_on_finish", {
          agents: [
            { agentId: g1.agentId, turnId: g1.turnId },
            { agentId: g2.agentId, turnId: g2.turnId },
          ],
          group: true,
          perAgent: true,
          notifyContext: "group-restart",
        })
      ).structuredContent;
      ctx.expect(Boolean(armed.groupId), "group armed");
      ids.groupId = armed.groupId;

      const caller = await create("caller A", FAST_RUN);
      ids.caller = caller.agentId;
      await call(ctx, "fleet_wait_agent", {
        agentId: caller.agentId,
        turnId: caller.turnId,
        timeoutSeconds: 60,
      });
      const child = await call(
        ctx,
        "create_agent",
        {
          title: "child C",
          provider: LONG_RUN,
          initialPrompt: "child C: stream.",
          notifyOnFinish: true,
        },
        { callerAgentId: caller.agentId },
      );
      ids.child = child.structuredContent?.agentId ?? child.structuredContent?.id;
      ctx.expect(Boolean(ids.child), `child created: ${child.text.slice(0, 300)}`);
      return JSON.stringify(ids);
    },
  },
  {
    id: "restart",
    label: "Gracefully restart the daemon while every watched run is still going",
    narrate: "SIGTERM the daemon, wait for exit, boot a new daemon on the same home and port.",
    async run(ctx) {
      const commander = ctx.host("commander");
      const pidInfo = JSON.parse(readFileSync(path.join(commander.home, "paseo.pid"), "utf8"));
      process.kill(pidInfo.pid, "SIGTERM");
      ctx.expect(await waitForExit(pidInfo.pid, 60_000), `daemon ${pidInfo.pid} exited`);
      if (commander.pid && commander.pid !== pidInfo.pid) {
        await waitForExit(commander.pid, 30_000);
      }
      ctx.expect(received.length === 0, `no webhook during shutdown: ${JSON.stringify(received)}`);
      spawnDaemonHost({
        hostName: "commander",
        homeDir: commander.home,
        port: commander.port,
        password: ctx.password,
      });
      const boot = await waitForDaemonHealth({
        homeDir: commander.home,
        expectedPort: commander.port,
        timeoutMs: 60_000,
      });
      restartedAt = new Date().toISOString();
      return `stopped pid ${pidInfo.pid}; new daemon healthy on ${boot.port} in ${boot.bootMs}ms`;
    },
  },
  {
    id: "nudge",
    label: "Resume the interrupted runs the way the deploy nudge does",
    narrate: "Each agent that was running gets a resume prompt.",
    async run(ctx) {
      for (const agentId of [ids.g1, ids.g2, ids.child]) {
        await call(ctx, "fleet_send_prompt", {
          agentId,
          prompt: "Deploy finished; the daemon restarted. Continue.",
          mode: "steer",
        });
      }
      return "3 agents resumed";
    },
  },
  {
    id: "observe",
    label: "Group webhook and agent-to-agent notification both arrive after the restart",
    narrate: "The group event lists both agents; agent A is told child C finished.",
    async run(ctx) {
      const group = await pollUntil(() =>
        received.find((entry) => entry.event.type === "paseo.agents.group_finished"),
      );
      const callerText = await pollUntil(async () => {
        const text = await transcriptText(ctx, ids.caller);
        return text.includes(`Agent ${ids.child}`) && text.includes("finished") ? text : null;
      });
      const finalCallerText = callerText ?? (await transcriptText(ctx, ids.caller));
      const journalDir = path.join(ctx.host("commander").home, "mcp-fleet");
      const proof = {
        restartedAt,
        ids,
        webhooks: received,
        callerTranscriptUserMessages: finalCallerText,
        journals: Object.fromEntries(
          (existsSync(journalDir) ? await fsp.readdir(journalDir) : []).map((file) => [
            file,
            readFileSync(path.join(journalDir, file), "utf8").trim().split("\n"),
          ]),
        ),
      };
      await fsp.writeFile(
        path.join(ctx.artifactsDir, "finish-watch-restart.json"),
        JSON.stringify(proof, null, 2),
      );
      const log = await ctx.readDaemonLog("commander");
      await fsp.writeFile(
        path.join(ctx.artifactsDir, "finish-watch-restart.log"),
        log
          .split("\n")
          .filter((line) =>
            /mcp finish|mcp group|agent finish watch|Failed to notify caller|mcp finish watches restored/.test(
              line,
            ),
          )
          .join("\n"),
      );
      const perAgent = received.filter(
        (entry) =>
          entry.event.type === "paseo.agent.finished" && entry.event.context === "group-restart",
      );
      ctx.log(
        `per-agent webhooks: ${perAgent.map((e) => `${e.event.agent.id}:${e.event.reason}`)}`,
      );
      ctx.expect(
        Boolean(group),
        `group_finished posted after restart (got ${received.length} webhooks)`,
      );
      for (const agentId of [ids.g1, ids.g2]) {
        const entry = group.event.agents.find((agent) => agent.id === agentId);
        ctx.expect(entry?.reason === "finished", `group entry for ${agentId} finished`);
      }
      ctx.expect(
        Boolean(callerText),
        `caller A was told child C finished; A's user messages:\n${finalCallerText}`,
      );
      ctx.expect(
        !finalCallerText.includes("was closed"),
        "caller A never got the shutdown's 'was closed'",
      );
      return `group ${group.event.groupId} with ${group.event.agents.length} agents; caller notified`;
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
