import fs from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "mission-control-inbox",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "mission_control.inbox.fetch serves pending proposals, the Commander's open clarifications, and ready-agent review facts from stored state.",
};

const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";
const COMMANDER_LABEL_KEY = "paseo.mission-control";
const COMMANDER_LABEL_VALUE = "commander";
const ADOPTED_AT_LABEL = "paseo.commander-adopted-at";
const PROOF = { kind: "url", url: "https://example.com/inbox-proof", label: "inbox proof" };

async function pollFor(fetchValue, { timeoutMs = 120_000, intervalMs = 1000, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${Date.now() - start}ms waiting for ${description}`);
}

/**
 * Call a Paseo MCP tool as the given agent (the same loopback endpoint and
 * callerAgentId scoping the daemon injects into its agents). The endpoint is
 * stateless streamable HTTP: one JSON-RPC request per POST, SSE-framed reply.
 */
async function callAgentTool(ctx, agentId, name, args) {
  const url = new URL("/mcp/agents", ctx.host().httpUrl);
  url.searchParams.set("callerAgentId", agentId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(ctx.password ? { authorization: `Bearer ${ctx.password}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  ctx.expect(response.ok, `MCP ${name} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  const dataLine = text.split("\n").findLast((line) => line.startsWith("data:"));
  const message = JSON.parse(dataLine ? dataLine.slice("data:".length) : text);
  ctx.expect(!message.error, `MCP ${name} error: ${JSON.stringify(message.error)}`);
  ctx.expect(
    message.result?.isError !== true,
    `MCP ${name} tool error: ${JSON.stringify(message.result)}`,
  );
  return message.result?.structuredContent ?? {};
}

async function createMockAgent(ctx, { title, labels }) {
  const client = ctx.host().client;
  const agent = await client.createAgent({
    provider: MOCK_PROVIDER,
    model: FAST_MODEL,
    cwd: ctx.fixtureRepo,
    workspaceId: ctx.inboxWorkspaceId,
    title: `${title} [${ctx.stack.runId}]`,
    ...(labels ? { labels } : {}),
    initialPrompt: "Inbox verification run; finish quickly.",
  });
  ctx.expect(Boolean(agent?.id), `mock agent created, got ${JSON.stringify(agent)}`);
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);
  return agent.id;
}

export const steps = [
  {
    id: "feature",
    label: "Daemon advertises the inbox capability",
    narrate: "server_info carries missionControlInbox.",
    async run(ctx) {
      const features = ctx.host().client.getLastServerInfoMessage()?.features ?? {};
      ctx.expect(
        features.missionControlInbox === true,
        `features.missionControlInbox is ${features.missionControlInbox}`,
      );
      return "features.missionControlInbox = true";
    },
  },
  {
    id: "seed-ready-agents",
    label: "Two mock agents finish and report completed over report_status",
    narrate: "A hand-started worker reports one proof; an adopted worker reports none.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: "Inbox verification",
      });
      ctx.inboxWorkspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(ctx.inboxWorkspaceId), `workspace created: ${workspace.error ?? ""}`);

      ctx.workerId = await createMockAgent(ctx, { title: "Inbox worker" });
      ctx.adoptedId = await createMockAgent(ctx, {
        title: "Inbox adopted worker",
        labels: { [ADOPTED_AT_LABEL]: new Date().toISOString() },
      });

      const worker = await callAgentTool(ctx, ctx.workerId, "report_status", {
        status: "completed",
        headline: "Inbox worker done",
        description: "Seeds a ready item with one proof for the inbox check.",
        proofs: [PROOF],
      });
      ctx.expect(worker.ok === true, `worker report_status ok, got ${JSON.stringify(worker)}`);
      const adopted = await callAgentTool(ctx, ctx.adoptedId, "report_status", {
        status: "completed",
        headline: "Adopted worker done",
        description: "Seeds a Commander-adopted ready item without proofs.",
      });
      ctx.expect(adopted.ok === true, `adopted report_status ok, got ${JSON.stringify(adopted)}`);
      return `worker ${ctx.workerId}, adopted ${ctx.adoptedId}`;
    },
  },
  {
    id: "seed-proposal",
    label: "Seed a pending proposal in the approval index",
    narrate: "A pending proposal card targets the worker.",
    async run(ctx) {
      const result = await ctx.host().client.missionControlProposalsCreate({
        message: "Inbox verification: continue with the follow-up.",
        reason: "Inbox verification",
        targetAgentId: ctx.workerId,
      });
      ctx.expect(result.ok && Boolean(result.proposalId), `proposal created: ${result.error}`);
      ctx.proposalId = result.proposalId;
      return `proposal ${ctx.proposalId}`;
    },
  },
  {
    id: "seed-clarification",
    label: "The Commander posts a clarification card",
    narrate: "An open clarification on the Commander host.",
    async run(ctx) {
      if (ctx.stack.commander?.enabled === false) {
        return "SKIP: commander disabled (--no-commander)";
      }
      const client = ctx.host().client;
      // Wait for the booted Commander to go idle: its launch prompt (a user
      // message) must land before the card, or the card reads as answered.
      const commander = await pollFor(
        async () => {
          const roster = await client.fetchAgents({
            filter: { labels: { [COMMANDER_LABEL_KEY]: COMMANDER_LABEL_VALUE } },
            page: { limit: 10 },
          });
          const agent = roster.entries.find((entry) => entry.agent?.id)?.agent;
          return agent && agent.status !== "running" && agent.status !== "initializing"
            ? agent
            : null;
        },
        { description: "an idle Commander" },
      );
      ctx.commanderId = commander.id;
      const result = await client.missionControlToolsExecute({
        name: "clarify",
        args: { question: "Inbox verification: which host?", options: ["commander", "peer"] },
      });
      ctx.expect(result.ok, `clarify ok, got ${JSON.stringify(result)}`);
      ctx.clarificationId = result.structuredContent?.eventId;
      ctx.expect(Boolean(ctx.clarificationId), "clarify returned the card's event id");
      return `commander ${ctx.commanderId}, clarification ${ctx.clarificationId}`;
    },
  },
  {
    id: "fetch-inbox",
    label: "mission_control.inbox.fetch returns the seeded state",
    narrate: "The inbox lists the proposal, the clarification, and both review facts.",
    async run(ctx) {
      const inbox = await ctx.host().client.missionControlInboxFetch();
      await fs.mkdir(ctx.artifactsDir, { recursive: true });
      const artifact = path.join(ctx.artifactsDir, "inbox-response.json");
      await fs.writeFile(artifact, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");

      ctx.expect(
        inbox.pendingProposals.every((row) => row.status === "pending" && row.verboseOnly !== true),
        "every pending proposal is pending and not verbose-only",
      );
      const proposal = inbox.pendingProposals.find((row) => row.id === ctx.proposalId);
      ctx.expect(Boolean(proposal), `seeded proposal ${ctx.proposalId} is listed`);
      ctx.expect(proposal.targetAgentId === ctx.workerId, "proposal targets the worker");

      const byAgent = new Map(inbox.review.map((fact) => [fact.agentId, fact]));
      const worker = byAgent.get(ctx.workerId);
      ctx.expect(Boolean(worker), `worker ${ctx.workerId} has a review fact`);
      ctx.expect(worker.reviewState === "ready", `worker reviewState ${worker.reviewState}`);
      ctx.expect(worker.proofCount === 1, `worker proofCount ${worker.proofCount}, want 1`);
      ctx.expect(worker.dispatched === false, "hand-started worker is not dispatched");
      ctx.expect(worker.insufficientVerdict === undefined, "worker has no insufficient verdict");
      ctx.expect(Number.isFinite(Date.parse(worker.readyAt)), `readyAt ${worker.readyAt} is ISO`);
      const adopted = byAgent.get(ctx.adoptedId);
      ctx.expect(Boolean(adopted), `adopted ${ctx.adoptedId} has a review fact`);
      ctx.expect(adopted.dispatched === true, "Commander-adopted worker is dispatched");
      ctx.expect(adopted.proofCount === 0, `adopted proofCount ${adopted.proofCount}, want 0`);

      if (ctx.commanderId) {
        ctx.expect(!byAgent.has(ctx.commanderId), "the Commander never gets a review fact");
        ctx.expect(
          inbox.openClarifications.every(
            (row) => row.kind === "clarification" && row.agentId === ctx.commanderId,
          ),
          "open clarifications are the Commander's clarification cards",
        );
        ctx.expect(
          inbox.openClarifications.some((row) => row.id === ctx.clarificationId),
          `clarification ${ctx.clarificationId} is open`,
        );
      }
      return (
        `${inbox.pendingProposals.length} pending, ${inbox.openClarifications.length} open ` +
        `clarifications, ${inbox.review.length} review facts; response at ${artifact}`
      );
    },
  },
];
