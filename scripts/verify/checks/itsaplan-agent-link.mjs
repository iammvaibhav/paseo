export const meta = {
  name: "itsaplan-agent-link",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Clicking a paseo:// agent deep link in a live itsaplan comment follows the protocol (same-window), instead of a silent target=_blank no-op.",
};

const ISSUE_PATH = "/project/PASEO/issue/8";

function liveItsaplanOrigin() {
  return process.env.ITSAPLAN_WEB_ORIGIN || "http://10.7.0.1:3001";
}

function liveItsaplanLogin() {
  const identifier = process.env.ITSAPLAN_WEB_USER;
  const password = process.env.ITSAPLAN_WEB_PASSWORD;
  if (!identifier || !password) {
    return null;
  }
  return { identifier, password };
}

export const steps = [
  {
    id: "login",
    label: "Sign in to live itsaplan web UI",
    narrate: "Signed in to itsaplan so the issue activity feed is visible.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(
        Boolean(page),
        "Playwright page must be available for UI tier"
      );
      const login = liveItsaplanLogin();
      ctx.expect(
        Boolean(login),
        "ITSAPLAN_WEB_USER and ITSAPLAN_WEB_PASSWORD must be set (live itsaplan click-through cannot be reproduced in the mock stack)"
      );

      const origin = liveItsaplanOrigin();
      await page.goto(`${origin}/login`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.fill("#identifier", login.identifier);
      await page.fill("#password", login.password);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.includes("/login"), {
        timeout: 30_000,
      });
      return `signed in at ${origin}`;
    },
  },
  {
    id: "open-issue",
    label: "Open PASEO-8 and find the dispatched agent link",
    narrate: "Issue activity shows an underlined paseo:// agent link.",
    async run(ctx) {
      const page = ctx.page;
      const origin = liveItsaplanOrigin();
      await page.goto(`${origin}${ISSUE_PATH}`, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });
      const link = page.locator('a[href^="paseo://"]').first();
      await link.waitFor({ state: "visible", timeout: 20_000 });
      const href = await link.getAttribute("href");
      ctx.expect(
        Boolean(href && href.startsWith("paseo://")),
        `first agent href is ${href}`
      );
      ctx.agentHref = href;
      await ctx.shot("before");
      return href;
    },
  },
  {
    id: "click-through",
    label: "Click the agent link; Chromium must attempt paseo:// navigation",
    narrate:
      "Click assigned paseo:// on the current window instead of a silent _blank.",
    async run(ctx) {
      const page = ctx.page;
      const href = ctx.agentHref;
      ctx.expect(Boolean(href), "previous step captured the agent href");

      const failed = [];
      const onFailed = (request) => {
        if (request.url().startsWith("paseo:")) failed.push(request.url());
      };
      page.on("requestfailed", onFailed);

      let navigatedTo = null;
      const navPromise = page
        .waitForEvent("framenavigated", { timeout: 8_000 })
        .then((frame) => {
          navigatedTo = frame.url();
          return navigatedTo;
        })
        .catch(() => null);

      await page.locator(`a[href="${href}"]`).first().click();
      await Promise.race([navPromise, page.waitForTimeout(8_000)]);
      page.off("requestfailed", onFailed);

      const attempted = Boolean(
        (navigatedTo && navigatedTo.startsWith("paseo:")) ||
          failed.some((url) => url.startsWith("paseo:"))
      );
      ctx.expect(
        attempted,
        `clicking ${href} must navigate or fail-request the paseo:// scheme (got nav=${
          navigatedTo || "none"
        } failed=${failed.join(",") || "none"})`
      );
      await ctx.shot("after");
      return `attempted ${href}`;
    },
  },
];
