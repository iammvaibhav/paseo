export const meta = {
  name: "ui-sidebar-running-duration",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Asserts the sidebar's running-agent rows show elapsed run duration (not stale " +
    "relative-activity 'ago'/'now' text) and sort the running bucket by run recency, not name.",
};

const WORKSPACE_TITLE = "sidebar-duration-workspace";
const ALPHA_TITLE = "Alpha sidebar duration";
const ZULU_TITLE = "Zulu sidebar duration";
const CHECK_LABEL_KEY = "paseo.verify-check";
const CHECK_LABEL_VALUE = "ui-sidebar-running-duration";
// Deterministic long-running turn: the agent's provider process stays busy inside
// a blocking shell call so the turn never closes for the duration of the check.
const SLEEP_PROMPT =
  "Run the shell command `sleep 240` with your bash tool, then reply DONE. Do not do anything else.";
// Long enough that Alpha's elapsed run duration crosses the 1-minute boundary
// while Zulu (created after this wait) is still under it.
const STAGGER_MS = 75_000;

let workspaceId = null;
let alphaId = null;
let zuluId = null;

function commanderProviderModel(ctx) {
  const raw = String(ctx.stack.commanderModel);
  return {
    provider: raw.split("/")[0],
    model: raw.replace(/^[^/]+\//, ""),
  };
}

async function pollFor(
  fetchValue,
  { timeoutMs = 60000, intervalMs = 1000, description = "condition" } = {},
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

async function createSleepAgent(ctx, title) {
  const client = ctx.host().client;
  const { provider, model } = commanderProviderModel(ctx);
  const created = await client.createAgent({
    cwd: ctx.host().home,
    workspaceId,
    title,
    provider,
    model,
    modeId: "full",
    initialPrompt: SLEEP_PROMPT,
    labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE },
  });
  return created.id;
}

async function fetchCheckAgents(client) {
  const res = await client.fetchAgents({
    filter: { labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE } },
  });
  return res.entries;
}

/**
 * The fix adds `testID="sidebar-agent-view-row-elapsed"` to the row's time Text. Until it
 * lands, read the row's trailing text leaf instead of failing on a missing selector, so the
 * check is red for the real bug (stale "now"/ago text, wrong order) rather than red for an
 * absent testID.
 */
async function rowTimeText(page, rowSelector) {
  const testIdLocator = page.locator(
    `${rowSelector} [data-testid="sidebar-agent-view-row-elapsed"]`,
  );
  if ((await testIdLocator.count()) > 0) {
    return ((await testIdLocator.first().textContent()) ?? "").trim();
  }
  return page.$eval(rowSelector, (row) => {
    const leaves = [...row.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0,
    );
    return leaves.length > 0 ? (leaves[leaves.length - 1].textContent ?? "").trim() : "";
  });
}

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and connect to daemon",
    narrate: "Web UI loaded in Chromium and connected to loopback daemon.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      await page.goto(host.httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        { timeout: 10_000 },
      );
      return `app loaded from ${host.httpUrl}`;
    },
  },
  {
    id: "create-workspace",
    label: "Create an isolated workspace to host both agents",
    narrate: "Workspace created over RPC to host both agents.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: ctx.host().home },
        title: WORKSPACE_TITLE,
      });
      workspaceId = created.workspace?.id;
      ctx.expect(Boolean(workspaceId), "Workspace created via RPC");
      return `workspace ${workspaceId} created`;
    },
  },
  {
    id: "create-alpha",
    label: "Create Alpha (alphabetically first, run-recency last)",
    narrate: "Alpha agent created and given a long-running shell command.",
    async run(ctx) {
      alphaId = await createSleepAgent(ctx, ALPHA_TITLE);
      ctx.expect(Boolean(alphaId), "Alpha agent created via RPC");
      return `Alpha agent ${alphaId} created`;
    },
  },
  {
    id: "wait-then-create-zulu",
    label: "Wait ~75s, then create Zulu (alphabetically last, run-recency first)",
    narrate: "Waited so Alpha's run is well past a minute old, then created Zulu.",
    async run(ctx) {
      await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
      zuluId = await createSleepAgent(ctx, ZULU_TITLE);
      ctx.expect(Boolean(zuluId), "Zulu agent created via RPC");
      return `Zulu agent ${zuluId} created ~${STAGGER_MS / 1000}s after Alpha`;
    },
  },
  {
    id: "wait-both-running",
    label: "Poll the agent directory until both agents carry an open turn",
    narrate: "Both agents confirmed running with an open turn over RPC.",
    async run(ctx) {
      const client = ctx.host().client;
      const both = await pollFor(
        async () => {
          const entries = await fetchCheckAgents(client);
          const alpha = entries.find((entry) => entry.agent.id === alphaId);
          const zulu = entries.find((entry) => entry.agent.id === zuluId);
          if (!alpha || !zulu) return null;
          if (alpha.agent.bucket !== "running" || zulu.agent.bucket !== "running") return null;
          if (!alpha.agent.activeTurn?.startedAt || !zulu.agent.activeTurn?.startedAt) return null;
          return { alpha, zulu };
        },
        { timeoutMs: 90_000, description: "both agents running with an open turn" },
      );
      return (
        `Alpha turn ${both.alpha.agent.activeTurn.turnId} started ${both.alpha.agent.activeTurn.startedAt}, ` +
        `Zulu turn ${both.zulu.agent.activeTurn.turnId} started ${both.zulu.agent.activeTurn.startedAt}`
      );
    },
  },
  {
    id: "open-agents-view",
    label: "Switch the sidebar to the agents view and wait for both rows",
    narrate: "Sidebar switched to the agent list; both rows appeared.",
    async run(ctx) {
      const page = ctx.page;
      const toggle = page.locator('[data-testid="sidebar-view-toggle-agents"]');
      if (await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await toggle.click();
      }

      const alphaSelector = `[data-testid$="-${alphaId}"]`;
      const zuluSelector = `[data-testid$="-${zuluId}"]`;
      await page.waitForSelector(alphaSelector, { state: "attached", timeout: 30_000 });
      await page.waitForSelector(zuluSelector, { state: "attached", timeout: 30_000 });

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return "both agent rows rendered in the sidebar";
    },
  },
  {
    id: "assert-sort-and-duration",
    label: "Assert running rows sort by recency and show elapsed run duration",
    narrate: "Verified row order is Zulu-then-Alpha and the time text reads elapsed duration.",
    async run(ctx) {
      const page = ctx.page;
      const alphaSelector = `[data-testid$="-${alphaId}"]`;
      const zuluSelector = `[data-testid$="-${zuluId}"]`;

      ctx.expect(
        (await page.locator(alphaSelector).count()) === 1,
        `exactly one sidebar row for Alpha (${alphaId})`,
      );
      ctx.expect(
        (await page.locator(zuluSelector).count()) === 1,
        `exactly one sidebar row for Zulu (${zuluId})`,
      );

      const testIds = await page.$$eval('[data-testid^="sidebar-agent-view-row-"]', (els) =>
        els.map((el) => el.getAttribute("data-testid")),
      );
      const alphaIndex = testIds.findIndex((id) => id?.endsWith(`-${alphaId}`));
      const zuluIndex = testIds.findIndex((id) => id?.endsWith(`-${zuluId}`));
      ctx.expect(alphaIndex >= 0, `Alpha row present in running-section DOM order, got ${testIds}`);
      ctx.expect(zuluIndex >= 0, `Zulu row present in running-section DOM order, got ${testIds}`);
      ctx.expect(
        zuluIndex < alphaIndex,
        `expected most-recently-started Zulu before Alpha in DOM order; got ${JSON.stringify(testIds)}`,
      );

      const alphaTime = await rowTimeText(page, alphaSelector);
      const zuluTime = await rowTimeText(page, zuluSelector);

      ctx.expect(
        alphaTime !== "now",
        `Alpha's run is ~${STAGGER_MS / 1000}s old; row time must not read "now", got "${alphaTime}"`,
      );
      ctx.expect(
        /^(\d+m|\d+h( \d+m)?)$/.test(alphaTime),
        `Alpha row time must read minute-granular elapsed run duration (e.g. "1m"), got "${alphaTime}"`,
      );
      ctx.expect(
        /^(<1m|\d+s|0m)$/.test(zuluTime),
        `Zulu row time must read a sub-minute elapsed run duration, got "${zuluTime}"`,
      );

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");
      return `DOM order [${testIds.join(", ")}], alpha="${alphaTime}", zulu="${zuluTime}"`;
    },
  },
  {
    id: "cleanup",
    label: "Archive the two created agents (best effort)",
    narrate: "Cleaned up the agents created for this check.",
    async run(ctx) {
      const client = ctx.host().client;
      let archived = 0;
      for (const id of [alphaId, zuluId]) {
        if (!id) continue;
        try {
          await client.archiveAgent(id);
          archived++;
        } catch {
          // Best-effort cleanup only; never fail the check on teardown.
        }
      }
      return `archived ${archived}/2 agents`;
    },
  },
];
