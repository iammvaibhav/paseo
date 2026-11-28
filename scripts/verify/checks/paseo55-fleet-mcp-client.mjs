import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  name: "paseo55-fleet-mcp-client",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "A remote /mcp/fleet client drives real omp agents on two hosts: never gated (meta and archive apply, no proposals), turn-bound create/send/wait, fleet_wait_agents, per-agent and group webhooks, paged fleet_get_transcript, cross-host fleet_agent_status, and unknown-argument rejection.",
};

// The MCP SDK and bcryptjs live in the server package, not the repo root.
const serverRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/package.json"),
);
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "paseo55-smoke";
const TOKEN = randomBytes(24).toString("hex");

let mcp;
let webhook;
const received = [];
const agents = {};

async function pollUntil(fetchValue, { timeoutMs = 120_000, intervalMs = 250, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/** Call a tool and return its structured result (throws on isError unless allowError). */
async function call(name, args, { allowError = false } = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
  if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
  return { ...result, text };
}

function proposalCount(home) {
  return fsp
    .readFile(path.join(home, "mission-control", "proposals.jsonl"), "utf8")
    .then((raw) => raw.split("\n").filter(Boolean).length)
    .catch(() => 0);
}

export const steps = [
  {
    id: "connect",
    label: "Register a remote MCP client with a webhook and connect to /mcp/fleet",
    narrate: "A bcrypt-hashed client token and a local webhook receiver are configured.",
    async run(ctx) {
      const commander = ctx.host("commander");
      // bcryptjs is CommonJS: its functions sit on the default export under ESM import.
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      webhook = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        received.push(JSON.parse(raw));
        res.end("{}");
      });
      const listening = Promise.withResolvers();
      webhook.listen(0, "127.0.0.1", () => listening.resolve());
      await listening.promise;
      const hookUrl = `http://127.0.0.1:${webhook.address().port}/hook`;

      const configPath = path.join(commander.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.daemon = config.daemon ?? {};
      config.daemon.mcp = config.daemon.mcp ?? {};
      config.daemon.mcp.remoteClients = [
        { name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4), notify: { url: hookUrl } },
      ];
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
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        "fleet_get_transcript",
        "fleet_wait_agents",
        "fleet_notify_on_finish",
        "fleet_wait_agent",
      ]) {
        ctx.expect(tools.includes(name), `${name} is listed`);
      }
      return `connected; ${tools.length} tools; webhook ${hookUrl}`;
    },
  },
  {
    id: "unknown-args",
    label: "An undeclared argument is rejected with the closest real name",
    narrate: "deliveryMode is refused and the error suggests mode.",
    async run(ctx) {
      const result = await call(
        "fleet_send_prompt",
        { agentId: "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a", prompt: "x", deliveryMode: "queue" },
        { allowError: true },
      );
      ctx.expect(result.isError === true, "the call is an error");
      ctx.expect(
        result.text.includes('did you mean "mode"'),
        `error suggests mode: ${result.text}`,
      );
      return result.text;
    },
  },
  {
    id: "turn-bound-create",
    label: "Create one agent per host; each create returns the turn its prompt runs in",
    narrate:
      "fleet_create_agent on commander and on peer-b, notifyOnFinish armed on the peer agent.",
    async run(ctx) {
      const provider = ctx.stack.commanderModel;
      ctx.expect(Boolean(provider), "stack resolved an omp model");
      const proposalsBefore = await proposalCount(ctx.host("commander").home);
      for (const [key, host] of [
        ["local", "commander"],
        ["peer", "peer-b"],
      ]) {
        const cwd = path.join(ctx.host(host).home, "projects", `paseo55-${key}`);
        await fsp.mkdir(cwd, { recursive: true });
        const created = await call("fleet_create_agent", {
          host,
          cwd,
          isolation: "local",
          provider,
          title: `paseo55 ${key}`,
          initialPrompt: `Reply with exactly: ${key.toUpperCase()}-ONE. Do not use tools.`,
          ...(key === "peer" ? { notifyOnFinish: true, notifyContext: "peer-create" } : {}),
        });
        const sc = created.structuredContent;
        ctx.expect(Boolean(sc.agentId), `${key} agent created`);
        ctx.expect(typeof sc.turnId === "string", `${key} create returned a turnId (${sc.turnId})`);
        if (key === "peer") {
          ctx.expect(sc.notify?.armed === true, "notifyOnFinish armed on the peer create");
        }
        agents[key] = { agentId: sc.agentId, host, firstTurn: sc.turnId };
      }
      ctx.expect(
        (await proposalCount(ctx.host("commander").home)) === proposalsBefore,
        "no proposal was recorded for MCP spawns",
      );
      return JSON.stringify(agents);
    },
  },
  {
    id: "wait-all",
    label: "fleet_wait_agents all returns both first turns",
    narrate: "Both agents finish their first turn; results carry the create turnIds.",
    async run(ctx) {
      const result = await call("fleet_wait_agents", {
        agents: Object.values(agents).map(({ agentId, host, firstTurn }) => ({
          agentId,
          host,
          turnId: firstTurn,
        })),
        mode: "all",
        timeoutSeconds: 600,
      });
      const sc = result.structuredContent;
      ctx.expect(sc.done === true, "all agents finished");
      for (const [key, agent] of Object.entries(agents)) {
        const entry = sc.results.find((r) => r.agentId === agent.agentId);
        ctx.expect(entry?.turnId === agent.firstTurn, `${key} result bound to its create turn`);
        ctx.expect(
          (entry?.lastMessage ?? "").includes(`${key.toUpperCase()}-ONE`),
          `${key} last message is its first answer: ${entry?.lastMessage}`,
        );
      }
      const hook = await pollUntil(
        () => received.find((event) => event.context === "peer-create"),
        { description: "the peer create webhook" },
      );
      ctx.expect(hook.type === "paseo.agent.finished", "peer create posted paseo.agent.finished");
      ctx.expect(hook.agent.turnId === agents.peer.firstTurn, "webhook carries the create turnId");
      return `both done; webhook for ${hook.agent.id}`;
    },
  },
  {
    id: "turn-bound-send",
    label:
      "A follow-up send binds to a new turn; waiting on the old turn never returns the new one",
    narrate: "The old turnId returns ONE at once; the new turnId returns TWO.",
    async run(ctx) {
      const sent = await call("fleet_send_prompt", {
        agentId: agents.peer.agentId,
        prompt: "Reply with exactly: PEER-TWO. Do not use tools.",
      });
      const newTurn = sent.structuredContent.turnId;
      ctx.expect(typeof newTurn === "string", `send returned a turnId (${newTurn})`);
      ctx.expect(newTurn !== agents.peer.firstTurn, "the follow-up runs in a new turn");
      const old = await call("fleet_wait_agent", {
        agentId: agents.peer.agentId,
        turnId: agents.peer.firstTurn,
        timeoutSeconds: 60,
      });
      ctx.expect(old.structuredContent.finished === true, "old turn reports finished");
      ctx.expect(
        (old.structuredContent.lastMessage ?? "").includes("PEER-ONE"),
        `old turn keeps its own answer: ${old.structuredContent.lastMessage}`,
      );
      const fresh = await call("fleet_wait_agent", {
        agentId: agents.peer.agentId,
        turnId: newTurn,
        timeoutSeconds: 600,
      });
      ctx.expect(fresh.structuredContent.turnId === newTurn, "new wait bound to the new turn");
      ctx.expect(
        (fresh.structuredContent.lastMessage ?? "").includes("PEER-TWO"),
        `new turn answer: ${fresh.structuredContent.lastMessage}`,
      );
      agents.peer.secondTurn = newTurn;
      return `old ${agents.peer.firstTurn} → ONE, new ${newTurn} → TWO`;
    },
  },
  {
    id: "transcript",
    label: "fleet_get_transcript pages the peer agent's full transcript",
    narrate: "Paging older two entries at a time returns every entry once, newest page first.",
    async run(ctx) {
      const seqs = [];
      let page = (await call("fleet_get_transcript", { agentId: agents.peer.agentId, limit: 2 }))
        .structuredContent;
      ctx.expect(page.ok === true && page.host === "peer-b", "transcript read from peer-b");
      for (let guard = 0; guard < 100; guard += 1) {
        seqs.push(...page.entries.map((entry) => entry.seq));
        if (!page.olderCursor) break;
        page = (
          await call("fleet_get_transcript", {
            agentId: agents.peer.agentId,
            limit: 2,
            cursor: page.olderCursor,
          })
        ).structuredContent;
      }
      ctx.expect(new Set(seqs).size === seqs.length, "no entry returned twice");
      const turn = (
        await call("fleet_get_transcript", {
          agentId: agents.peer.agentId,
          turnId: agents.peer.secondTurn,
          limit: 200,
        })
      ).structuredContent;
      const texts = turn.entries.map((entry) => entry.item.text ?? "").join(" | ");
      ctx.expect(texts.includes("PEER-TWO"), `second turn holds the prompt and answer: ${texts}`);
      ctx.expect(
        turn.entries.every((entry) => entry.turnId === agents.peer.secondTurn),
        "turnId filter keeps only that turn",
      );
      return `${seqs.length} entries paged; second turn: ${turn.entries.length} entries`;
    },
  },
  {
    id: "status-cross-host",
    label: "fleet_agent_status reads a peer agent's status from the commander host",
    narrate: "The status comes back with host peer-b.",
    async run(ctx) {
      const status = (await call("fleet_agent_status", { agentId: agents.peer.agentId }))
        .structuredContent;
      ctx.expect(status.host === "peer-b", `status host is peer-b (${status.host})`);
      ctx.expect(status.agentId === agents.peer.agentId, "status is for the peer agent");
      return `bucket ${status.bucket}`;
    },
  },
  {
    id: "group-notify",
    label: "fleet_notify_on_finish group posts one event once both agents finish",
    narrate: "Two sends, one group webhook carrying both turnIds.",
    async run(ctx) {
      const turns = [];
      for (const [key, agent] of Object.entries(agents)) {
        const sent = await call("fleet_send_prompt", {
          agentId: agent.agentId,
          prompt: `Reply with exactly: ${key.toUpperCase()}-GROUP. Do not use tools.`,
        });
        turns.push({ agentId: agent.agentId, turnId: sent.structuredContent.turnId });
      }
      const armed = await call("fleet_notify_on_finish", {
        agents: turns,
        group: true,
        perAgent: false,
        notifyContext: "group-check",
      });
      ctx.expect(Boolean(armed.structuredContent.groupId), "group armed");
      const group = await pollUntil(
        () => received.find((event) => event.type === "paseo.agents.group_finished"),
        { timeoutMs: 600_000, description: "the group webhook" },
      );
      ctx.expect(group.context === "group-check", "group webhook echoes the context");
      for (const { agentId, turnId } of turns) {
        const entry = group.agents.find((agent) => agent.id === agentId);
        ctx.expect(entry?.turnId === turnId, `group entry for ${agentId} carries its turn`);
      }
      ctx.expect(
        !received.some(
          (event) => event.type === "paseo.agent.finished" && event.context === "group-check",
        ),
        "perAgent:false sent no per-agent events",
      );
      return `group ${group.groupId} with ${group.agents.length} agents`;
    },
  },
  {
    id: "ungated-meta",
    label: "Rename and archive apply directly with no proposal",
    narrate:
      "A rename on peer-b and an archive on commander return applied; the proposal store is untouched.",
    async run(ctx) {
      const home = ctx.host("commander").home;
      const before = await proposalCount(home);
      const rename = await call("fleet_rename_agent_title", {
        agentId: agents.peer.agentId,
        title: "paseo55 renamed",
      });
      ctx.expect(rename.structuredContent.status === "applied", `rename applied: ${rename.text}`);
      for (const agent of Object.values(agents)) {
        const archive = await call("fleet_archive_agent", { agentId: agent.agentId });
        ctx.expect(
          archive.structuredContent.status === "applied",
          `archive applied: ${archive.text}`,
        );
      }
      ctx.expect((await proposalCount(home)) === before, "no proposal recorded");
      return "rename + 2 archives applied, 0 proposals";
    },
  },
  {
    id: "cleanup",
    label: "Close the MCP client and webhook receiver",
    narrate: "Test client and receiver closed.",
    async run() {
      await mcp?.close();
      webhook?.close();
      return "closed";
    },
  },
];
