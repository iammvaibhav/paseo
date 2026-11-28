export const meta = {
  name: "ui-sidebar-no-usage-bar",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Asserts the sidebar has no usage summary row (provider percents above the footer icons) at " +
    "phone and desktop widths while the footer Usage icon still opens the Usage modal, that the " +
    "search agents field sits 8px below the nav divider and 8px in from the sidebar edge like " +
    "the rows, and that Settings > Sidebar lists no footer Usage item.",
};

const UI_TIMEOUT_MS = 20_000;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 860 };
// spacing[2]: the nav rows' top padding and the rows' horizontal inset.
const EXPECTED_INSET = 8;

/** Field geometry relative to the divider above it and the sidebar column. */
async function searchGeometry(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect : null;
    };
    const pick = (selector) =>
      [...document.querySelectorAll(selector)].map(visible).find(Boolean) ?? null;
    const bar = pick('[data-testid="sidebar-search-bar"]');
    const divider = pick('[data-testid="sidebar-nav-separator"]');
    const footer = pick('[data-testid="sidebar-footer"]');
    if (!bar || !divider || !footer) {
      return { missing: { bar: !bar, divider: !divider, footer: !footer } };
    }
    const barEl = [...document.querySelectorAll('[data-testid="sidebar-search-bar"]')].find((el) =>
      visible(el),
    );
    const field = visible(barEl.firstElementChild);
    return {
      gapBelowDivider: Math.round(field.top - divider.bottom),
      leftInset: Math.round(field.left - footer.left),
      rightInset: Math.round(footer.right - field.right),
    };
  });
}

async function assertSidebar(ctx, label) {
  const page = ctx.page;
  await page
    .getByTestId("sidebar-footer")
    .first()
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  // Give a usage summary time to load reports and render if it still existed.
  await page.waitForTimeout(4_000);
  const summaryCount = await page.locator('[data-testid="sidebar-usage"]').count();
  ctx.expect(summaryCount === 0, `${label}: sidebar usage summary rendered (${summaryCount})`);
  const pinned = await page.locator('[data-testid="sidebar-usage-pinned-window"]').count();
  ctx.expect(pinned === 0, `${label}: ${pinned} pinned usage windows in the sidebar`);

  const geometry = await searchGeometry(page);
  ctx.expect(!geometry.missing, `${label}: missing ${JSON.stringify(geometry.missing)}`);
  ctx.expect(
    geometry.gapBelowDivider === EXPECTED_INSET,
    `${label}: search field is ${geometry.gapBelowDivider}px below the divider, expected ${EXPECTED_INSET}`,
  );
  ctx.expect(
    geometry.leftInset === EXPECTED_INSET && geometry.rightInset === EXPECTED_INSET,
    `${label}: search field insets ${geometry.leftInset}/${geometry.rightInset}px, expected ${EXPECTED_INSET}`,
  );
  return geometry;
}

async function openUsageFromFooter(ctx, label) {
  const page = ctx.page;
  const icon = page.locator('[data-testid="sidebar-usage-icon"]:visible').first();
  if ((await icon.count()) === 0) {
    await page.locator('[data-testid="sidebar-footer-overflow"]:visible').first().click();
    await page.locator('[data-testid="sidebar-usage-icon"]:visible').first().click();
  } else {
    await icon.click();
  }
  const modal = page.getByTestId("usage-modal").first();
  await modal.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await ctx.shot(`${label}-usage-modal`);
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
}

export const steps = [
  {
    id: "desktop",
    label: "Desktop sidebar: no usage summary, search field padded like the rows",
    narrate:
      "On desktop the sidebar footer has no usage percentages, and the search field has room above it.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize(DESKTOP);
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: UI_TIMEOUT_MS,
      });
      const geometry = await assertSidebar(ctx, "desktop");
      await ctx.shot("before");
      await ctx.shot("desktop");
      await openUsageFromFooter(ctx, "desktop");
      return `no summary; search gap ${geometry.gapBelowDivider}px, insets ${geometry.leftInset}/${geometry.rightInset}px; Usage modal opens`;
    },
  },
  {
    id: "phone",
    label: "Phone sidebar: no usage summary, search field padded like the rows",
    narrate:
      "At phone width the open sidebar shows the same: no usage row, and a padded search field.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize(PHONE);
      await page.waitForTimeout(1_500);
      const menu = page.locator('[data-testid="menu-button"]:visible').first();
      await menu.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await menu.click();
      await page
        .locator('[data-testid="sidebar-search-input"]:visible')
        .first()
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const geometry = await assertSidebar(ctx, "phone");
      await ctx.shot("after");
      await ctx.shot("phone");
      return `no summary; search gap ${geometry.gapBelowDivider}px, insets ${geometry.leftInset}/${geometry.rightInset}px`;
    },
  },
  {
    id: "settings",
    label: "Settings > Sidebar lists no footer Usage item",
    narrate: "Sidebar settings no longer offer a Usage row for the footer.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize(DESKTOP);
      await page.goto(`${ctx.host().httpUrl}/settings/sidebar`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await page
        .getByTestId("sidebar-nav-section-header")
        .first()
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const usageRow = await page.locator('[data-testid="sidebar-nav-item-usage"]').count();
      ctx.expect(usageRow === 0, `Settings > Sidebar still lists a Usage item (${usageRow})`);
      await ctx.shot("settings-sidebar");
      return "no Usage item in Settings > Sidebar";
    },
  },
];
