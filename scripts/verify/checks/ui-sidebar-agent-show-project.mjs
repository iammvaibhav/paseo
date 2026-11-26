import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const meta = {
  name: "ui-sidebar-agent-show-project",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Agents view row menu: Show project switches the sidebar to the projects view, expands the " +
    "agent's project, and scrolls it into view, including a project far down a long list.",
};

const MODEL = "ten-second-stream";
const PROJECT_COUNT = 18;

const agents = [];

function rowSelector(agentId) {
  return `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid^="sidebar-agent-view-row-time-"]):not([data-testid^="sidebar-agent-view-row-reminder-"])`;
}

function makeRepo(root, name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=v@x", "-c", "user.name=v", "add", ".");
  git("-c", "user.email=v@x", "-c", "user.name=v", "commit", "-qm", "init");
  return dir;
}

/** Is the project row of `name` expanded, in view, and the toggle on Projects? */
async function projectState(page, projectName) {
  return page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('[data-testid^="sidebar-project-row-"]')];
    const row = rows.find((node) => node.textContent.includes(wanted));
    if (!row) return { found: false };
    const rect = row.getBoundingClientRect();
    let scroller = row.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
      scroller = scroller.parentElement;
    }
    const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return {
      found: true,
      top: Math.round(rect.top),
      inView: rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : 0,
      agentRows: document.querySelectorAll('[data-testid^="sidebar-agent-view-row-"]').length,
    };
  }, projectName);
}

async function showProject(ctx, agent) {
  const page = ctx.page;
  await page.locator('[data-testid="sidebar-view-toggle-agents"]').click();
  await page.waitForSelector(rowSelector(agent.id), { timeout: 20_000 });
  await page.locator(rowSelector(agent.id)).scrollIntoViewIfNeeded();
  await page.locator(rowSelector(agent.id)).click({ button: "right" });
  const item = page.locator(
    `[data-testid^="sidebar-agent-view-row-show-project-"][data-testid$="-${agent.id}"]`,
  );
  await item.waitFor({ timeout: 5_000 });
  await ctx.shot(`menu-${agent.projectName}`);
  await item.click();
  await page.waitForTimeout(1_200);
  const state = await projectState(page, agent.projectName);
  await ctx.shot(`revealed-${agent.projectName}`);
  ctx.expect(state.found, `project row ${agent.projectName} rendered`);
  ctx.expect(state.agentRows === 0, `sidebar left the agents view (${state.agentRows} agent rows)`);
  ctx.expect(state.inView, `project row ${agent.projectName} in view: ${JSON.stringify(state)}`);
  return state;
}

export const steps = [
  {
    id: "seed",
    label: `Seed ${PROJECT_COUNT} projects with one mock agent each`,
    narrate: "Many projects, one agent each, so the last project sits far below the fold.",
    async run(ctx) {
      const client = ctx.host().client;
      const root = path.join(path.dirname(ctx.fixtureRepo), "show-project-repos");
      for (let index = 0; index < PROJECT_COUNT; index += 1) {
        const projectName = `proj-${String(index).padStart(2, "0")}`;
        const cwd = makeRepo(root, projectName);
        const agent = await client.createAgent({
          provider: "mock",
          model: MODEL,
          cwd,
          title: `Agent in ${projectName}`,
        });
        await client.sendMessage(agent.id, "Stream for the show-project check.");
        agents.push({ id: agent.id, projectName });
      }
      return `${agents.length} agents`;
    },
  },
  {
    id: "collapse-all",
    label: "Open the projects view and collapse every project",
    narrate: "Every project starts collapsed, so Show project has to expand one.",
    async run(ctx) {
      const page = ctx.page;
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.locator('[data-testid="sidebar-view-toggle-workspaces"]').click();
      await page.waitForSelector('[data-testid^="sidebar-project-row-"]', { timeout: 30_000 });
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-testid^="sidebar-project-row-"]').length >= count,
        PROJECT_COUNT,
        { timeout: 30_000 },
      );
      await page.evaluate(() => {
        const keys = [...document.querySelectorAll('[data-testid^="sidebar-project-row-"]')].map(
          (node) => node.getAttribute("data-testid").replace("sidebar-project-row-", ""),
        );
        localStorage.setItem(
          "sidebar-collapsed-sections",
          JSON.stringify({ state: { collapsedProjectKeys: keys }, version: 0 }),
        );
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid^="sidebar-project-row-"]', { timeout: 30_000 });
      await ctx.shot("collapsed");
      return "collapsed";
    },
  },
  {
    id: "last-project",
    label: "Show project on the agent in the last project scrolls it into view",
    narrate: "Right-click, Show project: the sidebar switches to projects and scrolls down.",
    async run(ctx) {
      const last = agents[agents.length - 1];
      const state = await showProject(ctx, last);
      ctx.expect(state.scrollTop > 0, `list scrolled down: ${JSON.stringify(state)}`);
      const expanded = await ctx.page.locator('[data-testid^="sidebar-workspace-row-"]').count();
      ctx.expect(expanded > 0, "the revealed project shows its workspace rows");
      return JSON.stringify(state);
    },
  },
  {
    id: "first-project",
    label: "Show project on the agent in the first project scrolls back up",
    narrate: "The same action on the first project brings the list back to the top.",
    async run(ctx) {
      const state = await showProject(ctx, agents[0]);
      return JSON.stringify(state);
    },
  },
  {
    id: "cleanup",
    label: "Archive the fixture agents (best effort)",
    narrate: "Cleaned up.",
    async run(ctx) {
      for (const agent of agents) {
        try {
          await ctx.host().client.archiveAgent(agent.id);
        } catch {
          // Best-effort cleanup only.
        }
      }
      return "cleanup done";
    },
  },
];
