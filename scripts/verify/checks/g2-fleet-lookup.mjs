import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  name: "g2-fleet-lookup",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "With a configured peer down, fleet tools still serve agents on the reachable peer: fleet_agent_status and fleet_wait_agent take a short id, fleet_list_agents and fleet_search name the down host in warnings, and fleet_search survives a closed agent whose timeline is loaded.",
};

const serverRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/package.json"),
);
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "g2-fleet-lookup";
const TOKEN = randomBytes(24).toString("hex");
const NEEDLE = `g2needle${randomBytes(4).toString("hex")}`;
const PROOF_DIR = process.env.G2_PROOF_DIR ?? null;

let mcp;
let directTools = new Set();
const agents = {};
const evidence = {};

async function pollUntil(fetchValue, { timeoutMs = 120_000, intervalMs = 500, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/** Call a fleet tool directly when /mcp/fleet lists it, else through paseo_tool_call. */
async function call(name, args) {
  const request = directTools.has(name)
    ? { name, arguments: args }
    : { name: "paseo_tool_call", arguments: { name, arguments: args } };
  const result = await mcp.callTool(request, undefined, { timeout: 600_000 });
  const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return result.structuredContent;
}

/** A TCP port with nothing listening: the configured "macbook" peer is down. */
async function closedPort() {
  const server = createServer();
  const listening = Promise.withResolvers();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address();
  const closed = Promise.withResolvers();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

export const steps = [
  {
    id: "connect",
    label: "Connect a remote MCP client to the commander's /mcp/fleet",
    narrate: "A token-authenticated MCP client connects to the commander.",
    async run(ctx) {
      const commander = ctx.host("commander");
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      const configPath = path.join(commander.home, "config.json");
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
        new StreamableHTTPClientTransport(new URL(`${commander.httpUrl}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      directTools = new Set((await mcp.listTools()).tools.map((tool) => tool.name));
      return `connected; ${directTools.size} tools`;
    },
  },
  {
    id: "macbook-down",
    label: "Configure a third peer, macbook, whose host is down",
    narrate: "The commander now has a peer it cannot reach.",
    async run(ctx) {
      const commander = ctx.host("commander");
      const configPath = path.join(commander.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      const port = await closedPort();
      config.peers = [
        ...config.peers.filter((peer) => peer.name !== "macbook"),
        {
          name: "macbook",
          url: `tcp://127.0.0.1:${port}`,
          ...(ctx.password ? { password: ctx.password } : {}),
        },
      ];
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
      await commander.client.reloadDaemonConfig();
      const inventory = await pollUntil(
        async () => {
          const inv = await call("fleet_list_inventory", {});
          const macbook = inv.hosts?.find((host) => host.host === "macbook");
          return macbook && macbook.reachable === false ? inv : null;
        },
        { description: "macbook to show as unreachable" },
      );
      evidence.hosts = inventory.hosts.map((host) => ({
        host: host.host,
        reachable: host.reachable,
      }));
      return JSON.stringify(evidence.hosts);
    },
  },
  {
    id: "agents",
    label: "Run one agent on peer-b and one on commander",
    narrate: "Both agents answer their first prompt.",
    async run(ctx) {
      const provider = ctx.stack.commanderModel;
      ctx.expect(Boolean(provider), "stack resolved an omp model");
      for (const [key, host] of [
        ["peer", "peer-b"],
        ["local", "commander"],
      ]) {
        const cwd = path.join(ctx.host(host).home, "projects", `g2-${key}`);
        await fsp.mkdir(cwd, { recursive: true });
        const created = await call("fleet_create_agent", {
          host,
          cwd,
          isolation: "local",
          provider,
          title: `g2 ${key} worker`,
          initialPrompt: `Remember the code word ${NEEDLE}-${key}. Reply with exactly: ${key.toUpperCase()}-DONE. Do not use tools.`,
        });
        agents[key] = { agentId: created.agentId, host, turnId: created.turnId };
      }
      return JSON.stringify(agents);
    },
  },
  {
    id: "wait-short-id",
    label: "fleet_wait_agent with an 8-char short id waits on the peer-b agent",
    narrate: "The short id expands to the full id on peer-b.",
    async run(ctx) {
      const shortId = agents.peer.agentId.slice(0, 8);
      const result = await call("fleet_wait_agent", { agentId: shortId, timeoutSeconds: 600 });
      evidence.waitShortId = { shortId, result };
      ctx.expect(result.ok === true, `wait ok: ${JSON.stringify(result)}`);
      ctx.expect(result.host === "peer-b", `wait ran on peer-b (${result.host})`);
      ctx.expect(result.agentId === agents.peer.agentId, "wait result carries the full id");
      ctx.expect(result.finished === true, "peer agent finished");
      const local = await call("fleet_wait_agent", {
        agentId: agents.local.agentId,
        timeoutSeconds: 600,
      });
      ctx.expect(local.finished === true, "commander agent finished");
      return `${shortId} → ${result.agentId} on ${result.host}`;
    },
  },
  {
    id: "status-short-id",
    label: "fleet_agent_status with a short id resolves the peer-b agent while macbook is down",
    narrate: "The status comes back from peer-b with the full id.",
    async run(ctx) {
      const shortId = agents.peer.agentId.slice(0, 8);
      const status = await call("fleet_agent_status", { agentId: shortId });
      evidence.statusShortId = { shortId, status };
      ctx.expect(status.host === "peer-b", `status host is peer-b (${status.host})`);
      ctx.expect(status.agentId === agents.peer.agentId, "status carries the full id");
      return `${shortId} → ${status.agentId} on ${status.host}, bucket ${status.bucket}`;
    },
  },
  {
    id: "list-warnings",
    label: "fleet_list_agents lists the reachable hosts' agents and warns about macbook",
    narrate: "The roster has both agents and one warning for macbook.",
    async run(ctx) {
      const roster = await call("fleet_list_agents", { query: "g2", limit: 50 });
      evidence.list = {
        agents: roster.agents.map((agent) => ({ id: agent.id, host: agent.host })),
        warnings: roster.warnings,
      };
      for (const agent of Object.values(agents)) {
        ctx.expect(
          roster.agents.some((row) => row.id === agent.agentId),
          `roster lists ${agent.agentId}`,
        );
      }
      ctx.expect(
        roster.warnings.length === 1 && roster.warnings[0].startsWith('Host "macbook" unreachable'),
        `one macbook warning: ${JSON.stringify(roster.warnings)}`,
      );
      return JSON.stringify(evidence.list);
    },
  },
  {
    id: "search-closed-agent",
    label: "fleet_search keeps working after an agent is closed while its timeline is loaded",
    narrate: "The closed agent is found by its brief; the search never fails with Unknown agent.",
    async run(ctx) {
      await call("fleet_kill_agent", { agentId: agents.local.agentId });
      // First search seeds the closed agent's timeline (tier 2); the second
      // reads it through tier 1 — the path that used to throw Unknown agent.
      const first = await call("fleet_search", { query: `${NEEDLE}-local` });
      const second = await call("fleet_search", { query: `${NEEDLE}-local` });
      const peer = await call("fleet_search", { query: `${NEEDLE}-peer` });
      evidence.search = { first, second, peer };
      for (const result of [first, second]) {
        ctx.expect(
          result.matches.some((match) => match.agentId === agents.local.agentId),
          `closed agent found: ${JSON.stringify(result.matches)}`,
        );
      }
      ctx.expect(
        peer.matches.some(
          (match) => match.agentId === agents.peer.agentId && match.host === "peer-b",
        ),
        `peer agent found on peer-b: ${JSON.stringify(peer.matches)}`,
      );
      ctx.expect(
        second.warnings.some((warning) => warning.startsWith('Host "macbook" unreachable')),
        `search warns about macbook: ${JSON.stringify(second.warnings)}`,
      );
      return `closed agent matched via ${second.matches.find((m) => m.agentId === agents.local.agentId).matchedIn}; peer via ${peer.matches[0]?.matchedIn}`;
    },
  },
  {
    id: "evidence",
    label: "Write the tool outputs to the proof directory",
    narrate: "Evidence saved.",
    async run(ctx) {
      const dir = PROOF_DIR ?? ctx.artifactsDir;
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, "g2-fleet-lookup-evidence.json");
      await fsp.writeFile(file, JSON.stringify({ agents, ...evidence }, null, 2));
      await mcp?.close();
      return file;
    },
  },
];
