// Fork-only: runs scripts/omp-stats-fleet.sh, which snapshots every host's omp
// stats DB over ssh, merges them into a throwaway omp profile, and serves the
// stock `omp stats` dashboard on loopback. The dashboard gets its own desktop
// window because the sidebar button that opens it is global, while every in-app
// browser pane is workspace-scoped. See docs/omp-fleet-stats.md.
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

import { spawnProcess } from "@getpaseo/server";
import { BrowserWindow } from "electron";
import log from "electron-log/main";

import { PASEO_BROWSER_PROFILE_PARTITION } from "./browser-profile.js";

const DEFAULT_PORT = 3848;
// Three hosts are snapshotted in parallel over ssh, then merged with sqlite.
// A cold VPN link plus a large stats DB pushes this past any 30s budget.
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_INTERVAL_MS = 400;
const PROBE_TIMEOUT_MS = 750;
const STDERR_TAIL_LIMIT = 4_000;
const SIGKILL_GRACE_MS = 500;

export interface OpenOmpStatsFleetResult {
  url: string;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** `OMP_FLEET_PORT` is the script's own knob; honour it so both agree on a port. */
function resolvePort(): number {
  const raw = Number.parseInt(process.env.OMP_FLEET_PORT ?? "", 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_PORT;
}

/**
 * The script ships as an extraResource so a packaged app can run it. In a dev
 * checkout `__dirname` is `<repo>/packages/desktop/dist/features` — the same
 * `__dirname` anchor `getAppDistDir()` uses in main.ts.
 */
function resolveScriptPath(): string | null {
  const candidates = [
    process.env.PASEO_OMP_FLEET_SCRIPT,
    path.join(process.resourcesPath, "scripts", "omp-stats-fleet.sh"),
    path.resolve(__dirname, "../../../..", "scripts", "omp-stats-fleet.sh"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isPortListening(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: "127.0.0.1", port });
  const settle = (listening: boolean): void => {
    socket.destroy();
    resolve(listening);
  };
  socket.setTimeout(PROBE_TIMEOUT_MS);
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
  return promise;
}

// The script wraps its diagnostics in SGR colour codes (`log()` dims, `die()` reds).
// oxlint-disable-next-line no-control-regex
const ANSI_SGR_PATTERN = /\u001B\[[0-9;]*m/g;

/** The script's own diagnostics are `[fleet] …` lines; the last one is the cause. */
function lastDiagnosticLine(stderr: string): string {
  const lines = stderr
    .replace(ANSI_SGR_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * The script never exits in dashboard mode and writes no ready file, so a TCP
 * probe is the only readiness signal. stderr is tailed purely so a failed run
 * (`omp not on PATH`, an unreachable host) reaches the user as a cause instead
 * of a generic timeout.
 */
async function waitForDashboard(input: {
  port: number;
  child: ChildProcess;
  readStderrTail: () => string;
}): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(input.readStderrTail() || "Fleet stats collection exited before serving");
    }
    if (await isPortListening(input.port)) {
      return;
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out collecting fleet stats");
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // The script fans out to ssh/scp children and then `exec`s the omp server, so
  // signalling the group is what actually stops an in-flight snapshot.
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone, or we never became its leader.
    }
  }
  child.kill(signal);
}

class OmpStatsFleetManager {
  private child: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private pending: Promise<OpenOmpStatsFleetResult> | null = null;

  /**
   * Collects fleet stats and shows the dashboard. A repeat press focuses the
   * live window; closing the window stops the server, so the next press
   * re-collects rather than showing a stale merge.
   */
  open(): Promise<OpenOmpStatsFleetResult> {
    const window = this.window;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return Promise.resolve({ url: `http://127.0.0.1:${resolvePort()}` });
    }
    this.pending ??= this.start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  stop(): void {
    this.closeWindow();
    this.killChild();
  }

  private async start(): Promise<OpenOmpStatsFleetResult> {
    const port = resolvePort();
    const url = `http://127.0.0.1:${port}`;

    if (this.child === null) {
      if (await isPortListening(port)) {
        // A dashboard is already up (a terminal run, or an earlier window we
        // closed mid-shutdown). Binding again would fail, so show that one.
        log.info("[omp-fleet] reusing dashboard already listening", { port });
      } else {
        await this.collect(port);
      }
    }

    this.showWindow(url);
    return { url };
  }

  private async collect(port: number): Promise<void> {
    const scriptPath = resolveScriptPath();
    if (!scriptPath) {
      throw new Error("omp-stats-fleet.sh is missing from this Paseo install");
    }

    log.info("[omp-fleet] collecting", { scriptPath, port });
    // `bash <script>` rather than executing it: extraResources does not
    // guarantee the exec bit survives packaging.
    const child = spawnProcess("bash", [scriptPath], {
      detached: true,
      envOverlay: { OMP_FLEET_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.once("exit", (code, signal) => {
      log.info("[omp-fleet] dashboard exited", { code, signal });
      if (this.child === child) {
        this.child = null;
        this.closeWindow();
      }
    });

    try {
      await waitForDashboard({ port, child, readStderrTail: () => lastDiagnosticLine(stderrTail) });
    } catch (error) {
      this.killChild();
      throw error;
    }
  }

  private showWindow(url: string): void {
    const window = new BrowserWindow({
      title: "omp fleet stats",
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PASEO_BROWSER_PROFILE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.killChild();
      }
    });
    void window.loadURL(url).catch((error: unknown) => {
      log.warn("[omp-fleet] failed to load dashboard", error);
    });
  }

  private closeWindow(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killProcessGroup(child, "SIGKILL");
      }
    }, SIGKILL_GRACE_MS).unref();
  }
}

let manager: OmpStatsFleetManager | null = null;

/** Collects fleet stats and shows the dashboard window. */
export function openOmpStatsFleet(): Promise<OpenOmpStatsFleetResult> {
  manager ??= new OmpStatsFleetManager();
  return manager.open();
}

export function stopOmpStatsFleet(): void {
  manager?.stop();
}
