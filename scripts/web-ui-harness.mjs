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
const APP_SETTINGS_KEY = "@paseo:app-settings";
// itsaplan keeps its own next-themes preference, so the pane stays light while
// the shell around it is dark unless both are set.
const ITSAPLAN_THEME_KEY = "itsaplan-theme";
/** Plain-HTTP port of the itsaplan web app; the TLS proxy in front of it is 8443. */
const ITSAPLAN_WEB_PORT = 3001;
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
    theme: process.env.PASEO_WEB_UI_THEME || "dark",
    itsaplanOrigin: process.env.ITSAPLAN_ORIGIN || "https://localhost:8443",
    itsaplanCredentials: process.env.ITSAPLAN_CREDENTIALS || "/tmp/itsaplan-e2e/credentials.json",
    bootstrap: false,
    vantage: "auto",
    browserHost: process.env.PASEO_BROWSER_HOST || "macbook",
    itsaplanEmbedOrigin: process.env.ITSAPLAN_EMBED_ORIGIN || "",
    addresses: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--once") args.once = true;
    else if (flag === "--bootstrap") args.bootstrap = true;
    else if (flag === "--url") args.url = argv[++i];
    else if (flag === "--cdp-port") args.cdpPort = Number(argv[++i]);
    else if (flag === "--paseo-home") args.paseoHome = argv[++i];
    else if (flag === "--user-data-dir") args.userDataDir = argv[++i];
    else if (flag === "--screenshot") args.screenshot = argv[++i];
    else if (flag === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else if (flag === "--theme") args.theme = argv[++i];
    else if (flag === "--vantage") args.vantage = argv[++i];
    else if (flag === "--browser-host") args.browserHost = argv[++i];
    else if (flag === "--address") args.addresses.push(argv[++i]);
    else if (flag === "--itsaplan-origin") args.itsaplanOrigin = argv[++i];
    else if (flag === "--itsaplan-embed-origin") args.itsaplanEmbedOrigin = argv[++i];
    else if (flag === "--itsaplan-credentials") args.itsaplanCredentials = argv[++i];
    else if (flag === "--help" || flag === "-h") {
      console.log(
        [
          "Browser-tool path (preferred; the user can watch it):",
          "  node scripts/web-ui-harness.mjs --bootstrap --url http://iammvaibhav:6767",
          "    [--vantage auto|local|<ssh-host>] [--browser-host macbook]",
          "    [--address srv_x=host:port] [--itsaplan-embed-origin http://host:3001]",
          "",
          "Playwright fallback (headless Chromium here, when that machine is down):",
          "  node scripts/web-ui-harness.mjs [--once] [--url http://127.0.0.1:6767]",
          "    [--cdp-port 9222] [--user-data-dir DIR] [--screenshot FILE]",
          "    [--timeout SECONDS] [--theme dark|light|auto|zinc|...]",
          "    [--itsaplan-origin https://localhost:8443] [--itsaplan-credentials FILE]",
          "",
          "Env: PASEO_PASSWORD, PASEO_WEB_UI_CHROMIUM, PASEO_WEB_UI_THEME,",
          "     PASEO_BROWSER_HOST, ITSAPLAN_EMAIL, ITSAPLAN_PASSWORD",
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

// next-themes stores the preference on itsaplan's OWN origin, so writing it
// next to the Paseo settings would leave the embedded board light inside a dark
// shell. Visit that origin once and set it there.
async function seedItsaplanTheme(context, args) {
  const page = await context.newPage();
  try {
    await page.goto(args.itsaplanOrigin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: ITSAPLAN_THEME_KEY,
      value: args.theme === "light" ? "light" : "dark",
    });
    return true;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

// The local daemon plus every configured peer, each with the password its
// registry entry needs. A peer url is "tcp://host:port".
async function discoverTargets(paseoHome) {
  const config = JSON.parse(await readFile(path.join(paseoHome, "config.json"), "utf8"));
  const localPassword = process.env.PASEO_PASSWORD ?? config.peers?.[0]?.password ?? "";
  const localListen = String(config.daemon?.listen ?? "0.0.0.0:6767");
  const localPort = Number(localListen.split(":").pop() || 6767);

  const targets = [{ endpoint: `127.0.0.1:${localPort}`, password: localPassword, local: true }];
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
    hostname: info.hostname ?? target.endpoint.split(":")[0],
    endpoint: target.endpoint,
    password: target.password,
    local: target.local === true,
  };
}

// Which addresses to try for a host, best first. A peer's address is not the
// same from every machine — blrofc3 is 10.7.0.4 over WireGuard from this host
// and 100.105.100.71 over Tailscale from the MacBook — so candidates are
// probed rather than assumed, and only an answer whose serverId MATCHES is
// accepted. Without that check `127.0.0.1:6767` "works" everywhere and
// silently points a peer's registry entry at the local daemon.
function addressCandidates(host, overrides) {
  const port = host.endpoint.split(":").pop() ?? "6767";
  const override = overrides[host.serverId];
  return [
    ...(override ? [override] : []),
    host.endpoint,
    `${host.hostname}:${port}`,
    `127.0.0.1:${port}`,
  ].filter((value, index, all) => value && all.indexOf(value) === index);
}

function parseAddressOverrides(raw) {
  const overrides = {};
  for (const entry of raw) {
    const [serverId, address] = entry.split("=");
    if (serverId && address) overrides[serverId.trim()] = address.trim();
  }
  return overrides;
}

// Runs the identity probe from the machine that will hold the browser. For the
// browser tool that machine is the user's Mac, so the probe goes over ssh.
async function probeFrom(vantage, address, password) {
  const url = `http://${address}/api/status`;
  if (vantage === "local") {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${password}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return null;
      return (await response.json()).serverId ?? null;
    } catch {
      return null;
    }
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)(
      "ssh",
      [
        "-o",
        "ConnectTimeout=6",
        "-o",
        "BatchMode=yes",
        vantage,
        `curl -s -m 6 -H 'Authorization: Bearer ${password}' ${url}`,
      ],
      { timeout: 20_000 },
    );
    return JSON.parse(stdout).serverId ?? null;
  } catch {
    return null;
  }
}

// How the vantage machine itself reaches these daemons. Its own peers config is
// the authority for that: the MacBook lists iammvaibhav as 10.7.0.1 and blrofc3
// as its Tailscale address, neither of which this host would guess.
async function vantagePeerCandidates(vantage) {
  if (vantage === "local") return [];
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)(
      "ssh",
      ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes", vantage, "cat ~/.paseo/config.json"],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const config = JSON.parse(stdout);
    const listenPort = String(config.daemon?.listen ?? "0.0.0.0:6767")
      .split(":")
      .pop();
    const peers = (config.peers ?? [])
      .map((peer) => peer.url ?? peer.endpoint ?? peer.address)
      .filter((value) => typeof value === "string")
      .map((value) => value.replace(/^\w+:\/\//, ""));
    return [...peers, `127.0.0.1:${listenPort}`];
  } catch {
    return [];
  }
}

async function resolveAddressesForVantage(hosts, vantage, overrides) {
  const extras = await vantagePeerCandidates(vantage);
  const resolved = [];
  for (const host of hosts) {
    let reachable = null;
    for (const candidate of [...addressCandidates(host, overrides), ...extras]) {
      const serverId = await probeFrom(vantage, candidate, host.password);
      if (serverId === host.serverId) {
        reachable = candidate;
        break;
      }
    }
    resolved.push({ ...host, address: reachable });
  }
  return resolved;
}

function buildRegistry(hosts, nowIso) {
  return hosts.map((host) => {
    const endpoint = host.address ?? host.endpoint;
    const id = `direct:${endpoint}`;
    return {
      serverId: host.serverId,
      label: host.label,
      connections: [{ id, type: "directTcp", endpoint, password: host.password }],
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

// The browser tool is the better surface when it is available: it is the user's
// own desktop app, so they watch the same session the agent drives. It only
// exists while that machine is up, hence the vantage probe and the Chromium
// fallback below.
async function emitBootstrap(args, hosts) {
  const vantage = args.vantage === "auto" ? await pickVantage(args) : args.vantage;
  const resolved = await resolveAddressesForVantage(
    hosts,
    vantage,
    parseAddressOverrides(args.addresses),
  );
  const reachable = resolved.filter((host) => host.address);
  // Every daemon's fixed CORS allowlist contains only loopback origins plus
  // https://app.paseo.sh, so a named origin such as http://iammvaibhav:6767 is
  // rejected with 403 by the OTHER hosts: their rows sit on "Connecting"
  // forever. Serving the bundle from the vantage's own 127.0.0.1 keeps the
  // origin loopback, which all three hosts accept.
  const uiPort = new URL(args.url).port || "6767";
  const uiUrl = `http://127.0.0.1:${uiPort}`;

  // itsaplan runs beside the daemon this harness was launched from, and its
  // session cookie is SameSite=Lax, so the pane needs the address the VANTAGE
  // uses for that host - not the one this machine would use.
  const itsaplanHost = resolved.find((host) => host.local)?.address ?? `127.0.0.1:${uiPort}`;
  const itsaplanOrigin =
    args.itsaplanEmbedOrigin || `http://${itsaplanHost.split(":")[0]}:${ITSAPLAN_WEB_PORT}`;

  const bootstrap = `(() => {
  const now = new Date().toISOString();
  localStorage.setItem(${JSON.stringify(REGISTRY_KEY)}, ${JSON.stringify(
    JSON.stringify(buildRegistry(reachable, "__NOW__")),
  )}.replaceAll("__NOW__", now));
  const settings = JSON.parse(localStorage.getItem(${JSON.stringify(APP_SETTINGS_KEY)}) ?? "{}");
  settings.theme = ${JSON.stringify(args.theme)};
  settings.itsaplanOrigin = ${JSON.stringify(itsaplanOrigin)};
  localStorage.setItem(${JSON.stringify(APP_SETTINGS_KEY)}, JSON.stringify(settings));
  return { hosts: ${reachable.length}, itsaplanOrigin: settings.itsaplanOrigin };
})()`;

  console.log(
    JSON.stringify(
      {
        mode: "browser-tool",
        vantage,
        uiUrl,
        itsaplanOrigin,
        // Two origins, one tradeoff. Loopback connects every host but the pane's
        // SameSite=Lax cookie is dropped, so its sign-in hangs. The named origin
        // shares a site with itsaplan and keeps the pane working, but the other
        // daemons answer 403 for it. The desktop app has neither problem.
        paneUrl: `http://${itsaplanHost.split(":")[0]}:${uiPort}`,
        hosts: resolved.map(({ serverId, label, address }) => ({
          serverId,
          label,
          address: address ?? null,
        })),
        unreachable: resolved.filter((host) => !host.address).map((host) => host.label),
        signIn: {
          url: `${itsaplanOrigin}/login`,
          email: process.env.ITSAPLAN_EMAIL ?? "(from --itsaplan-credentials)",
          note: "Sign in in a TOP-LEVEL tab first; the pane cannot complete sign-in itself. Use browser_type, not browser_fill: the inputs are controlled.",
        },
        steps: [
          `browser_new_tab ${uiUrl}`,
          "browser_evaluate <bootstrap below>",
          `browser_navigate ${uiUrl}`,
        ],
      },
      null,
      2,
    ),
  );
  console.log("\n--- bootstrap (paste into browser_evaluate) ---");
  console.log(bootstrap);
}

// "Is the machine that hosts the browser tool actually up?" A reachable ssh is
// the same condition the browser tool needs, so it is the cheapest proxy.
async function pickVantage(args) {
  if (!args.browserHost) return "local";
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    await promisify(execFile)(
      "ssh",
      ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", args.browserHost, "true"],
      { timeout: 15_000 },
    );
    return args.browserHost;
  } catch {
    return "local";
  }
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

  if (args.bootstrap) {
    await emitBootstrap(args, hosts);
    return;
  }

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
  await page.evaluate(
    ({ registryKey, registry, settingsKey, theme }) => {
      localStorage.setItem(registryKey, JSON.stringify(registry));
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
      settings.theme = theme;
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    {
      registryKey: REGISTRY_KEY,
      registry: buildRegistry(hosts, new Date().toISOString()),
      settingsKey: APP_SETTINGS_KEY,
      theme: args.theme,
    },
  );
  await seedItsaplanTheme(context, args);
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
        theme: args.theme,
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
