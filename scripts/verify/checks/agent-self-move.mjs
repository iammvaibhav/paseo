import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "agent-self-move",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "A real omp agent moves itself with fleet_move_agent mid-turn: the move lands when the turn ends and the next turn runs in the new workspace directory.",
};

async function pollUntil(fetchValue, { timeoutMs = 60000, intervalMs = 250, description }) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

let agentId;
let dirA;
let dirB;
let wsA;
let wsB;

export const steps = [
  {
    id: "setup",
    label: "Create two workspaces and an omp agent in the first",
    narrate: "Two directory workspaces; a real omp agent starts in workspace A.",
    async run(ctx) {
      const client = ctx.host().client;
      dirA = path.join(ctx.host().home, "projects", "self-move-a");
      dirB = path.join(ctx.host().home, "projects", "self-move-b");
      await fsp.mkdir(dirA, { recursive: true });
      await fsp.mkdir(dirB, { recursive: true });
      wsA = (await client.createWorkspace({ source: { kind: "directory", path: dirA } })).workspace
        ?.id;
      wsB = (await client.createWorkspace({ source: { kind: "directory", path: dirB } })).workspace
        ?.id;
      ctx.expect(Boolean(wsA && wsB), "both workspaces created");

      const model = (ctx.stack.commanderModel ?? "").replace(/^omp\//, "");
      ctx.expect(Boolean(model), "stack resolved an omp task model");
      const agent = await client.createAgent({
        provider: "omp",
        model,
        cwd: dirA,
        workspaceId: wsA,
        title: "self-move check",
      });
      agentId = agent.id;
      ctx.expect(Boolean(agentId), "agent created");
      return `agent ${agentId} (${model}) in ${wsA}; target ${wsB}`;
    },
  },
  {
    id: "self-move",
    label: "Agent calls fleet_move_agent on itself mid-turn",
    narrate: "The tool schedules the move; it lands once the turn ends.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.sendAgentMessage(
        agentId,
        `Call the fleet_move_agent tool with workspaceId "${wsB}" and no agentId, to move yourself. ` +
          "Do nothing else. Then reply with the single word MOVED.",
      );
      const finished = await client.waitForFinish(agentId, 240000);
      ctx.expect(finished.status === "idle", `turn ended idle (got ${finished.status})`);

      const timeline = JSON.stringify(await client.fetchAgentTimeline(agentId, { limit: 200 }));
      ctx.expect(timeline.includes("fleet_move_agent"), "agent called fleet_move_agent");
      ctx.expect(timeline.includes("scheduled"), "tool result reported the move as scheduled");

      const moved = await pollUntil(
        async () => {
          const agent = (await client.fetchAgent(agentId))?.agent;
          return agent?.workspaceId === wsB ? agent : null;
        },
        { description: `agent to land in ${wsB}` },
      );
      ctx.expect(path.resolve(moved.cwd) === path.resolve(dirB), `agent cwd is ${dirB}`);
      return `moved to ${moved.workspaceId} at ${moved.cwd}`;
    },
  },
  {
    id: "runs-in-new-cwd",
    label: "Next turn runs in the new workspace directory",
    narrate: "The provider session restarted in workspace B, so pwd prints its directory.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.sendAgentMessage(
        agentId,
        "Run `pwd` with your bash tool and reply with only its output, nothing else.",
      );
      const finished = await client.waitForFinish(agentId, 240000);
      ctx.expect(finished.status === "idle", `turn ended idle (got ${finished.status})`);
      const reply = finished.lastMessage ?? "";
      ctx.expect(reply.includes(dirB), `pwd reply names ${dirB} (got ${JSON.stringify(reply)})`);
      return `pwd -> ${reply.trim()}`;
    },
  },
];
