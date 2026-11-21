export const meta = {
  name: "ui-sidebar-agent-view",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "The sidebar Agents view lists Running (needs-you first) then one Recent list; Mark done keeps " +
    "the row in place; pinned agents move to a Pinned section over agent.pin.set (paseo.pinned-at " +
    "label), reorder by dragging the status-slot handle, keep the order across a reload, and " +
    "return to Recent when unpinned.",
};

const FIVE_MIN_MODEL = "five-minute-stream";
const TEN_SEC_MODEL = "ten-second-stream";
const SEED_MESSAGE = "Stream for the ui-sidebar-agent-view verification check.";
const PLAN_APPROVAL_MESSAGE = "emit synthetic plan approval";
const PINNED_AT_LABEL = "paseo.pinned-at";

let running = null;
let needsYou = null;
let older = null;
let newer = null;

function rowSelector(agentId) {
  return `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid^="sidebar-agent-view-row-time-"]):not([data-testid^="sidebar-agent-view-row-reminder-"])`;
}

async function pollFor(fetchValue, description, timeoutMs = 30_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last?.ok) return last.value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last?.value)}`);
}

/** Section key → agent ids in DOM order, for the fixture agents only. */
async function sectionsOf(page) {
  const ids = [running.id, needsYou.id, older.id, newer.id];
  return page.evaluate((fixtureIds) => {
    const out = {};
    const headers = [...document.querySelectorAll('[data-testid^="sidebar-agent-view-section-"]')];
    const rows = [...document.querySelectorAll('[data-testid^="sidebar-agent-view-row-"]')].filter(
      (node) =>
        !/^sidebar-agent-view-row-(time|reminder|menu|open|copy|stop|mark|clear|archive|pin)-/.test(
          node.getAttribute("data-testid"),
        ),
    );
    for (const row of rows) {
      const id = fixtureIds.find((candidate) =>
        row.getAttribute("data-testid").endsWith(candidate),
      );
      if (!id) continue;
      // The section is the last header above the row in document order.
      let key = null;
      for (const header of headers) {
        if (header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) {
          key = header.getAttribute("data-testid").replace("sidebar-agent-view-section-", "");
        }
      }
      (out[key] ??= []).push(id);
    }
    return out;
  }, ids);
}

function name(id) {
  return {
    [running.id]: "running",
    [needsYou.id]: "needsYou",
    [older.id]: "older",
    [newer.id]: "newer",
  }[id];
}

function describe(sections) {
  return Object.entries(sections)
    .map(([key, ids]) => `${key}: ${ids.map(name).join(", ")}`)
    .join(" | ");
}

async function openRowMenu(page, agentId) {
  await page.locator(rowSelector(agentId)).click({ button: "right" });
}

async function labelOf(client, agentId) {
  const entry = await client.fetchAgent({ agentId });
  return entry?.agent.labels?.[PINNED_AT_LABEL] ?? null;
}

export const steps = [
  {
    id: "seed",
    label: "Seed running, needs-you and two ready mock agents",
    narrate: "Four mock agents: one running, one waiting on a plan approval, two finished.",
    async run(ctx) {
      const client = ctx.host().client;
      const create = async (title, model, message) => {
        const agent = await client.createAgent({
          provider: "mock",
          model,
          cwd: ctx.fixtureRepo,
          title,
        });
        await client.sendMessage(agent.id, message);
        return agent;
      };
      older = await create("Older ready agent", TEN_SEC_MODEL, SEED_MESSAGE);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      newer = await create("Newer ready agent", TEN_SEC_MODEL, SEED_MESSAGE);
      running = await create("Long running agent", FIVE_MIN_MODEL, SEED_MESSAGE);
      needsYou = await create("Plan approval agent", FIVE_MIN_MODEL, PLAN_APPROVAL_MESSAGE);
      const buckets = await pollFor(async () => {
        const entries = await Promise.all(
          [running, needsYou, older, newer].map((agent) =>
            client.fetchAgent({ agentId: agent.id }),
          ),
        );
        const value = entries.map((entry) => entry?.agent.bucket ?? null);
        return {
          ok:
            value[0] === "running" &&
            value[1] === "needs_you" &&
            value[2] === "ready" &&
            value[3] === "ready",
          value,
        };
      }, "fixture buckets running / needs_you / ready / ready");
      return `buckets ${buckets.join(", ")}`;
    },
  },
  {
    id: "running-then-recent",
    label:
      "Agents view: Running holds needs-you first, Recent holds both ready agents newest first",
    narrate: "Two sections: Running with the waiting agent on top, then Recent.",
    async run(ctx) {
      const page = ctx.page;
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.locator('[data-testid="sidebar-view-toggle-agents"]').click();
      await page.waitForSelector(rowSelector(older.id), { timeout: 20_000 });
      const sections = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(sections.running) === JSON.stringify([needsYou.id, running.id]),
        `Running is needsYou, running: ${describe(sections)}`,
      );
      ctx.expect(
        JSON.stringify(sections.recent) === JSON.stringify([newer.id, older.id]),
        `Recent is newer, older: ${describe(sections)}`,
      );
      ctx.expect(!sections.pinned, "no Pinned section yet");
      await ctx.shot("before");
      return describe(sections);
    },
  },
  {
    id: "mark-done-stays",
    label: "Mark done on the older agent keeps it in Recent, below the newer one",
    narrate: "Marking the older agent done changes its dot; it does not move.",
    async run(ctx) {
      const page = ctx.page;
      await openRowMenu(page, older.id);
      await page
        .locator(`[data-testid^="sidebar-agent-view-row-mark-done-"][data-testid$="-${older.id}"]`)
        .click();
      await pollFor(async () => {
        const entry = await ctx.host().client.fetchAgent({ agentId: older.id });
        return { ok: entry?.agent.bucket === "done", value: entry?.agent.bucket };
      }, "older agent marked done");
      await page.waitForTimeout(1_500);
      const sections = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(sections.recent) === JSON.stringify([newer.id, older.id]),
        `Recent still newer, older after Mark done: ${describe(sections)}`,
      );
      await ctx.shot("marked-done");
      return describe(sections);
    },
  },
  {
    id: "pin",
    label: "Pin both ready agents: they move to Pinned (newest pin first) and carry the label",
    narrate: "Pin to top moves an agent into the Pinned section above the header.",
    async run(ctx) {
      const page = ctx.page;
      const client = ctx.host().client;
      for (const agent of [older, newer]) {
        await openRowMenu(page, agent.id);
        await page
          .locator(`[data-testid^="sidebar-agent-view-row-pin-"][data-testid$="-${agent.id}"]`)
          .click();
        await pollFor(
          async () => {
            const label = await labelOf(client, agent.id);
            return { ok: Boolean(label), value: label };
          },
          `${name(agent.id)} pinned label`,
        );
        await page.waitForTimeout(300);
      }
      await page.waitForSelector('[data-testid="sidebar-agent-view-section-pinned"]', {
        timeout: 10_000,
      });
      await page.waitForTimeout(1_000);
      const sections = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(sections.pinned) === JSON.stringify([newer.id, older.id]),
        `Pinned is newer, older: ${describe(sections)}`,
      );
      ctx.expect(!sections.recent, `pinned agents left Recent: ${describe(sections)}`);
      await ctx.shot("pinned");
      return describe(sections);
    },
  },
  {
    id: "drag-reorder",
    label: "Drag the older agent above the newer one by its handle; the order survives a reload",
    narrate: "Dragging the grip reorders Pinned, and the order is kept after a reload.",
    async run(ctx) {
      const page = ctx.page;
      const source = page.locator(rowSelector(older.id));
      const target = page.locator(rowSelector(newer.id));
      await source.hover();
      const handle = page.locator(
        `[data-testid^="sidebar-agent-view-drag-handle-"][data-testid$="-${older.id}"]`,
      );
      const from = await handle.boundingBox();
      const to = await target.boundingBox();
      ctx.expect(Boolean(from && to), "handle and target rows have boxes");
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 6, { steps: 4 });
      await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 12 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(800);
      const afterDrag = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(afterDrag.pinned) === JSON.stringify([older.id, newer.id]),
        `Pinned is older, newer after drag: ${describe(afterDrag)}`,
      );
      await ctx.shot("reordered");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(rowSelector(older.id), { timeout: 20_000 });
      await page.waitForTimeout(1_000);
      const afterReload = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(afterReload.pinned) === JSON.stringify([older.id, newer.id]),
        `order kept across reload: ${describe(afterReload)}`,
      );
      return `after drag ${describe(afterDrag)}; after reload ${describe(afterReload)}`;
    },
  },
  {
    id: "unpin",
    label: "Unpin the older agent: it returns to Recent and loses the label",
    narrate: "Unpin puts the agent back in Recent.",
    async run(ctx) {
      const page = ctx.page;
      await openRowMenu(page, older.id);
      await page
        .locator(`[data-testid^="sidebar-agent-view-row-pin-"][data-testid$="-${older.id}"]`)
        .click();
      await pollFor(async () => {
        const label = await labelOf(ctx.host().client, older.id);
        return { ok: label === null, value: label };
      }, "older label removed");
      await page.waitForTimeout(1_000);
      const sections = await sectionsOf(page);
      ctx.expect(
        JSON.stringify(sections.pinned) === JSON.stringify([newer.id]),
        `Pinned is newer only: ${describe(sections)}`,
      );
      ctx.expect(
        JSON.stringify(sections.recent) === JSON.stringify([older.id]),
        `older back in Recent: ${describe(sections)}`,
      );
      await ctx.shot("after");
      return describe(sections);
    },
  },
  {
    id: "cleanup",
    label: "Archive the fixture agents (best effort)",
    narrate: "Cleaned up the agents created for this check.",
    async run(ctx) {
      for (const agent of [running, needsYou, older, newer]) {
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
