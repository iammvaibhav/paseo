import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// A real omp agent following the fleet-browser skill on prod's Chrome: it opens
// its window with fleet_browser_open, is told mid-turn that the user took
// control (steered, not interrupted), stops, and after Hand back continues on
// the page the user left and closes its window. Needs NetBird, agent-browser,
// the fleet-browser skill in ~/.agents/skills and omp credentials.

export const meta = {
  name: "fleet-browser-agent",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "A real agent opens a fleet browser window through the skill's Paseo tools, pauses when the user takes control mid-turn, resumes from the page the user left with their note, and closes its window.",
};

const execFileAsync = promisify(execFile);
const MODEL = process.env.FLEET_BROWSER_AGENT_MODEL ?? "anthropic/claude-sonnet-5-5";
const FLEET_BROWSER = {
  hosts: {
    prod: {
      cdpUrl: "http://100.123.97.105:9223",
      liveViewUrl: "https://prod.chrome.thevm.space",
      purpose: "testing our own apps",
    },
  },
};
const LABEL = "E2E agent check";
const state = { workspaceId: null, agentId: null, window: null };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate, { timeoutMs = 60_000, intervalMs = 1_000, description }) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function fleetBrowser(ctx, type, params) {
  const payload = await ctx.host().client.fleetBrowserRequest(type, params);
  if (payload.error !== null) throw new Error(`${type} failed: ${payload.error}`);
  return payload;
}

async function windows(ctx) {
  return (
    await fleetBrowser(ctx, "fleet_browser.windows.list.request", {
      workspaceId: state.workspaceId,
    })
  ).windows;
}

async function agentStatus(ctx) {
  const result = await ctx.host().client.fetchAgentTimeline(state.agentId, { limit: 1 });
  return result.agent?.status ?? null;
}

async function timeline(ctx) {
  const result = await ctx.host().client.fetchAgentTimeline(state.agentId, { limit: 400 });
  return result.entries ?? [];
}

export const steps = [
  {
    id: "seed",
    label: "An omp agent is asked to browse with the fleet browser",
    narrate: "The agent gets a task that needs a browser and a pause in the middle.",
    async run(ctx) {
      const client = ctx.host().client;
      await fsp.writeFile(
        path.join(ctx.host().home, "fleet-browser.json"),
        JSON.stringify(FLEET_BROWSER),
      );
      await sleep(6_000);
      const dir = await fsp.mkdtemp(path.join(ctx.host().home, "fleet-browser-agent-"));
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: dir },
        title: `Fleet browser agent [${ctx.stack.runId}]`,
      });
      state.workspaceId = workspace.workspace?.id;
      const agent = await client.createAgent({
        provider: "omp",
        model: MODEL,
        cwd: dir,
        workspaceId: state.workspaceId,
        title: `Fleet browser agent [${ctx.stack.runId}]`,
        initialPrompt: [
          "Use the fleet-browser skill. Open a fresh window on the prod fleet browser at https://example.com",
          `with the label "${LABEL}". Then run \`sleep 40\` in bash (I am testing something meanwhile).`,
          "After the sleep, report the window's current URL and page title, then close the window.",
        ].join(" "),
      });
      state.agentId = agent.id;
      return `agent ${agent.id} on ${MODEL}`;
    },
  },
  {
    id: "agent-opens",
    label: "The agent opens its window with fleet_browser_open",
    narrate: "The daemon registers the window as the agent's.",
    async run(ctx) {
      state.window = await pollUntil(
        async () => (await windows(ctx)).find((window) => window.label === LABEL) ?? null,
        { timeoutMs: 180_000, description: "the agent's window" },
      );
      ctx.expect(state.window.agentId === state.agentId, "window belongs to the agent");
      return `window ${state.window.id} session ${state.window.session} at ${state.window.url}`;
    },
  },
  {
    id: "take-over-mid-turn",
    label: "Taking control mid-turn steers a takeover notice into the running agent",
    narrate: "The agent is still running; the notice joins its turn without interrupting it.",
    async run(ctx) {
      await pollUntil(async () => (await agentStatus(ctx)) === "running", {
        timeoutMs: 30_000,
        description: "agent running (in its sleep)",
      });
      const result = await fleetBrowser(ctx, "fleet_browser.window.control.request", {
        windowId: state.window.id,
        action: "take",
      });
      ctx.expect(result.delivery === "steered", `takeover delivery ${result.delivery}`);
      // The user moves to another page while in control.
      await execFileAsync("agent-browser", [
        "--session",
        state.window.session,
        "open",
        "https://www.iana.org/help/example-domains",
      ]);
      await pollUntil(async () => (await agentStatus(ctx)) === "idle", {
        timeoutMs: 180_000,
        description: "agent ends its turn after the takeover",
      });
      const still = (await windows(ctx)).find((window) => window.id === state.window.id);
      ctx.expect(Boolean(still), "the agent left its window open while paused");
      ctx.expect(still.control.owner === "user", "the user still has control");
      const items = await timeline(ctx);
      ctx.expect(
        JSON.stringify(items).includes("Browser takeover"),
        "takeover notice in the timeline",
      );
      const reply =
        items.findLast((entry) => entry.item?.type === "assistant_message")?.item.text ?? "";
      return `agent paused with the window open; it said: ${reply.slice(0, 400)}`;
    },
  },
  {
    id: "hand-back",
    label:
      "Hand back resumes the agent, which continues from the user's page and closes the window",
    narrate:
      "The resume notice starts a turn; the agent reports the IANA page and closes its window.",
    async run(ctx) {
      const result = await fleetBrowser(ctx, "fleet_browser.window.control.request", {
        windowId: state.window.id,
        action: "resume",
        note: "I opened the IANA page about example domains; report that page instead.",
      });
      ctx.expect(result.delivery === "turn_started", `resume delivery ${result.delivery}`);
      await pollUntil(async () => (await windows(ctx)).length === 0, {
        timeoutMs: 240_000,
        description: "the agent closes its window",
      });
      await pollUntil(async () => (await agentStatus(ctx)) === "idle", {
        timeoutMs: 120_000,
        description: "agent idle after finishing",
      });
      const items = await timeline(ctx);
      const text = JSON.stringify(items);
      ctx.expect(text.includes("Browser resume"), "resume notice in the timeline");
      ctx.expect(
        /fleet_browser_close/.test(text),
        "the agent closed its window with fleet_browser_close",
      );
      const lastAssistant = items.findLast((entry) => entry.item?.type === "assistant_message");
      const reply = lastAssistant?.item.text ?? "";
      ctx.expect(/iana/i.test(reply), `final reply names the IANA page: ${reply.slice(0, 400)}`);
      return `final reply: ${reply.slice(0, 600)}`;
    },
  },
];
