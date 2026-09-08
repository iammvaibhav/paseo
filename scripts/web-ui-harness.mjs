#!/usr/bin/env node
// Bring up the daemon-served Paseo web UI in a real Chromium with every host
// already connected, so an agent can drive the actual app instead of guessing.
//
// Why this exists: the agent-browser tabs available to an agent belong to the
// user's DESKTOP app, which runs on another machine. Its Chromium loads that
// machine's 127.0.0.1 and cannot reach this host's WireGuard peers, so seeding
// a host registry there connects nothing. This script runs Chromium HERE, where
// 10.7.0.x is reachable, and exposes it over CDP.
//
// Host discovery is dynamic. A registry entry only connects when its serverId
// matches the daemon behind the endpoint, and that id is not in any local file
// for a peer — GET /api/status returns it (bearer = the daemon password).
//
// Usage:
//   node scripts/web-ui-harness.mjs                 # seed, verify, keep alive on CDP 9222
//   node scripts/web-ui-harness.mjs --once          # seed, verify, screenshot, exit
//   node scripts/web-ui-harness.mjs --cdp-port 9333
//   node scripts/web-ui-harness.mjs --url http://127.0.0.1:6767
//
// Attach from an omp eval cell:
//   const tab = await browser.open({ name: "paseo", app: { cdp_url: "http://127.0.0.1:9222" } });

import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const REGISTRY_KEY = "@paseo:daemon-registry";
const CHROMIUM_CANDIDATES = [
  "/snap/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:6767",
    cdpPort: 9222,
    once: false,
    paseoHome: process.env.PASEO_HOME || path.join(homedir(), ".paseo"),
    userDataDir: path.join(tmpdir(), "paseo-web-ui-harness"),
    screenshot: path.join(tmpdir(), "paseo-web-ui.png"),
    timeoutMs: 60_000,
    itsaplanOrigin: process.env.ITSAPLAN_ORIGIN || "https://localhost:8443",
    itsaplanCredentials: process.env.ITSAPLAN_CREDENTIALS || "/tmp/itsaplan-e2e/credentials.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--once") args.once = true;
    else if (flag === "--url") args.url = argv[++i];
    else if (flag === "--cdp-port") args.cdpPort = Number(argv[++i]);
    else if (flag === "--paseo-home") args.paseoHome = argv[++i];
    else if (flag === "--user-data-dir") args.userDataDir = argv[++i];
    else if (flag === "--screenshot") args.screenshot = argv[++i];
    else if (flag === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else if (flag === "--itsaplan-origin") args.itsaplanOrigin = argv[++i];
    else if (flag === "--itsaplan-credentials") args.itsaplanCredentials = argv[++i];
    else if (flag === "--help" || flag === "-h") {
      console.log(
        [
          "node scripts/web-ui-harness.mjs [--once] [--url http://127.0.0.1:6767]",
          "  [--cdp-port 9222] [--paseo-home ~/.paseo] [--screenshot /tmp/paseo-web-ui.png]",
          "  [--user-data-dir DIR] [--timeout SECONDS]",
          "  [--itsaplan-origin https://localhost:8443] [--itsaplan-credentials FILE]",
          "",
          "Env: PASEO_PASSWORD, PASEO_WEB_UI_CHROMIUM, ITSAPLAN_EMAIL, ITSAPLAN_PASSWORD",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  return args;
}

// The itsaplan pane is a cross-origin iframe, so better-auth's SameSite=Lax
// cookie is dropped and its sign-in form hangs on "Signing in…" forever. Mint a
// session over HTTP instead and re-issue it as SameSite=None so the embed can
// actually render a board. Returns null when no credentials are available.
async function mintItsaplanCookie(args) {
  let email = process.env.ITSAPLAN_EMAIL;
  let password = process.env.ITSAPLAN_PASSWORD;
  if (!email || !password) {
    try {
      const stored = JSON.parse(await readFile(args.itsaplanCredentials, "utf8"));
      email = stored.itsaplan_admin_user?.email;
      password = stored.itsaplan_admin_user?.password;
    } catch {
      return null;
    }
  }
  if (!email || !password) return null;

  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const response = await fetch(`${args.itsaplanOrigin}/__api/api/auth/sign-in/email`, {
      method: "POST",
      // better-auth answers an origin-less sign-in with 403, and node's fetch
      // sends no Origin of its own.
      headers: { "content-type": "application/json", Origin: args.itsaplanOrigin },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const raw = response.headers.getSetCookie?.() ?? [];
    const session = raw.find((entry) => entry.includes("session_token"));
    if (!session) return null;
    const [name, ...rest] = session.split(";")[0].split("=");
    return {
      name,
      value: rest.join("="),
      domain: new URL(args.itsaplanOrigin).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
      expires: Math.floor(Date.now() / 1000) + 604_800,
    };
  } catch {
    return null;
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

// The local daemon plus every configured peer, each with the password its
// registry entry needs. A peer url is "tcp://host:port".
async function discoverTargets(paseoHome) {
  const config = JSON.parse(await readFile(path.join(paseoHome, "config.json"), "utf8"));
  const localPassword = process.env.PASEO_PASSWORD ?? config.peers?.[0]?.password ?? "";
  const localListen = String(config.daemon?.listen ?? "0.0.0.0:6767");
  const localPort = Number(localListen.split(":").pop() || 6767);

  const targets = [{ endpoint: `127.0.0.1:${localPort}`, password: localPassword }];
  for (const peer of config.peers ?? []) {
    const raw = peer.url ?? peer.endpoint ?? peer.address;
    if (typeof raw !== "string") continue;
    const endpoint = raw.replace(/^\w+:\/\//, "");
    if (targets.some((target) => target.endpoint === endpoint)) continue;
    targets.push({ endpoint, password: peer.password ?? localPassword });
  }
  return targets;
}

// A registry entry is only usable with the serverId the daemon reports, so this
// is a hard requirement rather than a nicety: ask each endpoint who it is.
async function resolveHost(target) {
  const response = await fetch(`http://${target.endpoint}/api/status`, {
    headers: { Authorization: `Bearer ${target.password}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`${target.endpoint} answered /api/status with ${response.status}`);
  }
  const info = await response.json();
  if (typeof info.serverId !== "string") {
    throw new Error(`${target.endpoint} returned no serverId`);
  }
  return {
    serverId: info.serverId,
    label: info.missionControlHostAlias || info.hostname || target.endpoint,
    endpoint: target.endpoint,
    password: target.password,
  };
}

function buildRegistry(hosts, nowIso) {
  return hosts.map((host) => {
    const id = `direct:${host.endpoint}`;
    return {
      serverId: host.serverId,
      label: host.label,
      connections: [{ id, type: "directTcp", endpoint: host.endpoint, password: host.password }],
      preferredConnectionId: id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });
}

async function resolveChromium() {
  const fromEnv = process.env.PASEO_WEB_UI_CHROMIUM;
  const candidates = fromEnv ? [fromEnv, ...CHROMIUM_CANDIDATES] : CHROMIUM_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `No Chromium found. Set PASEO_WEB_UI_CHROMIUM, or install one of: ${CHROMIUM_CANDIDATES.join(", ")}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = await discoverTargets(args.paseoHome);

  const hosts = [];
  for (const target of targets) {
    try {
      hosts.push(await resolveHost(target));
    } catch (error) {
      console.warn(`skip ${target.endpoint}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (hosts.length === 0) throw new Error("No reachable daemon; nothing to seed.");

  const { chromium } = require("@playwright/test");
  const executablePath = await resolveChromium();
  const context = await chromium.launchPersistentContext(args.userDataDir, {
    executablePath,
    headless: true,
    // The itsaplan embed is served over a self-signed cert, so without this the
    // pane loads chrome-error:// instead of a board and every switch looks dead.
    ignoreHTTPSErrors: true,
    args: [
      `--remote-debugging-port=${args.cdpPort}`,
      "--remote-allow-origins=*",
      "--ignore-certificate-errors",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    viewport: { width: 1600, height: 1000 },
  });

  const itsaplanCookie = await mintItsaplanCookie(args);
  if (itsaplanCookie) await context.addCookies([itsaplanCookie]);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ key, registry }) => localStorage.setItem(key, JSON.stringify(registry)), {
    key: REGISTRY_KEY,
    registry: buildRegistry(hosts, new Date().toISOString()),
  });
  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  // A seeded host proves nothing; a host that answers shows up as rows. Each
  // sidebar row carries its serverId in the test id, so per-host counts are the
  // evidence — a page-wide "Connecting" text search also matches unrelated copy.
  const deadline = Date.now() + args.timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    report = await page.evaluate(
      (serverIds) => {
        const ids = (selector) =>
          [...document.querySelectorAll(selector)].map(
            (node) => node.getAttribute("data-testid") ?? "",
          );
        const projectIds = ids("[data-testid^='sidebar-project-row-']");
        const workspaceIds = ids("[data-testid^='sidebar-workspace-row-']");
        const perHost = {};
        for (const serverId of serverIds) {
          perHost[serverId] = {
            projects: projectIds.filter((id) => id.includes(serverId)).length,
            workspaces: workspaceIds.filter((id) => id.includes(serverId)).length,
          };
        }
        return {
          perHost,
          projects: projectIds.length,
          workspaces: workspaceIds.length,
          hostsWithRows: Object.values(perHost).filter(
            (counts) => counts.projects > 0 || counts.workspaces > 0,
          ).length,
        };
      },
      hosts.map((host) => host.serverId),
    );
    if (report.hostsWithRows >= hosts.length) break;
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: args.screenshot, fullPage: false });

  console.log(
    JSON.stringify(
      {
        url: args.url,
        cdp: `http://127.0.0.1:${args.cdpPort}`,
        chromium: executablePath,
        userDataDir: args.userDataDir,
        screenshot: args.screenshot,
        hosts: hosts.map(({ serverId, label, endpoint }) => ({
          serverId,
          label,
          endpoint,
          rows: report?.perHost?.[serverId] ?? { projects: 0, workspaces: 0 },
        })),
        projectRows: report?.projects ?? 0,
        workspaceRows: report?.workspaces ?? 0,
        allHostsServingRows: (report?.hostsWithRows ?? 0) >= hosts.length,
        itsaplanSession: itsaplanCookie ? "injected" : "none",
      },
      null,
      2,
    ),
  );

  if (args.once) {
    await context.close();
    return;
  }
  console.log("Harness is live. Attach over CDP; Ctrl-C to stop.");
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
