import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const meta = {
  name: "ui-sidebar-search",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Asserts the sidebar search finds a closed (dormant) agent by name and id prefix in the " +
    "Agents view, finds archived agents only with Include archived, shows no engine label, and " +
    "opens an archived agent whose project was removed with its workspace and project restored.",
};

const WORKSPACE_TITLE = "sidebar-search-workspace";
const CLOSED_TITLE = "Closed search target";
const ARCHIVED_TITLE = "Archived search target";
const ORPHAN_TITLE = "Orphaned search target";
const CHECK_LABEL_KEY = "paseo.verify-check";
const CHECK_LABEL_VALUE = "ui-sidebar-search";

let workspaceId = null;
let closed = null;
let archived = null;
let orphan = null;
let orphanDir = null;
let orphanWorkspaceId = null;

function commanderProviderModel(ctx) {
  const raw = String(ctx.stack.commanderModel);
  return { provider: raw.split("/")[0], model: raw.replace(/^[^/]+\//, "") };
}

/** No initial prompt: the agent never runs, so the board files it as idle (Dormant). */
async function createIdleAgent(ctx, title, inWorkspaceId = workspaceId, cwd = ctx.host().home) {
  const { provider, model } = commanderProviderModel(ctx);
  return ctx.host().client.createAgent({
    cwd,
    workspaceId: inWorkspaceId,
    title,
    provider,
    model,
    modeId: "full",
    labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE },
  });
}

async function pollFor(fetchValue, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fetchEntry(client, agentId) {
  const res = await client.fetchAgents({
    filter: { labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE }, includeArchived: true },
  });
  return res.entries.find((entry) => entry.agent.id === agentId) ?? null;
}

function rowSelector(agentId) {
  return `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid^="sidebar-agent-view-row-time-"])`;
}

async function search(page, query) {
  const input = page.locator('[data-testid="sidebar-search-input"]');
  await input.fill(query);
  // The bar reads Searching… until every host answered.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="sidebar-search-status"]') === null,
    null,
    { timeout: 10_000 },
  );
}

async function visible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

/** Box and title typography of a sidebar row, to compare archived rows with agent rows. */
async function rowMetrics(page, selector, title, options = {}) {
  if (options.query) await search(page, options.query);
  const row = page.locator(selector).first();
  await row.waitFor({ state: "visible", timeout: 10_000 });
  return row.evaluate((element, expectedTitle) => {
    const leaves = [...element.querySelectorAll("div, span")].filter(
      (node) => node.children.length === 0 && node.textContent.trim().length > 0,
    );
    const titleNode = leaves.find((node) => node.textContent === expectedTitle);
    const style = titleNode ? getComputedStyle(titleNode) : null;
    return {
      x: Math.round(element.getBoundingClientRect().x),
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
      fontSize: style?.fontSize ?? null,
      fontWeight: style?.fontWeight ?? null,
      lineHeight: style?.lineHeight ?? null,
      opacity: style?.opacity ?? null,
      color: style?.color ?? null,
      hasTime: leaves.length >= 2,
      hasIcon: element.querySelector("svg") !== null,
    };
  }, title);
}

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and switch the sidebar to the Agents view",
    narrate: "Web UI loaded and the sidebar switched to the agent list.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector('[data-testid="sidebar-search-toggle"]', { timeout: 15_000 });
      const toggle = page.locator('[data-testid="sidebar-view-toggle-agents"]');
      await toggle.waitFor({ state: "visible", timeout: 10_000 });
      await toggle.click();
      await page.waitForSelector(
        '[data-testid="sidebar-agent-view-list"], [data-testid="sidebar-agent-view-empty-state"]',
        { timeout: 10_000 },
      );
      return "agents view open";
    },
  },
  {
    id: "create-agents",
    label: "Create an idle (dormant) agent and an archived agent",
    narrate: "Two agents created over RPC; the second one archived.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: ctx.host().home },
        title: WORKSPACE_TITLE,
      });
      workspaceId = created.workspace?.id;
      ctx.expect(Boolean(workspaceId), "Workspace created via RPC");

      closed = await createIdleAgent(ctx, CLOSED_TITLE);
      archived = await createIdleAgent(ctx, ARCHIVED_TITLE);
      await client.archiveAgent(archived.id);

      const closedEntry = await fetchEntry(client, closed.id);
      const archivedEntry = await fetchEntry(client, archived.id);
      ctx.expect(
        closedEntry?.agent.bucket === "idle",
        `closed agent bucket idle, got ${closedEntry?.agent.bucket}`,
      );
      ctx.expect(Boolean(archivedEntry?.agent.archivedAt), "archived agent carries archivedAt");
      ctx.expect(Boolean(closed.name && archived.name), "both agents have generated names");
      return `closed ${closed.name} (${closed.id}), archived ${archived.name} (${archived.id})`;
    },
  },
  {
    id: "create-orphan",
    label: "Archive an agent by removing its project (the Lively Fable shape)",
    narrate:
      "An agent's project is removed: its workspace and the agent are archived and the project record is gone.",
    async run(ctx) {
      const client = ctx.host().client;
      mkdirSync(path.join(ctx.host().home, "removed-project"), { recursive: true });
      // The daemon stores canonical paths; the stack home can sit behind a symlink.
      orphanDir = realpathSync(path.join(ctx.host().home, "removed-project"));
      const created = await client.createWorkspace({
        source: { kind: "directory", path: orphanDir },
        title: "removed-project-workspace",
      });
      orphanWorkspaceId = created.workspace?.id;
      const projectId = created.workspace?.projectId;
      ctx.expect(
        Boolean(orphanWorkspaceId && projectId),
        "orphan workspace created in its own project",
      );
      orphan = await createIdleAgent(ctx, ORPHAN_TITLE, orphanWorkspaceId, orphanDir);
      await client.removeProject(projectId);

      // fetchAgent, not the label-filtered directory: the directory lists no agent
      // whose project record is gone, which is the state this check builds.
      const entry = await pollFor(async () => {
        const current = await client.fetchAgent({ agentId: orphan.id });
        return current?.agent.archivedAt ? current : null;
      }, `orphan agent archived with its project (workspace ${orphanWorkspaceId})`);
      const projects = (await client.listProjects()).projects;
      ctx.expect(Boolean(entry.agent.archivedAt), "orphan agent archived with its project");
      ctx.expect(
        !projects.some((project) => project.projectRootPath === orphanDir),
        "project record removed",
      );
      return `orphan ${orphan.name} (${orphan.id}) in removed project ${projectId}`;
    },
  },
  {
    id: "dormant-hidden-while-browsing",
    label: "The idle agent is not listed while browsing",
    narrate: "Without a search the dormant agent stays out of the Agents view.",
    async run(ctx) {
      await ctx.page.waitForTimeout(1_500);
      ctx.expect(
        !(await visible(ctx.page, rowSelector(closed.id))),
        "dormant row hidden while browsing",
      );
      await ctx.shot("before");
      return "dormant row hidden";
    },
  },
  {
    id: "search-by-name",
    label: "Search the closed agent by name, then by id prefix",
    narrate: "Typing the agent's name, then its id prefix, lists it under Done.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator('[data-testid="sidebar-search-toggle"]').click();
      await search(page, closed.name);
      await page.waitForSelector(rowSelector(closed.id), { timeout: 10_000 });
      ctx.expect(
        await visible(page, '[data-testid="sidebar-agent-view-section-done"]'),
        "closed match listed under the Done section",
      );
      const panelText = await page.locator('[data-testid="sidebar-search-panel"]').innerText();
      ctx.expect(!/jev/i.test(panelText), `search panel shows no engine label, got "${panelText}"`);

      await search(page, closed.id.slice(0, 8));
      await page.waitForSelector(rowSelector(closed.id), { timeout: 10_000 });
      await ctx.shot("after");
      return `found by name "${closed.name}" and id prefix ${closed.id.slice(0, 8)}`;
    },
  },
  {
    id: "archived-opt-in",
    label: "Archived agent matches only with Include archived",
    narrate: "The archived agent stays hidden until Include archived, then lists under the bar.",
    async run(ctx) {
      const page = ctx.page;
      await search(page, archived.name);
      await page.waitForSelector('[data-testid="sidebar-search-empty-state"]', { timeout: 10_000 });

      await page.locator('[data-testid="sidebar-search-include-archived"]').click();
      await page.waitForSelector(`[data-testid="sidebar-search-archived-${archived.id}"]`, {
        timeout: 10_000,
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="sidebar-search-status"]') === null,
        null,
        { timeout: 10_000 },
      );
      ctx.expect(
        !(await visible(page, '[data-testid="sidebar-search-empty-state"]')),
        "no 'No agents match' while an archived match is listed",
      );
      const normal = await rowMetrics(page, rowSelector(closed.id), closed.title ?? CLOSED_TITLE, {
        query: closed.name,
      });
      await search(page, archived.name);
      const archivedRow = await rowMetrics(
        page,
        `[data-testid="sidebar-search-archived-${archived.id}"]`,
        ARCHIVED_TITLE,
      );
      const keys = [
        "x",
        "width",
        "height",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "opacity",
        "color",
      ];
      for (const key of keys) {
        ctx.expect(
          normal[key] === archivedRow[key],
          `archived row ${key} ${archivedRow[key]} matches agent row ${normal[key]}`,
        );
      }
      ctx.expect(archivedRow.hasTime, "archived row shows its time label");
      ctx.expect(archivedRow.hasIcon, "archived row keeps the archive icon");
      await ctx.shot("archived");
      return `archived ${archived.name} listed only with Include archived; row ${JSON.stringify(archivedRow)}`;
    },
  },
  {
    id: "open-orphaned-archived",
    label: "Opening the orphaned archived agent restores it, its workspace, and its project",
    narrate:
      "Clicking the archived match unarchives the agent, restores its workspace, and recreates its project; the composer opens.",
    async run(ctx) {
      const page = ctx.page;
      const client = ctx.host().client;
      await search(page, orphan.name);
      const row = page.locator(`[data-testid="sidebar-search-archived-${orphan.id}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.click();

      const entry = await pollFor(async () => {
        const current = await client.fetchAgent({ agentId: orphan.id });
        return current && !current.agent.archivedAt ? current : null;
      }, "orphan agent unarchived");
      const project = await pollFor(
        async () =>
          (await client.listProjects()).projects.find(
            (candidate) => candidate.projectRootPath === orphanDir,
          ) ?? null,
        "project recreated at the workspace folder",
      );
      const { entries: workspaces } = await client.fetchWorkspaces();
      const atFolder = workspaces.filter((workspace) => workspace.projectId === project.projectId);
      ctx.expect(
        entry.agent.workspaceId === orphanWorkspaceId,
        `agent back in its own workspace ${orphanWorkspaceId}, got ${entry.agent.workspaceId}`,
      );
      ctx.expect(
        project.baseWorkspaceId === orphanWorkspaceId && atFolder.length === 1,
        `restored workspace is the project's only one: base ${project.baseWorkspaceId}, active at folder ${atFolder.map((workspace) => workspace.id)}`,
      );
      await page.waitForSelector('[data-testid="message-input-root"]', {
        state: "visible",
        timeout: 20_000,
      });
      ctx.expect(
        !(await page.getByText("Workspace unavailable", { exact: true }).isVisible()),
        "no 'Workspace unavailable' dead end",
      );
      ctx.expect(
        (await page.locator(`[data-testid="sidebar-search-archived-${orphan.id}"]`).count()) === 0,
        "restored agent no longer listed under Archived",
      );
      await ctx.shot("restored");
      return `agent ${orphan.id} active in workspace ${entry.agent.workspaceId}, project ${project.projectId} at ${orphanDir} (base ${project.baseWorkspaceId}), composer visible`;
    },
  },
  {
    id: "cleanup",
    label: "Archive the created agents (best effort)",
    narrate: "Cleaned up the agents created for this check.",
    async run(ctx) {
      for (const agent of [closed, orphan]) {
        try {
          if (agent) await ctx.host().client.archiveAgent(agent.id);
        } catch {
          // Best-effort cleanup only.
        }
      }
      return "cleanup done";
    },
  },
];
