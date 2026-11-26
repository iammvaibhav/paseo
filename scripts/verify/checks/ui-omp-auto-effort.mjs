import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "ui-omp-auto-effort",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "An omp agent on auto effort shows the effort OMP picked as a status line under the prompt, and " +
    "the turn stats list that resolved effort instead of auto.",
};

const state = { workspaceId: null, agentId: null, level: null };

async function pollUntil(fetchValue, { timeoutMs = 240_000, intervalMs = 500, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

export const steps = [
  {
    id: "run-auto-turn",
    label: "Run one omp turn on auto effort",
    narrate: "A real omp agent on auto effort answers one prompt.",
    async run(ctx) {
      const client = ctx.host().client;
      const cwd = path.join(ctx.host().home, "projects", "omp-auto-effort");
      await fsp.mkdir(cwd, { recursive: true });
      state.workspaceId = (
        await client.createWorkspace({ source: { kind: "directory", path: cwd } })
      ).workspace?.id;
      ctx.expect(Boolean(state.workspaceId), "workspace created");
      const model = (ctx.stack.commanderModel ?? "").replace(/^omp\//, "");
      ctx.expect(Boolean(model), "stack resolved an omp task model");
      const agent = await client.createAgent({
        provider: "omp",
        model,
        thinkingOptionId: "auto",
        cwd,
        workspaceId: state.workspaceId,
        title: `[${ctx.stack.runId}] auto effort`,
        initialPrompt: "Reply with exactly: ok. Do nothing else.",
      });
      state.agentId = agent.id;

      const entries = await pollUntil(
        async () => {
          const snapshot = client.getAgent?.(agent.id);
          const timeline = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 200,
          });
          const done = timeline.entries.some((entry) => entry.turnMetrics?.length);
          return done && snapshot?.status !== "running" ? timeline.entries : null;
        },
        { description: "the auto-effort turn to finish with turn stats" },
      );
      const items = entries.map((entry) => entry.item);
      const effortIndex = items.findIndex(
        (item) => item.type === "notification" && /^Effort: \S+ \(auto\)$/.test(item.message),
      );
      const promptIndex = items.findIndex((item) => item.type === "user_message");
      ctx.expect(effortIndex >= 0, "timeline has the auto effort status line");
      ctx.expect(
        effortIndex > promptIndex && promptIndex >= 0,
        `effort line (index ${effortIndex}) comes after the prompt (index ${promptIndex})`,
      );
      const effortItem = items[effortIndex];
      state.level = /^Effort: (\S+) \(auto\)$/.exec(effortItem.message)?.[1];
      ctx.expect(
        typeof state.level === "string" && state.level !== "auto",
        `resolved level ${state.level}`,
      );
      const stats = entries.find((entry) => entry.turnMetrics?.length)?.turnMetrics ?? [];
      const effortStat = stats.find((metric) => metric.label === "Effort");
      ctx.expect(
        effortStat?.value === state.level,
        `turn stats Effort=${effortStat?.value}, status line=${state.level}`,
      );
      return `auto resolved to ${state.level}; turn stats: ${JSON.stringify(stats)}`;
    },
  },
  {
    id: "ui",
    label: "The chat shows the effort line and the turn stats show the effort",
    narrate: "Under the prompt the chat says which effort ran, and Turn stats lists it.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      const url = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(state.workspaceId)}?open=agent:${encodeURIComponent(state.agentId)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const prompt = page.getByText("Reply with exactly: ok. Do nothing else.").first();
      const line = page.getByText(`Effort: ${state.level} (auto)`).first();
      await line.waitFor({ state: "visible", timeout: 30_000 });
      const [promptBox, lineBox] = [await prompt.boundingBox(), await line.boundingBox()];
      ctx.expect(
        Boolean(promptBox && lineBox && lineBox.y > promptBox.y),
        `effort line renders below the prompt: ${JSON.stringify({ promptBox, lineBox })}`,
      );
      await ctx.shot("before");
      const trigger = page.locator('[data-testid="turn-metrics-trigger"]:visible').last();
      await trigger.hover();
      await page
        .locator('[data-testid="turn-metrics-details"]')
        .getByText("Effort")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await ctx.shot("after");
      return `effort line and turn stats show ${state.level}`;
    },
  },
];
