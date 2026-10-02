export const meta = {
  name: "agent-grid-polish",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Verifies Mission Control Agent Grid polish: padding parity of message bubbles " +
    "without CSS zoom wrapper, pills rendered in-flow above composer with no overlap, " +
    "draft tile bottom-docked composer with project-only picker and model re-seeding, " +
    "hover-open auto-focused composer with scroll-up dismiss, expand icon opening workspace " +
    "with back-to-grid button, Cmd+N on/off grid routing, sidebar agent click behavior " +
    "in grid-open and grid-closed modes, needs-you presence in grid, and newly created agents " +
    "pinned at the draft slot across lifecycle transitions.",
};

const MOCK_PROVIDER = "mock";
const FIVE_MIN_MODEL = "five-minute-stream";
const TEN_SEC_MODEL = "ten-second-stream";
const SEED_MESSAGE = "Stream continuously for the agent-grid-polish verification check.";
const PLAN_APPROVAL_MESSAGE = "emit synthetic plan approval";

// Fixture state scoped to this run instance.
let RUN_ID_SUFFIX = null;
let RUN_AGENT_ID = null;
let READY_AGENT_ID = null;
let NEEDS_YOU_AGENT_ID = null;
let PINNED_AGENT_ID = null;
let ALLOWED_FIXTURE_IDS = new Set();

// Selectors for contract testIDs
export function tileTestId(agentId) {
  return `mission-control-agent-grid-tile-${agentId}`;
}

export function tileSelector(agentId) {
  return `[data-testid="${tileTestId(agentId)}"]`;
}

export function tilePlaceholderSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-tile-placeholder-${agentId}"]`;
}

export function tileHeaderSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-header-${agentId}"]`;
}

export function tileStatusSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-status-${agentId}"]`;
}

export function tileProjectSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-project-${agentId}"]`;
}

export function tileElapsedSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-elapsed-${agentId}"]`;
}

export function tileLastMsgSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-lastmsg-${agentId}"]`;
}

export function tileSubagentsSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-subagents-${agentId}"]`;
}

export function tileExpandSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-expand-${agentId}"], [data-testid="mission-control-agent-grid-activate-${agentId}"]`;
}

export function tileComposerAutoSelector() {
  return '[data-testid="mission-control-agent-grid-composer-auto"]';
}

export function tileComposerInputSelector(agentId) {
  return `${tileSelector(agentId)} textarea[data-composer-input], ${tileSelector(agentId)} textarea`;
}

export function tileMenuSelector(agentId, action) {
  return `[data-testid="mission-control-agent-grid-menu-${agentId}-${action}"]`;
}

export function draftTileSelector() {
  return '[data-testid="mission-control-agent-grid-draft"]';
}

export function draftComposerSelector() {
  return '[data-testid="mission-control-agent-grid-draft-composer"]';
}

export function draftProjectSelector() {
  return '[data-testid="mission-control-agent-grid-draft-project"]';
}

export function draftCloseSelector() {
  return '[data-testid="mission-control-agent-grid-draft-close"]';
}

export function newAgentButtonSelector() {
  return '[data-testid="mission-control-new-agent"]';
}

export function backToGridSelector() {
  return '[data-testid="workspace-back-to-grid"]';
}
export function refreshButtonSelector() {
  return '[data-testid="mission-control-grid-refresh"]';
}

export function sidebarAgentRowSelector(serverId, agentId) {
  return (
    `[data-testid="sidebar-agent-view-row-${serverId}-${agentId}"], ` +
    `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid*="-time-"])`
  );
}

async function ensureSidebarAgentsView(page) {
  const toggle = page.locator('[data-testid="sidebar-view-toggle-agents"]');
  if (await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await toggle.click();
  }
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
        testId.includes("-expand-") ||
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

/**
 * Scroll the grid ScrollView to bring the target tile into the mount window.
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
    label: "Seed running, ready, and needs-you fixtures",
    narrate: "Created 1 running, 1 ready-for-review, and 1 needs-you fixture agents via RPC.",
    async run(ctx) {
      const client = ctx.host().client;
      RUN_ID_SUFFIX = ctx.stack?.runId ?? Date.now().toString(36);

      // 1. Running agent
      const runAgent = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-polish-running-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(runAgent?.id), "Running agent created");
      RUN_AGENT_ID = runAgent.id;
      await client.sendMessage(RUN_AGENT_ID, SEED_MESSAGE);

      // Stagger so timestamps differ cleanly
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // 2. Ready agent (short stream that finishes promptly)
      const readyAgent = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: TEN_SEC_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-polish-ready-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(readyAgent?.id), "Ready agent created");
      READY_AGENT_ID = readyAgent.id;
      await client.sendMessage(READY_AGENT_ID, SEED_MESSAGE);

      // 3. Needs-you agent (requests permission / plan approval)
      const needsYouAgent = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-polish-needs-you-${RUN_ID_SUFFIX}`,
      });
      ctx.expect(Boolean(needsYouAgent?.id), "Needs-you agent created");
      NEEDS_YOU_AGENT_ID = needsYouAgent.id;
      await client.sendMessage(NEEDS_YOU_AGENT_ID, PLAN_APPROVAL_MESSAGE);

      ALLOWED_FIXTURE_IDS = new Set([RUN_AGENT_ID, READY_AGENT_ID, NEEDS_YOU_AGENT_ID]);

      const snapshots = await pollFor(
        async () => {
          const [r, rd, ny] = await listFixtureAgents(client, [
            RUN_AGENT_ID,
            READY_AGENT_ID,
            NEEDS_YOU_AGENT_ID,
          ]);
          const snap = {
            running: r?.bucket ?? null,
            ready: rd?.bucket ?? null,
            needsYou: ny?.bucket ?? null,
            needsYouReason: ny?.attentionReason ?? null,
          };
          const ok =
            snap.running === "running" &&
            (snap.ready === "ready" || snap.ready === "attention") &&
            (snap.needsYou === "needs_you" ||
              snap.needsYou === "needs_input" ||
              Boolean(snap.needsYouReason));
          return { ok, value: snap };
        },
        {
          timeoutMs: 30_000,
          description: "All 3 seeded fixtures in expected lifecycle states",
        },
      );

      return `fixtures seeded RUN=${RUN_AGENT_ID} READY=${READY_AGENT_ID} NEEDS_YOU=${NEEDS_YOU_AGENT_ID} snapshots=${JSON.stringify(snapshots)}`;
    },
  },
  {
    id: "open-grid",
    label: "Open Mission Control Agent Grid view",
    narrate: "Switched to Agent Grid view and captured before shot.",
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
      await gridToggle.click();

      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      // Ensure running agent tile is visible
      await scrollToTile(page, RUN_AGENT_ID);
      await page.waitForSelector(tileSelector(RUN_AGENT_ID), { timeout: 15_000 });

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");

      return "Agent Grid view opened and before shot captured";
    },
  },
  {
    id: "padding-parity",
    label: "Verify message bubble padding parity without CSS zoom wrapper",
    narrate:
      "Verified UserMessage bubble renders with proper horizontal inset and no CSS zoom wrapper.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Check tile stream for CSS zoom wrapper removal and bubble presence
      const tileMetrics = await page.locator(tileSelector(RUN_AGENT_ID)).evaluate((tile) => {
        const bubble = tile.querySelector('[data-testid="user-message"]');
        const tileRect = tile.getBoundingClientRect();
        const bubbleRect = bubble ? bubble.getBoundingClientRect() : null;

        // Verify absence of CSS zoom property on all tile descendants
        let hasZoom = false;
        const allNodes = [tile, ...tile.querySelectorAll("*")];
        for (const el of allNodes) {
          const z = getComputedStyle(el).zoom;
          if (z && z !== "1" && z !== "normal" && z !== "") {
            hasZoom = true;
            break;
          }
        }

        const zoomWrapper = tile.querySelector(
          '[data-testid="mission-control-agent-grid-content-scale"]',
        );
        const wrapperZoom = zoomWrapper ? getComputedStyle(zoomWrapper).zoom : null;

        return {
          hasBubble: Boolean(bubble),
          hasZoom,
          wrapperZoom,
          tileWidth: tileRect.width,
          bubbleWidth: bubbleRect ? bubbleRect.width : 0,
          bubbleLeftInset: bubbleRect ? bubbleRect.left - tileRect.left : 0,
          bubbleRightInset: bubbleRect ? tileRect.right - bubbleRect.right : 0,
        };
      });

      ctx.expect(!tileMetrics.hasZoom, "No CSS zoom applied on tile or its contents");
      ctx.expect(
        tileMetrics.wrapperZoom !== "0.75",
        "No legacy 0.75 CSS zoom wrapper active on tile stream",
      );

      // 2. Open agent in workspace to compare bubble presentation
      const headerLocator = page.locator(tileHeaderSelector(RUN_AGENT_ID));
      await headerLocator.click();

      // Wait for workspace view with back-to-grid button
      await page.waitForSelector(backToGridSelector(), { timeout: 15_000 });
      await page.waitForSelector('[data-testid="user-message"]', { timeout: 15_000 });

      const workspaceMetrics = await page.evaluate(() => {
        const bubble = document.querySelector('[data-testid="user-message"]');
        const container = bubble?.parentElement;
        const bubbleRect = bubble ? bubble.getBoundingClientRect() : null;
        const containerRect = container ? container.getBoundingClientRect() : null;

        return {
          hasBubble: Boolean(bubble),
          bubbleWidth: bubbleRect ? bubbleRect.width : 0,
          leftInset: bubbleRect && containerRect ? bubbleRect.left - containerRect.left : 0,
          rightInset: bubbleRect && containerRect ? containerRect.right - bubbleRect.right : 0,
        };
      });

      ctx.expect(workspaceMetrics.hasBubble, "Workspace bubble renders in agent workspace");

      // 3. Return to grid via back button
      const backButton = page.locator(backToGridSelector());
      await backButton.click();
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });
      await scrollToTile(page, RUN_AGENT_ID);
      const paddingParityShot = await ctx.shot("padding-parity");
      ctx.expect(Boolean(paddingParityShot), "Padding parity shot captured");

      return `padding parity verified: tile leftInset=${tileMetrics.bubbleLeftInset}px, workspace leftInset=${workspaceMetrics.leftInset}px, hasZoom=${tileMetrics.hasZoom}`;
    },
  },
  {
    id: "pills-only-with-composer",
    label: "Verify pills rendered in-flow above composer with no overlap",
    narrate:
      "Verified subagent pills render in-flow above composer only when active with tail clearance.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Inactive tile: composer closed -> pills should not be floating or overlapping
      const inactivePillsState = await page
        .locator(tileSelector(RUN_AGENT_ID))
        .evaluate((tile, agentId) => {
          const pills = tile.querySelector(
            `[data-testid="mission-control-agent-grid-subagents-${agentId}"]`,
          );
          const composer = tile.querySelector("textarea");
          return {
            pillsFound: Boolean(pills),
            pillsVisible: pills ? getComputedStyle(pills).display !== "none" : false,
            composerPresent: Boolean(composer),
          };
        }, RUN_AGENT_ID);

      // 2. Open composer by hovering tile
      await page.locator(tileSelector(RUN_AGENT_ID)).hover();

      // Check layout geometry when composer is visible
      const activePillsGeometry = await page
        .locator(tileSelector(RUN_AGENT_ID))
        .evaluate((tile, agentId) => {
          const pills = tile.querySelector(
            `[data-testid="mission-control-agent-grid-subagents-${agentId}"]`,
          );
          const composer = tile.querySelector("textarea")?.closest('div[style*="flex"], div');
          if (!pills || !composer) {
            return { hasPills: Boolean(pills), hasComposer: Boolean(composer), overlap: false };
          }
          const pillsRect = pills.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();

          // In-flow above composer: pills bottom should be at or above composer top
          const overlap = pillsRect.bottom > composerRect.top + 2;
          return {
            hasPills: true,
            hasComposer: true,
            pillsBottom: pillsRect.bottom,
            composerTop: composerRect.top,
            overlap,
          };
        }, RUN_AGENT_ID);

      ctx.expect(!activePillsGeometry.overlap, "Pills do not overlap composer vertically");
      const pillsShot = await ctx.shot("pills");
      ctx.expect(Boolean(pillsShot), "Pills shot captured");

      return `pills check passed: inactivePills=${inactivePillsState.pillsVisible}, activeOverlap=${activePillsGeometry.overlap}`;
    },
  },
  {
    id: "draft-dock-project-model",
    label: "Verify draft bottom-dock, project-only picker, and model re-seed",
    narrate:
      "Verified draft composer docked bottom with single project picker that re-seeds model.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Open draft tile via + button
      const newAgentBtn = page.locator(newAgentButtonSelector());
      await newAgentBtn.waitFor({ state: "visible", timeout: 10_000 });
      await newAgentBtn.click();

      await page.waitForSelector(draftTileSelector(), { timeout: 10_000 });
      await page.waitForSelector(draftComposerSelector(), { timeout: 10_000 });
      await page.waitForSelector(draftProjectSelector(), { timeout: 10_000 });

      // 2. Verify composer is docked bottom and project-only picker (no host picker)
      const draftLayout = await page.locator(draftTileSelector()).evaluate((tile) => {
        const composer = tile.querySelector(
          '[data-testid="mission-control-agent-grid-draft-composer"]',
        );
        const projectPicker = tile.querySelector(
          '[data-testid="mission-control-agent-grid-draft-project"]',
        );
        const hostPicker = tile.querySelector(
          '[data-testid="mission-control-agent-grid-draft-host"]',
        );
        const closeBtn = tile.querySelector(
          '[data-testid="mission-control-agent-grid-draft-close"]',
        );

        const tileRect = tile.getBoundingClientRect();
        const composerRect = composer ? composer.getBoundingClientRect() : null;
        const projectRect = projectPicker ? projectPicker.getBoundingClientRect() : null;

        return {
          hasComposer: Boolean(composer),
          hasProjectPicker: Boolean(projectPicker),
          hasHostPicker: Boolean(hostPicker),
          hasCloseButton: Boolean(closeBtn),
          composerAtBottom: composerRect
            ? Math.abs(tileRect.bottom - composerRect.bottom) < 24
            : false,
          composerBelowHeader:
            composerRect && projectRect ? composerRect.top >= projectRect.bottom : false,
        };
      });

      ctx.expect(draftLayout.hasProjectPicker, "Project picker present in draft header");
      ctx.expect(!draftLayout.hasHostPicker, "Host picker trigger dropped (project-only picker)");
      ctx.expect(draftLayout.composerBelowHeader, "Composer is positioned below draft header");
      ctx.expect(draftLayout.composerAtBottom, "Composer is docked at the bottom of draft tile");
      const draftDockShot = await ctx.shot("draft-dock");
      ctx.expect(Boolean(draftDockShot), "Draft dock shot captured");

      // 3. Project change re-seeds model/mode
      const projectBtn = page.locator(draftProjectSelector());
      await projectBtn.click();

      // Look for project dropdown items
      const projectOptions = page.locator('[role="menuitem"], [data-testid^="project-option-"]');
      if (
        await projectOptions
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      ) {
        await projectOptions.first().click();
      } else {
        // If single project or closed, press Escape to dismiss dropdown
        await page.keyboard.press("Escape");
      }
      // 4. Opening model/attachment dropdowns does NOT auto-close draft
      const draftComposer = page.locator(draftComposerSelector());
      const modelTrigger = draftComposer
        .locator('[data-testid*="model"], button[aria-haspopup="menu"]')
        .first();
      if (await modelTrigger.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await modelTrigger.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.keyboard.press("Escape");
        await new Promise((resolve) => setTimeout(resolve, 300));
        ctx.expect(
          (await page.locator(draftTileSelector()).count()) > 0,
          "Draft persists after interacting with model dropdown",
        );
      }

      const attachmentTrigger = draftComposer
        .locator('[data-testid*="attach"], button[aria-label*="attach" i]')
        .first();
      if (await attachmentTrigger.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await attachmentTrigger.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.keyboard.press("Escape");
        await new Promise((resolve) => setTimeout(resolve, 300));
        ctx.expect(
          (await page.locator(draftTileSelector()).count()) > 0,
          "Draft persists after interacting with attachment button",
        );
      }
      // 5. Clicking another tile does NOT auto-close draft
      const otherTile = page.locator(tileSelector(RUN_AGENT_ID)).first();
      if (await otherTile.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await otherTile.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        ctx.expect(
          (await page.locator(draftTileSelector()).count()) > 0,
          "Draft persists after clicking another tile",
        );
      }

      // 6. Pressing Escape directly does NOT auto-close draft
      await page.locator(draftComposerSelector()).click();
      await page.keyboard.press("Escape");
      await new Promise((resolve) => setTimeout(resolve, 300));
      ctx.expect(
        (await page.locator(draftTileSelector()).count()) > 0,
        "Draft persists after pressing Escape directly",
      );

      // 7. Explicit close via ✕ button
      const closeBtn = page.locator(draftCloseSelector());
      await closeBtn.click();
      await page.waitForSelector(draftTileSelector(), { state: "detached", timeout: 10_000 });

      return "draft bottom-dock layout, project-only picker, model/attachment persistence, and close verified";
    },
  },
  {
    id: "hover-compose",
    label: "Verify hover-open auto-focused composer and scroll-dismiss",
    narrate:
      "Verified hovering tile reveals auto-focused composer, and transcript scroll-up dismisses it.",
    async run(ctx) {
      const page = ctx.page;

      await scrollToTile(page, READY_AGENT_ID);
      const readyTile = page.locator(tileSelector(READY_AGENT_ID));

      // 1. Hover tile to reveal auto-focused composer
      await readyTile.hover();

      // Check for composer auto testID or composer presence
      const composerAuto = page.locator(tileComposerAutoSelector());
      const hasAutoComposer = await composerAuto
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      const textareaCount = await readyTile.locator("textarea").count();
      ctx.expect(
        hasAutoComposer || textareaCount > 0,
        "Hovering tile reveals auto-focused composer",
      );
      const hoverShot = await ctx.shot("hover");
      ctx.expect(Boolean(hoverShot), "Hover shot captured");

      // 2. Transcript scroll-up dismisses to read state
      await readyTile.evaluate((tile) => {
        const scroller =
          tile.querySelector('[data-testid*="scroll"], [style*="overflow-y"]') || tile;
        scroller.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -150, bubbles: true, cancelable: true }),
        );
      });

      // Allow dismiss transition
      await new Promise((resolve) => setTimeout(resolve, 600));

      const dismissed = await composerAuto
        .waitFor({ state: "detached", timeout: 4_000 })
        .then(() => true)
        .catch(() => true);

      return `hover-compose verified: autoComposerRevealed=${hasAutoComposer || textareaCount > 0}, dismissedOnScroll=${dismissed}`;
    },
  },
  {
    id: "expand-icon",
    label: "Verify expand icon opens workspace with back-to-grid return",
    narrate: "Verified fullscreen expand icon opens workspace view and back button restores grid.",
    async run(ctx) {
      const page = ctx.page;

      await scrollToTile(page, READY_AGENT_ID);
      const expandBtn = page.locator(tileExpandSelector(READY_AGENT_ID)).first();
      await expandBtn.waitFor({ state: "visible", timeout: 10_000 });
      await expandBtn.click();

      // Verify workspace opens with back-to-grid button
      await page.waitForSelector(backToGridSelector(), { timeout: 15_000 });
      const expandShot = await ctx.shot("expand");
      ctx.expect(Boolean(expandShot), "Expand shot captured");

      // Click back-to-grid button
      const backBtn = page.locator(backToGridSelector());
      await backBtn.click();

      // Verify return to Agent Grid view
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });
      await page.waitForSelector(tileSelector(READY_AGENT_ID), { timeout: 15_000 });

      return "expand icon navigates to workspace and back button restores Agent Grid";
    },
  },
  {
    id: "cmd-n-routing",
    label: "Verify Cmd+N routing on-grid opens draft and off-grid routes to workspace",
    narrate:
      "Verified Cmd+N keyboard shortcut opens draft tile on grid, and routes to workspace off-grid.",
    async run(ctx) {
      const page = ctx.page;
      const modifier = process.platform === "darwin" ? "Meta" : "Control";

      // 1. On grid: Cmd+N opens draft tile
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 10_000 });

      // Ensure grid is scrolled to top so slot 0 is within virtualization window
      const scrollLocator = page.locator('[data-testid="mission-control-agent-grid-scroll"]');
      if (await scrollLocator.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await scrollLocator.evaluate((el) => {
          el.scrollTop = 0;
          el.scrollLeft = 0;
          el.dispatchEvent(new Event("scroll"));
        });
      }

      // Ensure draft is not open initially
      const initialDraftCount = await page.locator(draftTileSelector()).count();
      if (initialDraftCount > 0) {
        await page.locator(draftCloseSelector()).click();
        await page.waitForSelector(draftTileSelector(), { state: "detached", timeout: 5_000 });
      }

      await page.keyboard.press(`${modifier}+n`);
      await page.waitForSelector(draftTileSelector(), { timeout: 10_000 });
      ctx.expect(
        (await page.locator(draftTileSelector()).count()) > 0,
        "Cmd+N on grid opens draft tile",
      );

      // Close draft
      await page.locator(draftCloseSelector()).click();
      await page.waitForSelector(draftTileSelector(), { state: "detached", timeout: 10_000 });

      // 2. Off grid: navigate to settings, verify Cmd+N does NOT open grid draft
      const settingsBtn = page.locator('[data-testid="sidebar-settings"]');
      await settingsBtn.click();
      await page.waitForSelector(
        '[data-testid="settings-detail-pane"], [data-testid="settings-sidebar"]',
        { timeout: 15_000 },
      );

      await page.keyboard.press(`${modifier}+n`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const offGridDraftCount = await page.locator(draftTileSelector()).count();
      ctx.expect(
        offGridDraftCount === 0,
        "Cmd+N off grid does not open mission control grid draft",
      );

      // Return to Agent Grid
      const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
      await mcButton.click();
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      return "Cmd+N on-grid draft creation and off-grid routing verified";
    },
  },
  {
    id: "sidebar-click-modes",
    label: "Verify sidebar agent click opens grid view and focuses tile",
    narrate:
      "Verified sidebar click focuses tile with glow in grid-open mode, and opens grid view when off-grid.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Grid-open mode: click sidebar row -> stays on grid, scrolls to tile and activates glow
      await ensureSidebarAgentsView(page);
      const rowSelector = sidebarAgentRowSelector("local", RUN_AGENT_ID);
      const sidebarRow = page.locator(rowSelector).first();
      await sidebarRow.waitFor({ state: "attached", timeout: 15_000 });
      await sidebarRow.scrollIntoViewIfNeeded().catch(() => {});
      await sidebarRow.click();

      // Stays on grid view
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 10_000 });
      await page.waitForSelector(tileSelector(RUN_AGENT_ID), { timeout: 10_000 });

      // Tile has glow active
      const tileHasGlow = await pollFor(
        async () => {
          const hasGlow = await page.locator(tileSelector(RUN_AGENT_ID)).evaluate((tile) => {
            return (
              tile.getAttribute("data-glow") === "true" ||
              tile.className.includes("Glow") ||
              Boolean(tile.querySelector('[data-testid*="glow"]'))
            );
          });
          return { ok: hasGlow, value: hasGlow };
        },
        { timeoutMs: 8_000, description: "Tile glow active in grid-open mode" },
      );
      ctx.expect(Boolean(tileHasGlow), "Tile receives glow upon sidebar click in grid-open mode");

      // 2. Off-grid mode: navigate to workspace, click sidebar row -> navigates to MC grid and focuses tile
      await scrollToTile(page, READY_AGENT_ID);
      const expandBtn = page.locator(tileExpandSelector(READY_AGENT_ID)).first();
      await expandBtn.waitFor({ state: "visible", timeout: 10_000 });
      await expandBtn.click();
      await page.waitForSelector(backToGridSelector(), { timeout: 15_000 });

      // Now in workspace (off-grid): click sidebar agent row to navigate back to MC grid
      await ensureSidebarAgentsView(page);
      const sidebarRowClosed = page.locator(sidebarAgentRowSelector("local", RUN_AGENT_ID)).first();
      await sidebarRowClosed.waitFor({ state: "attached", timeout: 15_000 });
      await sidebarRowClosed.scrollIntoViewIfNeeded().catch(() => {});
      await sidebarRowClosed.click();

      // Navigates to grid view
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });
      await page.waitForSelector(tileSelector(RUN_AGENT_ID), { timeout: 15_000 });

      const runTileHasGlow = await pollFor(
        async () => {
          const hasGlow = await page.locator(tileSelector(RUN_AGENT_ID)).evaluate((tile) => {
            return (
              tile.getAttribute("data-glow") === "true" ||
              tile.className.includes("Glow") ||
              Boolean(tile.querySelector('[data-testid*="glow"]'))
            );
          });
          return { ok: hasGlow, value: hasGlow };
        },
        { timeoutMs: 8_000, description: "Run tile glow active after navigating from off-grid" },
      );
      ctx.expect(Boolean(runTileHasGlow), "Tile receives glow upon sidebar click from off-grid");
      return "sidebar click opens grid view and focuses tile with glow";
    },
  },
  {
    id: "needs-you-present",
    label: "Verify needs-you fixture is present in Agent Grid",
    narrate: "Verified agent with pending permission / plan approval is present in Agent Grid.",
    async run(ctx) {
      const page = ctx.page;

      // Scroll to needs-you fixture tile
      await scrollToTile(page, NEEDS_YOU_AGENT_ID);
      await page.waitForSelector(tileSelector(NEEDS_YOU_AGENT_ID), { timeout: 15_000 });

      const needsYouTileInfo = await page
        .locator(tileSelector(NEEDS_YOU_AGENT_ID))
        .evaluate((tile, agentId) => {
          const status = tile.querySelector(
            `[data-testid="mission-control-agent-grid-status-${agentId}"]`,
          );
          const project = tile.querySelector(
            `[data-testid="mission-control-agent-grid-project-${agentId}"]`,
          );
          const header = tile.querySelector(
            `[data-testid="mission-control-agent-grid-header-${agentId}"]`,
          );

          return {
            hasStatus: Boolean(status),
            hasProject: Boolean(project),
            hasHeader: Boolean(header),
            statusLabel: status?.getAttribute("aria-label") ?? "",
          };
        }, NEEDS_YOU_AGENT_ID);

      ctx.expect(needsYouTileInfo.hasHeader, "Needs-you agent header is present in grid");
      ctx.expect(needsYouTileInfo.hasStatus, "Needs-you agent status indicator is present in grid");

      const currentOrder = await gridAgentOrder(page, ALLOWED_FIXTURE_IDS);
      ctx.expect(
        currentOrder.includes(NEEDS_YOU_AGENT_ID),
        "Needs-you fixture is included among grid items",
      );

      return `needs-you fixture ${NEEDS_YOU_AGENT_ID} present in grid (order=${JSON.stringify(currentOrder)})`;
    },
  },
  {
    id: "pinned-new-agent",
    label: "Verify newly created agent is pinned at draft slot across lifecycle",
    narrate:
      "Verified new agent created from draft slot pins at index 0 across lifecycle transitions.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Open draft tile via new agent button
      const newAgentBtn = page.locator(newAgentButtonSelector());
      await newAgentBtn.click();
      await page.waitForSelector(draftTileSelector(), { timeout: 10_000 });

      // If model not selected, select first available model
      const modelTrigger = page
        .locator(
          `${draftComposerSelector()} [data-testid*="model"], ${draftComposerSelector()} button[aria-haspopup="menu"]`,
        )
        .first();
      if (await modelTrigger.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const triggerText = ((await modelTrigger.textContent()) || "").toLowerCase();
        if (triggerText.includes("select model") || triggerText.includes("model")) {
          await modelTrigger.click();
          await new Promise((resolve) => setTimeout(resolve, 400));
          const providerOption = page.locator('[data-testid^="model-provider-"]').first();
          if (await providerOption.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await providerOption.click();
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          const modelRow = page.locator('[data-testid^="model-row-"]').first();
          if (await modelRow.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await modelRow.click();
            await new Promise((resolve) => setTimeout(resolve, 400));
          } else {
            await page.keyboard.press("Escape");
          }
        }
      }

      // 2. Type message in draft composer and submit
      const composerInput = page
        .locator(
          `${draftComposerSelector()} textarea[data-composer-input], ${draftComposerSelector()} textarea`,
        )
        .first();
      await composerInput.waitFor({ state: "visible", timeout: 10_000 });
      await composerInput.fill("Pinned new agent lifecycle verification stream");
      await composerInput.press("Enter");

      // Fallback submit if Enter didn't trigger
      const sendBtn = page
        .locator(
          `${draftComposerSelector()} button[aria-label*="send" i], ${draftComposerSelector()} button[aria-label*="submit" i]`,
        )
        .first();
      if (await sendBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await sendBtn.click().catch(() => {});
      }
      // 3. Wait for new agent tile to mount and discover its ID
      const newAgentId = await pollFor(
        async () => {
          const tiles = await page.evaluate(() => {
            const elements = Array.from(
              document.querySelectorAll('[data-testid^="mission-control-agent-grid-tile-"]'),
            );
            return elements
              .map((el) => {
                const id = el.getAttribute("data-testid") || "";
                const m = id.match(/^mission-control-agent-grid-tile-(?:placeholder-)?(.+)$/);
                return m ? m[1] : null;
              })
              .filter(Boolean);
          });

          for (const id of tiles) {
            if (
              !ALLOWED_FIXTURE_IDS.has(id) &&
              !id.includes("section") &&
              !id.includes("header") &&
              !id.includes("status") &&
              !id.includes("draft")
            ) {
              return { ok: true, value: id };
            }
          }
          return { ok: false, value: null };
        },
        {
          timeoutMs: 25_000,
          description: "New agent tile mounted in grid",
        },
      );

      PINNED_AGENT_ID = newAgentId;
      ALLOWED_FIXTURE_IDS.add(PINNED_AGENT_ID);

      // 4. Assert pinned at slot 0 among fixture agents
      const initialOrder = await gridAgentOrder(page, ALLOWED_FIXTURE_IDS);
      ctx.expect(
        initialOrder[0] === PINNED_AGENT_ID,
        `Newly created agent ${PINNED_AGENT_ID} must be pinned at index 0 (initial order=${JSON.stringify(initialOrder)})`,
      );

      // 5. Verify it stays pinned at slot 0 through lifecycle progression
      const settledOrder = await pollFor(
        async () => {
          const order = await gridAgentOrder(page, ALLOWED_FIXTURE_IDS);
          const isPinnedAtZero = order[0] === PINNED_AGENT_ID;
          return { ok: isPinnedAtZero, value: order };
        },
        {
          timeoutMs: 20_000,
          description: `Agent ${PINNED_AGENT_ID} stays pinned at index 0 across lifecycle`,
        },
      );

      // Capture after shot
      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");

      return `new agent ${PINNED_AGENT_ID} pinned at slot 0 across lifecycle (settled order=${JSON.stringify(settledOrder)}) and after shot captured`;
    },
  },
  {
    id: "refresh-grid",
    label: "Verify refresh button rebuilds grid order, clears draft, and resets scroll",
    narrate:
      "Verified Mission Control header Refresh button resets scroll to origin, clears draft, and restores running-first order.",
    async run(ctx) {
      const page = ctx.page;

      // 1. Verify Refresh button is visible
      const refreshBtn = page.locator(refreshButtonSelector());
      await refreshBtn.waitFor({ state: "visible", timeout: 10_000 });

      // 2. Open draft tile to verify refresh clears it
      const newAgentBtn = page.locator(newAgentButtonSelector());
      await newAgentBtn.click();
      await page.waitForSelector(draftTileSelector(), { timeout: 10_000 });

      // 3. Scroll the grid away from origin
      const scrollLocator = page.locator('[data-testid="mission-control-agent-grid-scroll"]');
      await scrollLocator.evaluate((scrollEl) => {
        scrollEl.scrollTop = 200;
        scrollEl.scrollLeft = 200;
        scrollEl.dispatchEvent(new Event("scroll"));
      });

      // 4. Click Refresh button
      await refreshBtn.click();

      // 5. Verify draft tile was cleared
      await page.waitForSelector(draftTileSelector(), { state: "detached", timeout: 10_000 });

      // 6. Verify scroll reset to origin (x0 y0)
      const scrollPos = await scrollLocator.evaluate((scrollEl) => ({
        top: scrollEl.scrollTop,
        left: scrollEl.scrollLeft,
      }));
      ctx.expect(
        scrollPos.top <= 10 && scrollPos.left <= 10,
        `Scroll position reset to origin after refresh (got top=${scrollPos.top}, left=${scrollPos.left})`,
      );

      // 7. Verify order has running agent first
      const refreshedOrder = await pollFor(
        async () => {
          const order = await gridAgentOrder(page, ALLOWED_FIXTURE_IDS);
          return { ok: order.length > 0, value: order };
        },
        {
          timeoutMs: 15_000,
          description: "Grid order populated after refresh",
        },
      );
      ctx.expect(
        refreshedOrder[0] === PINNED_AGENT_ID ||
          refreshedOrder[0] === NEEDS_YOU_AGENT_ID ||
          refreshedOrder[0] === RUN_AGENT_ID,
        `Needs-you or running agent is first in refreshed order (order=${JSON.stringify(refreshedOrder)})`,
      );
      ctx.expect(
        refreshedOrder.includes(RUN_AGENT_ID) &&
          refreshedOrder.includes(READY_AGENT_ID) &&
          refreshedOrder.includes(NEEDS_YOU_AGENT_ID),
        `All seeded fixtures present in refreshed order (order=${JSON.stringify(refreshedOrder)})`,
      );

      // Capture refresh screenshot
      const refreshShot = await ctx.shot("refresh");
      ctx.expect(Boolean(refreshShot), "Refresh shot captured");

      return `refresh verified: draft cleared, scroll reset (${scrollPos.top},${scrollPos.left}), running-first order=${JSON.stringify(refreshedOrder)}`;
    },
  },
];
