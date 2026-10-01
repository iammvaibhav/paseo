export const meta = {
  name: "automations",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Unified automations facade: schedule automation runs once, webhook automation tests a delivery, and the exactly-once claim store blocks a duplicate fire for the same poll event.",
};

const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";

async function createMockAgent(ctx, { title }) {
  const client = ctx.host().client;
  const agent = await client.createAgent({
    provider: MOCK_PROVIDER,
    model: FAST_MODEL,
    cwd: ctx.fixtureRepo,
    title: `${title} [${ctx.stack.runId}]`,
    initialPrompt: "Automations verification run; finish quickly.",
  });
  ctx.expect(Boolean(agent?.id), `mock agent created, got ${JSON.stringify(agent)}`);
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);
  return agent.id;
}

async function automation(client, method, params = {}) {
  const payload = await client[method](params);
  if (payload.error !== null && payload.error !== undefined) {
    throw new Error(`${method} failed: ${payload.error}`);
  }
  return payload;
}

export const steps = [
  {
    id: "feature",
    label: "Daemon advertises features.automations",
    narrate: "server_info carries the automations feature flag.",
    async run(ctx) {
      const features = ctx.host().client.getLastServerInfoMessage()?.features ?? {};
      ctx.expect(features.automations === true, `features.automations is ${features.automations}`);
      return "features.automations = true";
    },
  },
  {
    id: "schedule-run",
    label: "Schedule automation runs once against a mock agent",
    narrate: "A schedule automation fires one run on its agent target.",
    async run(ctx) {
      const client = ctx.host().client;
      const agentId = await createMockAgent(ctx, { title: "Automations schedule target" });
      ctx.scheduleAgentId = agentId;
      const created = await automation(client, "automationCreate", {
        name: `verify-schedule [${ctx.stack.runId}]`,
        kind: "schedule",
        target: { type: "agent", agentId },
        promptTemplate: "Verify schedule ping {{event.title}}",
        schedule: { cadence: { type: "every", everyMs: 3_600_000 } },
      });
      const automationId = created.automation?.id;
      ctx.expect(Boolean(automationId), "schedule automation created with an id");
      ctx.scheduleAutomationId = automationId;
      const ran = await automation(client, "automationRun", { id: automationId });
      ctx.expect(Boolean(ran.run), "schedule automation.run returned a run");
      ctx.expect(
        ran.run.agentId === agentId,
        `run targeted the mock agent ${agentId}, got ${ran.run.agentId}`,
      );
      return `schedule ${automationId} ran on ${ran.run.agentId}`;
    },
  },
  {
    id: "webhook-run",
    label: "Webhook automation tests a delivery against a mock agent",
    narrate: "A webhook automation test-fires one delivery to its agent.",
    async run(ctx) {
      const client = ctx.host().client;
      const agentId = ctx.scheduleAgentId;
      const created = await automation(client, "automationCreate", {
        name: `verify-webhook [${ctx.stack.runId}]`,
        kind: "webhook",
        target: { type: "agent", agentId },
        promptTemplate: "Verify webhook ping {{payload.hello}}",
      });
      const automationId = created.automation?.id;
      ctx.expect(Boolean(automationId), "webhook automation created with an id");
      ctx.webhookAutomationId = automationId;
      const ran = await automation(client, "automationRun", {
        id: automationId,
        samplePayload: JSON.stringify({ hello: "world" }),
      });
      ctx.expect(Boolean(ran.run), "webhook automation.run returned a run");
      ctx.expect(
        ran.run.agentId === agentId,
        `delivery targeted the mock agent ${agentId}, got ${ran.run.agentId}`,
      );
      return `webhook ${automationId} delivered to ${ran.run.agentId}`;
    },
  },
  {
    id: "poll-claim",
    label: "GitHub poll automation runs with exactly-once claims",
    narrate:
      "A github automation creates, inspects, ticks with no backfill, and the shipped claim store blocks duplicates.",
    async run(ctx) {
      const client = ctx.host().client;
      const agentId = ctx.scheduleAgentId;
      const created = await automation(client, "automationCreate", {
        name: `verify-poll [${ctx.stack.runId}]`,
        kind: "github",
        target: { type: "agent", agentId },
        promptTemplate: "Verify poll ping {{event.title}}",
        poll: { repos: ["acme/web"], events: ["issue_opened", "labelled"] },
      });
      const automationId = created.automation?.id;
      ctx.expect(Boolean(automationId), "github automation created with an id");
      ctx.expect(
        automationId.startsWith("poll:"),
        `poll automation id is namespaced, got ${automationId}`,
      );
      ctx.pollAutomationId = automationId;
      const inspected = await automation(client, "automationInspect", { id: automationId });
      ctx.expect(
        inspected.automation?.kind === "github",
        "poll automation inspects back as github",
      );
      ctx.expect(
        inspected.automation?.poll?.hasToken === false,
        "poll automation reports hasToken=false without a secret",
      );
      const status = await client.automationStatus();
      ctx.expect(status.error === null, `automationStatus has no error, got ${status.error}`);
      ctx.expect(
        typeof status.claimsDurable === "boolean",
        `status reports claimsDurable, got ${status.claimsDurable}`,
      );
      ctx.expect(
        typeof status.github?.cliPresent === "boolean" &&
          typeof status.github?.authenticated === "boolean",
        "status reports github cliPresent/authenticated without secrets",
      );
      // No backfill: creating the automation seeds claims for current items,
      // so an immediate tick fires nothing, twice in a row.
      const first = await automation(client, "automationRun", { id: automationId });
      const second = await automation(client, "automationRun", { id: automationId });
      ctx.expect(
        first.run === null,
        `first tick fires nothing new, got ${JSON.stringify(first.run)}`,
      );
      ctx.expect(
        second.run === null,
        `second tick fires nothing new, got ${JSON.stringify(second.run)}`,
      );
      const after = await automation(client, "automationInspect", { id: automationId });
      ctx.expect(
        (after.automation?.recentRuns ?? []).length === 0,
        "no duplicate poll run recorded",
      );
      // The shipped claim store behind the daemon: file-backed claims fire
      // once per (automation, event), independently per automation, and
      // dropAutomation releases the key.
      const { mkdtempSync } = await import("node:fs");
      const { mkdir } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { dirname, join } = await import("node:path");
      const { AutomationClaimStore } =
        await import("../../../packages/server/dist/server/server/automation/claim-store.js");
      const dir = mkdtempSync(join(tmpdir(), "paseo-automation-claims-"));
      const store = await AutomationClaimStore.open({
        dbPath: join(dir, "claims.db"),
        execMkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
        dirname,
        logger: { info: () => {}, warn: () => {} },
      });
      const key = `verify:${ctx.stack.runId}:github:issue:acme/web:12`;
      ctx.expect(store.claim("verify-auto", key, Date.now()) === true, "first claim fires");
      ctx.expect(
        store.claim("verify-auto", key, Date.now()) === false,
        "duplicate claim is skipped",
      );
      ctx.expect(
        store.claim("verify-other", key, Date.now()) === true,
        "another automation claims independently",
      );
      store.dropAutomation("verify-auto");
      ctx.expect(
        store.claim("verify-auto", key, Date.now()) === true,
        "deleted automation releases its claims",
      );
      return `poll ${automationId} no-backfill twice, claimsDurable=${status.claimsDurable}, duplicate blocked`;
    },
  },
  {
    id: "cleanup",
    label: "Verification automations are deleted",
    narrate: "Schedule, webhook and poll rows created by the check are removed.",
    async run(ctx) {
      const client = ctx.host().client;
      await automation(client, "automationDelete", { id: ctx.scheduleAutomationId });
      await automation(client, "automationDelete", { id: ctx.webhookAutomationId });
      await automation(client, "automationDelete", { id: ctx.pollAutomationId });
      const listed = await automation(client, "automationList");
      const leftovers = (listed.automations ?? []).filter((item) =>
        (item.name ?? "").includes(ctx.stack.runId),
      );
      ctx.expect(leftovers.length === 0, `no verify automations remain, got ${leftovers.length}`);
      return "verify automations deleted";
    },
  },
];
