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
    else if (flag === "--help" || flag === "-h") {
      console.log(
        [
          "node scripts/web-ui-harness.mjs [--once] [--url http://127.0.0.1:6767]",
          "  [--cdp-port 9222] [--paseo-home ~/.paseo] [--screenshot /tmp/paseo-web-ui.png]",
          "  [--user-data-dir DIR] [--timeout SECONDS]",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  return args;
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
    args: [
      `--remote-debugging-port=${args.cdpPort}`,
      "--remote-allow-origins=*",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    viewport: { width: 1600, height: 1000 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ key, registry }) => localStorage.setItem(key, JSON.stringify(registry)), {
    key: REGISTRY_KEY,
    registry: buildRegistry(hosts, new Date().toISOString()),
  });
  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  // "Connected" is the app's own word for a live host, and the sidebar only
  // lists projects once a host reaches it, so both are read from the UI rather
  // than inferred from the seed succeeding.
  const deadline = Date.now() + args.timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    report = await page.evaluate(
      (serverIds) => {
        const text = document.body.innerText;
        const rows = [...document.querySelectorAll("[data-testid^='sidebar-project-row-']")].map(
          (node) => node.textContent?.trim() ?? "",
        );
        const workspaces = document.querySelectorAll(
          "[data-testid^='sidebar-workspace-row-']",
        ).length;
        return {
          offline: /Disconnected|Unreachable|Connecting/.test(text),
          hostCount: serverIds.length,
          projects: rows,
          workspaces,
        };
      },
      hosts.map((host) => host.serverId),
    );
    if (report.projects.length > 0 && !report.offline) break;
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
        hosts: hosts.map(({ serverId, label, endpoint }) => ({ serverId, label, endpoint })),
        projects: report?.projects ?? [],
        workspaceRows: report?.workspaces ?? 0,
        anyHostNotConnected: report?.offline ?? true,
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
