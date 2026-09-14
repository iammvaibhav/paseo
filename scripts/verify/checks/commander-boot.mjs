import path from "node:path";

export const meta = {
  name: "commander-boot",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Asserts the fleet Commander boots on the designated host with the configured model.",
};

const COMMANDER_LABEL_KEY = "paseo.mission-control";
const COMMANDER_LABEL_VALUE = "commander";

function skipWhenDisabled(ctx) {
  if (ctx.stack.commander?.enabled === false) {
    return "SKIP: commander disabled (--no-commander)";
  }
  return null;
}

async function pollFor(
  fetchValue,
  { timeoutMs = 120000, intervalMs = 2000, description = "condition" } = {},
) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${Date.now() - start}ms waiting for ${description}`);
}

async function listCommander(client) {
  const res = await client.missionControlToolsExecute({ name: "fleet_list_agents", args: {} });
  const agents = res.structuredContent?.agents ?? res.agents ?? [];
  return agents.find(
    (agent) => agent.labels?.[COMMANDER_LABEL_KEY] === COMMANDER_LABEL_VALUE && !agent.archivedAt,
  );
}

function daemonLogRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON log line; ignore.
    }
  }
  return records;
}

export const steps = [
  {
    id: "commander-agent",
    label: "Commander agent boots with the commander label",
    narrate: "Fleet Commander is live and labeled.",
    async run(ctx) {
      const skipped = skipWhenDisabled(ctx);
      if (skipped) {
        return skipped;
      }
      const client = ctx.host().client;
      const agent = await pollFor(() => listCommander(client), {
        description: "commander-labeled agent in fleet_list_agents",
      });
      ctx.commanderAgent = agent;
      return `commander ${agent.id} (${agent.provider}/${agent.model})`;
    },
  },
  {
    id: "commander-model",
    label: "Commander launched with the configured model",
    narrate: "Boot spawn line names the stack commander model.",
    async run(ctx) {
      const skipped = skipWhenDisabled(ctx);
      if (skipped) {
        return skipped;
      }
      const agent = ctx.commanderAgent;
      ctx.expect(Boolean(agent), "Commander agent found by the previous step");
      const expectedProvider = String(ctx.stack.commanderModel).split("/")[0];
      ctx.expect(
        agent.provider === expectedProvider,
        `Commander provider is ${agent.provider}, want ${expectedProvider}`,
      );
      const expectedModel = String(ctx.stack.commanderModel).replace(/^[^/]+\//, "");
      const log = await ctx.readDaemonLog();
      const spawned = daemonLogRecords(log).find(
        (record) =>
          record.msg === "mission_control.commander.spawned" && record.agentId === agent.id,
      );
      ctx.expect(
        Boolean(spawned),
        `daemon.log has a mission_control.commander.spawned line for ${agent.id}`,
      );
      ctx.expect(
        spawned.model === expectedModel,
        `Spawned model is ${spawned.model}, want ${expectedModel}`,
      );
      return `spawned with ${spawned.model} (effective ${agent.model})`;
    },
  },
  {
    id: "commander-home",
    label: "Commander runs from the reserved home workspace",
    narrate: "Commander cwd is the reserved per-host home.",
    async run(ctx) {
      const skipped = skipWhenDisabled(ctx);
      if (skipped) {
        return skipped;
      }
      const agent = ctx.commanderAgent;
      ctx.expect(Boolean(agent), "Commander agent found by the first step");
      const reservedHome = path.join(ctx.host().home, "commander");
      ctx.expect(
        agent.cwd === reservedHome,
        `Commander cwd is ${agent.cwd}, want reserved home ${reservedHome}`,
      );
      return `cwd ${agent.cwd}`;
    },
  },
  {
    id: "boot-log",
    label: "Boot log shows commander ensured, never deferred",
    narrate: "Daemon boot ensured the Commander exactly once.",
    async run(ctx) {
      const skipped = skipWhenDisabled(ctx);
      if (skipped) {
        return skipped;
      }
      const agent = ctx.commanderAgent;
      ctx.expect(Boolean(agent), "Commander agent found by the first step");
      const log = await pollFor(
        async () => {
          const text = await ctx.readDaemonLog();
          const ensured = daemonLogRecords(text).find(
            (record) =>
              record.msg === "mission_control.commander.ensured" && record.agentId === agent.id,
          );
          return ensured || null;
        },
        { timeoutMs: 30000, description: "mission_control.commander.ensured line" },
      );
      ctx.expect(Boolean(log), "daemon.log has mission_control.commander.ensured for the agent");
      const fullLog = await ctx.readDaemonLog();
      ctx.expect(
        !fullLog.includes("mission_control.boot.ensure_failed"),
        "daemon.log has no mission_control.boot.ensure_failed line",
      );
      return "ensured on boot, boot ensure never failed";
    },
  },
];
