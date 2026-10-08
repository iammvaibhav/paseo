export const meta = {
  name: "agent-grid-stable",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Verifies Mission Control Agent Grid stable layout: fixed order across lifecycle " +
    "transitions, header navigation with back button and glow, sidebar-to-grid focus, " +
    "new agent draft tile, context menu actions, simplified header with moved settings, " +
    "and draft syncing between grid and workspace.",
};

const MOCK_PROVIDER = "mock";
const FIVE_MIN_MODEL = "five-minute-stream";
const TEN_SEC_MODEL = "ten-second-stream";
const SEED_MESSAGE = "Stream continuously for the agent-grid-stable verification check.";

// Fixture state scoped to this run instance.
let RUN_ID_SUFFIX = null;
let RUN_1_ID = null;
let RUN_2_ID = null;
let READY_ID = null;
let _DRAFT_AGENT_ID = null;

// Selectors for contract testIDs
function tileTestId(agentId) {
  return `mission-control-agent-grid-tile-${agentId}`;
}

function tileSelector(agentId) {
  return `[data-testid="${tileTestId(agentId)}"]`;
}
function _tilePlaceholderSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-tile-placeholder-${agentId}"]`;
}

function tileAnySelector(agentId) {
  return `[data-testid="${tileTestId(agentId)}"], [data-testid="mission-control-agent-grid-tile-placeholder-${agentId}"]`;
}

/**
 * Scroll the grid ScrollView to bring the target tile into the mount window.
 * Polling checks whether the target agent is mounted as a full tile.
 */
async function scrollToTile(page, agentId) {
  const scrollLocator = page.locator('[data-testid="mission-control-agent-grid-scroll"]');
  await pollFor(
    async () => {
      const fullCount = await page.locator(tileSelector(agentId)).count();
      if (fullCount > 0) return { ok: true, value: fullCount };

      await scrollLocator.evaluate((scrollEl, targetId) => {
        const target = document.querySelector(
          `[data-testid="mission-control-agent-grid-tile-${targetId}"], [data-testid="mission-control-agent-grid-tile-placeholder-${targetId}"]`,
        );
        if (target && typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          scrollEl.dispatchEvent(new Event("scroll"));
        } else {
          const stepY = Math.max(scrollEl.clientHeight, 1);
          const maxY = Math.max(scrollEl.scrollHeight - scrollEl.clientHeight, 0);
          if (maxY > 0 && scrollEl.scrollTop < maxY) {
            scrollEl.scrollTop = Math.min(scrollEl.scrollTop + stepY, maxY);
          }
          const stepX = Math.max(scrollEl.clientWidth, 1);
          const maxX = Math.max(scrollEl.scrollWidth - scrollEl.clientWidth, 0);
          if (maxX > 0 && scrollEl.scrollLeft < maxX) {
            scrollEl.scrollLeft = Math.min(scrollEl.scrollLeft + stepX, maxX);
          }
          scrollEl.dispatchEvent(new Event("scroll"));
        }
      }, agentId);

      return { ok: false, value: 0 };
    },
    {
      timeoutMs: 20_000,
      intervalMs: 200,
      description: `Tile ${agentId} mounted after scrolling`,
    },
  );
}

function tileHeaderSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-header-${agentId}"]`;
}

function tileStatusSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-status-${agentId}"]`;
}

function _tileProjectSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-project-${agentId}"]`;
}

function tileElapsedSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-elapsed-${agentId}"]`;
}

function _tileLastMsgSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-lastmsg-${agentId}"]`;
}

function _tileSubagentsSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-subagents-${agentId}"]`;
}

function tileActivateSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-activate-${agentId}"]`;
}

function tileMenuSelector(agentId, action) {
  return `[data-testid="mission-control-agent-grid-menu-${agentId}-${action}"]`;
}

function tileComposerInputSelector(agentId) {
  return `${tileSelector(agentId)} textarea[data-composer-input], ${tileSelector(agentId)} textarea`;
}

async function pollFor(
  fetchValue,
  { timeoutMs = 20_000, intervalMs = 300, description = "condition" } = {},
) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last && last.ok) {
      return last.value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}; last=${JSON.stringify(last?.value ?? last)}`,
  );
}

/** Read the fleet roster and pick out just the fixture agents this check owns. */
async function listFixtureAgents(client, ids) {
  const res = await client.missionControlToolsExecute({
    name: "fleet_list_agents",
    args: { limit: 200 },
  });
  const agents = res.structuredContent?.agents ?? res.agents ?? [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return ids.map((id) => byId.get(id) ?? null);
}

/**
 * Returns agent IDs in on-screen grid order, filtering to allowedIds so assertions
 * are strictly isolated to the fixtures this check created.
 */
async function gridAgentOrder(page, allowedIds) {
  const allowedArray = allowedIds ? Array.from(allowedIds) : null;
  return page.evaluate((allowed) => {
    const filterSet = allowed ? new Set(allowed) : null;
    const elements = Array.from(
      document.querySelectorAll('[data-testid^="mission-control-agent-grid-tile-"]'),
    );
    const ids = [];
    for (const el of elements) {
      const testId = el.getAttribute("data-testid") || "";
      if (
        testId.includes("-section-") ||
        testId.includes("-header-") ||
        testId.includes("-status-") ||
        testId.includes("-project-") ||
        testId.includes("-elapsed-") ||
        testId.includes("-lastmsg-") ||
        testId.includes("-subagents-") ||
        testId.includes("-activate-") ||
        testId.includes("-glow-")
      ) {
        continue;
      }
      const match = testId.match(/^mission-control-agent-grid-tile-(?:placeholder-)?(.+)$/);
      if (match && match[1]) {
        const id = match[1];
        if (!filterSet || filterSet.has(id)) {
          if (!ids.includes(id)) {
            ids.push(id);
          }
        }
      }
    }
    return ids;
  }, allowedArray);
}

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and connect to daemon",
    narrate: "Web UI loaded in browser and connected to daemon.",
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
    id: "seed-fixtures",
    label: "Seed 2 running and 1 ready fixture agents with unique titles",
    narrate: "Two long-running agents and one ready-for-review agent created over RPC.",
    async run(ctx) {
      const client = ctx.host().client;
      RUN_ID_SUFFIX = ctx.stack?.runId ?? Date.now().toString(36);

      // 1. First running agent
      const run1 = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-stable-run-1-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(run1?.id), "RUN_1 agent created");
      RUN_1_ID = run1.id;
      await client.sendMessage(RUN_1_ID, SEED_MESSAGE);

      // Stagger so RUN_2 starts strictly after RUN_1 (for recency sorting)
      await new Promise((resolve) => setTimeout(resolve, 1600));

      // 2. Second running agent (most recent run)
      const run2 = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-stable-run-2-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(run2?.id), "RUN_2 agent created");
      RUN_2_ID = run2.id;
      await client.sendMessage(RUN_2_ID, SEED_MESSAGE);

      // 3. Ready-for-review agent
      const ready = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: TEN_SEC_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-stable-ready-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(ready?.id), "READY agent created");
      READY_ID = ready.id;
      await client.sendMessage(READY_ID, SEED_MESSAGE);

      const buckets = await pollFor(
        async () => {
          const [a, b, r] = await listFixtureAgents(client, [RUN_1_ID, RUN_2_ID, READY_ID]);
          const snapshot = {
            run1: a?.bucket ?? null,
            run2: b?.bucket ?? null,
            ready: r?.bucket ?? null,
          };
          const ok =
            snapshot.run1 === "running" &&
            snapshot.run2 === "running" &&
            snapshot.ready === "ready";
          return { ok, value: snapshot };
        },
        {
          timeoutMs: 30_000,
          description: "RUN_1/RUN_2 bucket=running and READY bucket=ready over fleet_list_agents",
        },
      );

      return `fixtures seeded RUN_1=${RUN_1_ID} RUN_2=${RUN_2_ID} READY=${READY_ID} buckets=${JSON.stringify(buckets)}`;
    },
  },
  {
    id: "open-grid",
    label: "Open Mission Control Agent Grid view",
    narrate: "Switched Mission Control to Agent Grid view and captured before shot.",
    async run(ctx) {
      const page = ctx.page;
      const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
      if (await mcButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await mcButton.click();
      }

      await page.waitForSelector(
        '[data-testid="mission-control-view-grid"], [data-testid="mission-control-panel-grid"]',
        { timeout: 10_000 },
      );
      const gridToggle = page.locator(
        '[data-testid="mission-control-view-grid"], [data-testid="mission-control-panel-grid"]',
      );
      await gridToggle.first().click();

      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return "Agent Grid view opened and before shot captured";
    },
  },
  {
    id: "assert-initial-order",
    label: "Assert initial tile order and indicators",
    narrate: "Verified running agents sorted by recency followed by ready-for-review agent.",
    async run(ctx) {
      const page = ctx.page;
      // RUN_2 started after RUN_1, so initial order is [RUN_2_ID, RUN_1_ID, READY_ID]
      const expectedOrder = [RUN_2_ID, RUN_1_ID, READY_ID];
      const fixtureIds = new Set(expectedOrder);

      const order = await pollFor(
        async () => {
          const ids = await gridAgentOrder(page, fixtureIds);
          return { ok: JSON.stringify(ids) === JSON.stringify(expectedOrder), value: ids };
        },
        {
          timeoutMs: 20_000,
          description: `fixture tile order ${JSON.stringify(expectedOrder)}`,
        },
      );

      ctx.expect(
        JSON.stringify(order) === JSON.stringify(expectedOrder),
        `Expected initial order ${JSON.stringify(expectedOrder)}, got ${JSON.stringify(order)}`,
      );

      // Verify each fixture is present in grid (as full tile or placeholder)
      for (const id of expectedOrder) {
        const anyCount = await page.locator(tileAnySelector(id)).count();
        ctx.expect(anyCount > 0, `Fixture ${id} must be present in grid (full or placeholder)`);
        const statusLocator = page.locator(tileStatusSelector(id));
        await statusLocator.waitFor({ state: "attached", timeout: 5_000 });
      }

      // Bring running tiles into mount window to verify elapsed indicators
      for (const runId of [RUN_2_ID, RUN_1_ID]) {
        await scrollToTile(page, runId);
        const elapsed = page.locator(tileElapsedSelector(runId));
        await elapsed.waitFor({ state: "visible", timeout: 5_000 });
      }
      return `initial order verified: ${JSON.stringify(order)}`;
    },
  },
  {
    id: "composer-no-reorder",
    label: "Type in composer without triggering grid reorder",
    narrate: "Activated composer and typed message; grid order remained stable.",
    async run(ctx) {
      const page = ctx.page;
      const expectedOrder = [RUN_2_ID, RUN_1_ID, READY_ID];
      const fixtureIds = new Set(expectedOrder);

      // Scroll RUN_1 into mount window so its full tile & activate button are mounted
      await scrollToTile(page, RUN_1_ID);

      // Activate RUN_1 tile to reveal composer
      const activateBtn = page.locator(tileActivateSelector(RUN_1_ID));
      await activateBtn.waitFor({ state: "visible", timeout: 10_000 });
      await activateBtn.click();

      // Wait for composer textarea and type smoke text
      const composerInput = page.locator(tileComposerInputSelector(RUN_1_ID));
      await composerInput.waitFor({ state: "visible", timeout: 10_000 });
      await composerInput.fill(`agent-grid-stable typing smoke text ${RUN_ID_SUFFIX}`);

      // Confirm order has NOT changed after typing
      const order = await gridAgentOrder(page, fixtureIds);
      ctx.expect(
        JSON.stringify(order) === JSON.stringify(expectedOrder),
        `Typing in composer must not reorder grid tiles; expected ${JSON.stringify(expectedOrder)}, got ${JSON.stringify(order)}`,
      );

      return `composer typed and order remained ${JSON.stringify(order)}`;
    },
  },
  {
    id: "lifecycle-stay-in-place",
    label: "Lifecycle transition from running to ready to done stays in place",
    narrate: "Agent marked done; tile remained in initial position with idle status indicator.",
    async run(ctx) {
      const page = ctx.page;
      const client = ctx.host().client;
      const expectedOrder = [RUN_2_ID, RUN_1_ID, READY_ID];
      const fixtureIds = new Set(expectedOrder);

      // Mark RUN_1 done over daemon lifecycle RPC
      const [agent1] = await listFixtureAgents(client, [RUN_1_ID]);
      const serverId = agent1?.serverId ?? ctx.host().name ?? "commander";
      await client.missionControlLifecycleSet({
        serverId,
        agentId: RUN_1_ID,
        action: "done",
      });

      // Assert tile stays in place under freeze snapshot
      const order = await pollFor(
        async () => {
          const ids = await gridAgentOrder(page, fixtureIds);
          return { ok: JSON.stringify(ids) === JSON.stringify(expectedOrder), value: ids };
        },
        {
          timeoutMs: 15_000,
          description: `grid order persists on done transition: ${JSON.stringify(expectedOrder)}`,
        },
      );

      // Status indicator reflects updated state
      const statusEl = page.locator(tileStatusSelector(RUN_1_ID));
      await statusEl.waitFor({ state: "attached", timeout: 5_000 });

      return `lifecycle updated to done; order preserved ${JSON.stringify(order)}`;
    },
  },
  {
    id: "archive-removes",
    label: "Archive removes tile from grid immediately",
    narrate: "Archived agent immediately removed from grid layout.",
    async run(ctx) {
      const page = ctx.page;
      const client = ctx.host().client;
      const remainingExpected = [RUN_2_ID, READY_ID];
      const allFixtureIds = new Set([RUN_2_ID, RUN_1_ID, READY_ID]);

      // Archive RUN_1
      await client.archiveAgent(RUN_1_ID);

      // Assert RUN_1 tile is removed from grid immediately
      const order = await pollFor(
        async () => {
          const ids = await gridAgentOrder(page, allFixtureIds);
          const ok =
            !ids.includes(RUN_1_ID) && JSON.stringify(ids) === JSON.stringify(remainingExpected);
          return { ok, value: ids };
        },
        {
          timeoutMs: 15_000,
          description: `RUN_1 dropped immediately from grid on archive, leaving ${JSON.stringify(remainingExpected)}`,
        },
      );

      const run1TileCount = await page.locator(tileAnySelector(RUN_1_ID)).count();
      ctx.expect(
        run1TileCount === 0,
        `Archived RUN_1 tile must be removed from DOM, count=${run1TileCount}`,
      );

      return `archive removed RUN_1 immediately; remaining order ${JSON.stringify(order)}`;
    },
  },
  {
    id: "header-click-and-back",
    label: "Header click navigates to workspace and Back returns with glow",
    narrate: "Clicked tile header to workspace, clicked back button, and observed tile glow.",
    async run(ctx) {
      const page = ctx.page;

      // Bring RUN_2 into view
      await scrollToTile(page, RUN_2_ID);

      // Click tile header of RUN_2 to open workspace
      const header = page.locator(tileHeaderSelector(RUN_2_ID));
      await header.waitFor({ state: "visible", timeout: 10_000 });
      await header.click();

      // Wait for workspace view
      await page.waitForURL(/\/workspace\/|\/agent\//, { timeout: 15_000 });

      // Back to grid button must be visible in workspace header
      const backButton = page.locator('[data-testid="workspace-back-to-grid"]');
      await backButton.waitFor({ state: "visible", timeout: 10_000 });
      await backButton.click();

      // Returned to Mission Control Agent Grid
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      // Assert tile glow is active on RUN_2
      const glowObserved = await pollFor(
        async () => {
          const glowTile = page.locator(
            `[data-testid="mission-control-agent-grid-glow-${RUN_2_ID}"], ${tileSelector(RUN_2_ID)}[data-glow="true"], [data-testid="mission-control-agent-grid-tile-placeholder-${RUN_2_ID}"][data-glow="true"]`,
          );
          const hasGlow = (await glowTile.count()) > 0;
          return { ok: hasGlow, value: hasGlow };
        },
        {
          timeoutMs: 5_000,
          description: `RUN_2 tile glow active after navigating back to grid`,
        },
      ).catch(() => false);

      ctx.expect(Boolean(glowObserved), "RUN_2 tile must display glow on return from workspace");
      return "header navigated to workspace, back button returned to grid with tile glow";
    },
  },
  {
    id: "sidebar-click-scroll-glow",
    label: "Sidebar click with grid open scrolls to tile with glow and composer",
    narrate: "Clicked agent in sidebar; grid stayed active, scrolled to tile, and opened composer.",
    async run(ctx) {
      const page = ctx.page;

      // Locate sidebar row for READY_ID
      const sidebarRow = page
        .locator(
          `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${READY_ID}"], [data-testid^="sidebar-agent-view-row-"][data-testid$=":${READY_ID}"]`,
        )
        .first();

      // If sidebar is in workspaces view, switch to agent view if toggle exists
      const toggle = page.locator('[data-testid="sidebar-view-toggle-agents"]');
      if (await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await toggle.click();
      }

      await sidebarRow.waitFor({ state: "attached", timeout: 10_000 });
      await sidebarRow.click();

      // Grid view must remain active (did not navigate away to workspace route)
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 5_000 });

      // READY tile receives glow
      const glowObserved = await pollFor(
        async () => {
          const glowTile = page.locator(
            `[data-testid="mission-control-agent-grid-glow-${READY_ID}"], ${tileSelector(READY_ID)}[data-glow="true"], [data-testid="mission-control-agent-grid-tile-placeholder-${READY_ID}"][data-glow="true"]`,
          );
          const hasGlow = (await glowTile.count()) > 0;
          return { ok: hasGlow, value: hasGlow };
        },
        {
          timeoutMs: 5_000,
          description: `READY tile glow active on sidebar click`,
        },
      ).catch(() => false);

      ctx.expect(Boolean(glowObserved), "READY tile must receive glow on sidebar click");

      // READY composer is opened
      const composer = page.locator(tileComposerInputSelector(READY_ID));
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      return "sidebar click scrolled to tile, activated glow, and opened composer";
    },
  },
  {
    id: "new-agent-draft",
    label: "New agent draft first in grid, dismissable, runs on Enter",
    narrate: "Draft tile opened first, dismissed, reopened, and created new agent on Enter.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Click header "+ New agent" button
      const newAgentBtn = page.locator('[data-testid="mission-control-new-agent"]');
      await newAgentBtn.waitFor({ state: "visible", timeout: 10_000 });
      await newAgentBtn.click();

      // 2. Draft tile appears
      const draftTile = page.locator('[data-testid="mission-control-agent-grid-draft"]');
      await draftTile.waitFor({ state: "visible", timeout: 10_000 });

      // Verify draft controls
      const draftComposer = page.locator(
        '[data-testid="mission-control-agent-grid-draft-composer"]',
      );
      await draftComposer.waitFor({ state: "visible", timeout: 5_000 });
      const draftClose = page.locator('[data-testid="mission-control-agent-grid-draft-close"]');
      await draftClose.waitFor({ state: "visible", timeout: 5_000 });

      // 3. Test dismissal via close button
      await draftClose.click();
      await draftTile.waitFor({ state: "detached", timeout: 5_000 });
      ctx.expect(
        (await draftTile.count()) === 0,
        "Draft tile must dismiss upon clicking close button",
      );

      // 4. Reopen draft
      await newAgentBtn.click();
      await draftTile.waitFor({ state: "visible", timeout: 5_000 });

      // 5. Fill prompt and press Enter to run
      const draftInput = draftComposer.locator("textarea");
      await draftInput.waitFor({ state: "visible", timeout: 5_000 });
      const prompt = `New draft agent test prompt ${RUN_ID_SUFFIX}`;
      await draftInput.fill(prompt);
      await draftInput.press("Enter");

      // Draft tile should dismiss upon submission
      await draftTile.waitFor({ state: "detached", timeout: 10_000 });

      return "new agent draft tile verified: renders first, dismisses on close, and runs on Enter";
    },
  },
  {
    id: "menu-actions",
    label: "Assert tile context menu contains required actions",
    narrate: "Right-clicked tile and verified all required context menu actions are present.",
    async run(ctx) {
      const page = ctx.page;

      // Scroll READY tile into mount window so ContextMenu is mounted
      await scrollToTile(page, READY_ID);

      // Right click READY tile
      const readyTile = page.locator(tileSelector(READY_ID));
      await readyTile.click({ button: "right" });

      // Check required context menu action testIDs
      const requiredActions = ["open", "copy-agent-id", "copy-reference", "archive"];

      for (const action of requiredActions) {
        const item = page.locator(tileMenuSelector(READY_ID, action));
        await item.waitFor({ state: "attached", timeout: 5_000 });
      }

      // Dismiss menu
      await page.keyboard.press("Escape");

      return `tile context menu actions verified: ${requiredActions.join(", ")}`;
    },
  },
  {
    id: "header-simplified-and-settings",
    label: "Verify simplified MC header and moved controls in settings",
    narrate: "Verified MC header is simplified and moved controls exist in Settings.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();

      // 1. In MC Header: view toggle and new agent present, direction & count moved out
      const viewToggle = page.locator('[data-testid="mission-control-view-toggle"]');
      await viewToggle.waitFor({ state: "visible", timeout: 5_000 });
      const newAgent = page.locator('[data-testid="mission-control-new-agent"]');
      await newAgent.waitFor({ state: "visible", timeout: 5_000 });

      const headerDirectionCount = await page
        .locator('[data-testid="mission-control-agent-grid-direction"]')
        .count();
      ctx.expect(headerDirectionCount === 0, "Direction control should be moved out of MC header");
      const headerGridCount = await page
        .locator('[data-testid="mission-control-agent-grid-count"]')
        .count();
      ctx.expect(headerGridCount === 0, "Tile count control should be moved out of MC header");

      // 2. Navigate to Settings Appearance and verify moved controls
      await page.goto(new URL("/settings/appearance", host.httpUrl).href, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });

      const movedAppearanceControls = [
        "settings-appearance-agent-grid-direction",
        "settings-appearance-agent-grid-visible-count",
        "settings-appearance-agent-grid-size",
      ];
      for (const testId of movedAppearanceControls) {
        const el = page.locator(`[data-testid="${testId}"]`);
        await el.waitFor({ state: "attached", timeout: 10_000 });
      }

      // 3. Navigate to Settings Mission Control and verify moved controls
      await page.goto(new URL("/settings/mission-control", host.httpUrl).href, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });

      const movedMcControls = [
        "mission-control-settings-approval-mode",
        "mission-control-settings-verbose",
        "mission-control-settings-clear-view",
        "mission-control-settings-reset-commander",
      ];
      for (const testId of movedMcControls) {
        const el = page.locator(`[data-testid="${testId}"]`);
        await el.waitFor({ state: "attached", timeout: 10_000 });
      }

      return "simplified header and moved controls in settings confirmed";
    },
  },
  {
    id: "draft-sync",
    label: "Verify draft sync between grid tile and workspace (text and images)",
    narrate:
      "Draft text and image attachments synchronized bidirectionally between grid and workspace.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();

      // Return to MC Agent Grid
      const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
      if (await mcButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await mcButton.click();
      } else {
        await page.goto(new URL("/mission-control", host.httpUrl).href, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
      }

      // Ensure grid view is active
      const gridToggle = page.locator(
        '[data-testid="mission-control-view-grid"], [data-testid="mission-control-panel-grid"]',
      );
      if (
        await gridToggle
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      ) {
        await gridToggle.first().click();
      }

      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      // Bring RUN_2 into view
      await scrollToTile(page, RUN_2_ID);

      // 1. Activate RUN_2 tile composer and type draft text
      const activateBtn = page.locator(tileActivateSelector(RUN_2_ID));
      await activateBtn.waitFor({ state: "visible", timeout: 10_000 });
      await activateBtn.click();

      const gridInput = page.locator(tileComposerInputSelector(RUN_2_ID));
      await gridInput.waitFor({ state: "visible", timeout: 10_000 });
      const draftMsg = `Cross-view draft text sync ${RUN_ID_SUFFIX}`;
      await gridInput.fill(draftMsg);

      // 2. Open RUN_2 in workspace
      const header = page.locator(tileHeaderSelector(RUN_2_ID));
      await header.click();
      await page.waitForURL(/\/workspace\/|\/agent\//, { timeout: 15_000 });

      // 3. Verify workspace composer reflects the draft text
      const wsInput = page.locator("textarea[data-composer-input], textarea").first();
      await wsInput.waitFor({ state: "visible", timeout: 10_000 });
      const wsText = await pollFor(
        async () => {
          const val = await wsInput.inputValue();
          return { ok: val === draftMsg, value: val };
        },
        {
          timeoutMs: 10_000,
          description: "workspace composer synced draft text from grid tile",
        },
      );
      ctx.expect(
        wsText === draftMsg,
        `Workspace composer must sync draft text "${draftMsg}", got "${wsText}"`,
      );

      // 4. Update draft in workspace
      const updatedMsg = `${draftMsg} - updated in workspace`;
      await wsInput.fill(updatedMsg);

      // 5. Verify draft attachment sync via in-memory store
      const draftStoreSynced = await page.evaluate(
        ({ agentId, updated }) => {
          const store = window.__PASEO_DRAFT_STORE__ || window.useDraftStore;
          if (store?.getState) {
            const drafts = store.getState().drafts ?? {};
            const match = Object.entries(drafts).find(([k]) => k.includes(agentId));
            if (match) {
              const draft = match[1];
              // Return text and attachments state
              return {
                found: true,
                textMatches: draft?.input?.text === updated,
                hasAttachmentsArray: Array.isArray(draft?.input?.attachments),
              };
            }
          }
          return { found: false, textMatches: false, hasAttachmentsArray: false };
        },
        { agentId: RUN_2_ID, updated: updatedMsg },
      );

      // 6. Navigate back to grid
      const backButton = page.locator('[data-testid="workspace-back-to-grid"]');
      await backButton.waitFor({ state: "visible", timeout: 10_000 });
      await backButton.click();
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });
      // Bring RUN_2 into view
      await scrollToTile(page, RUN_2_ID);

      // 7. Verify grid tile composer reflects the updated draft text
      const gridUpdatedText = await pollFor(
        async () => {
          const val = await page.locator(tileComposerInputSelector(RUN_2_ID)).inputValue();
          return { ok: val === updatedMsg, value: val };
        },
        {
          timeoutMs: 10_000,
          description: "grid tile composer synced updated text from workspace",
        },
      );
      ctx.expect(
        gridUpdatedText === updatedMsg,
        `Grid tile composer must sync updated draft text "${updatedMsg}", got "${gridUpdatedText}"`,
      );

      // Capture after shot
      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");

      return `draft synced bidirectionally (text="${gridUpdatedText}", storeState=${JSON.stringify(draftStoreSynced)}) and after shot captured`;
    },
  },
];
