// Fork-only: backs the sidebar "Fleet stats" button with scripts/omp-stats-fleet.sh,
// which keeps an incrementally refreshed mirror of every host's omp stats DB in
// a throwaway omp profile and serves the stock `omp stats` dashboard on it. The
// button opens the dashboard on the last refresh at once and refreshes in the
// background; only the very first press waits for a refresh. The dashboard gets
// its own desktop window because the sidebar button is global, while every
// in-app browser pane is workspace-scoped. Design notes: scripts/omp-stats-fleet.ts.
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { spawnProcess } from "@getpaseo/server";
import { BrowserWindow } from "electron";
import log from "electron-log/main";

import { PASEO_BROWSER_PROFILE_PARTITION } from "./browser-profile.js";

const DEFAULT_PORT = 3848;
// The first refresh copies every host's whole stats DB (tens of MB compressed)
// over the VPN; later refreshes move only changed rows and take seconds.
const REFRESH_TIMEOUT_MS = 300_000;
// `omp stats -p` on an existing DB listens in well under a second.
const SERVE_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 750;
const STDERR_TAIL_LIMIT = 4_000;
const SIGKILL_GRACE_MS = 500;
const WINDOW_TITLE = "omp fleet stats";
// `--merge-only` exits 3 when some hosts failed and kept their previous data.
const REFRESH_PARTIAL_EXIT_CODE = 3;

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

/**
 * When the mirror was last refreshed, from the marker the script writes next to
 * the merged DB; null when there is no usable mirror yet.
 */
function readLastRefresh(): Date | null {
  const profile = process.env.OMP_FLEET_PROFILE || "fleet";
  const markerPath = path.join(homedir(), ".omp", "profiles", profile, "fleet-sync.json");
  try {
    const marker: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker &&
      typeof marker === "object" &&
      "asOf" in marker &&
      typeof marker.asOf === "string"
    ) {
      const asOf = new Date(marker.asOf);
      return Number.isNaN(asOf.getTime()) ? null : asOf;
    }
  } catch {
    // No marker yet, or a torn write: treat as no mirror.
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

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // The script fans out to ssh children and the omp server, so signalling the
  // group is what actually stops them.
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

function killChild(child: ChildProcess | null): void {
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

interface ScriptRun {
  child: ChildProcess;
  readStderrTail: () => string;
}

function runScript(scriptPath: string, args: string[], port: number): ScriptRun {
  log.info("[omp-fleet] running", { scriptPath, args, port });
  // `bash <script>` rather than executing it: extraResources does not
  // guarantee the exec bit survives packaging.
  const child = spawnProcess("bash", [scriptPath, ...args], {
    detached: true,
    envOverlay: { OMP_FLEET_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
  });
  return { child, readStderrTail: () => lastDiagnosticLine(stderrTail) };
}

/** Resolves when a `--merge-only` run updated the mirror (fully or partly). */
async function waitForRefresh(run: ScriptRun): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    killChild(run.child);
    reject(new Error("Timed out refreshing fleet stats"));
  }, REFRESH_TIMEOUT_MS);
  run.child.once("exit", (code) => {
    clearTimeout(timer);
    if (code === 0 || code === REFRESH_PARTIAL_EXIT_CODE) {
      resolve();
    } else {
      reject(new Error(run.readStderrTail() || "Fleet stats refresh failed"));
    }
  });
  return promise;
}

/**
 * `--serve` never exits and writes no ready file, so a TCP probe is the only
 * readiness signal. stderr is tailed so a failed start reaches the user as a
 * cause instead of a generic timeout.
 */
async function waitForDashboard(port: number, run: ScriptRun): Promise<void> {
  const deadline = Date.now() + SERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(run.readStderrTail() || "Fleet stats dashboard exited before serving");
    }
    if (await isPortListening(port)) {
      return;
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out starting the fleet stats dashboard");
}

function formatAsOf(asOf: Date | null): string {
  return asOf
    ? `as of ${asOf.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    : "never refreshed";
}

class OmpStatsFleetManager {
  private server: ChildProcess | null = null;
  private refresh: ChildProcess | null = null;
  private refreshing: Promise<void> | null = null;
  private window: BrowserWindow | null = null;
  private pending: Promise<OpenOmpStatsFleetResult> | null = null;

  /**
   * Shows the dashboard. A repeat press focuses the live window; closing the
   * window stops the server. A refresh in flight keeps going (it is one SQLite
   * transaction per host), so the next press opens on fresher data.
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
    killChild(this.refresh);
    this.refresh = null;
    killChild(this.server);
    this.server = null;
  }

  private async start(): Promise<OpenOmpStatsFleetResult> {
    const port = resolvePort();
    const url = `http://127.0.0.1:${port}`;
    const scriptPath = resolveScriptPath();
    if (!scriptPath) {
      throw new Error("omp-stats-fleet.sh is missing from this Paseo install");
    }

    let refreshedNow = false;
    if (readLastRefresh() === null) {
      // Nothing to show yet: the first refresh has to finish before serving.
      await this.runRefresh(scriptPath, port);
      refreshedNow = true;
    }
    if (this.server === null) {
      if (await isPortListening(port)) {
        // A dashboard is already up (a terminal run, or an earlier window we
        // closed mid-shutdown). Binding again would fail, so show that one.
        log.info("[omp-fleet] reusing dashboard already listening", { port });
      } else {
        await this.serve(scriptPath, port);
      }
    }

    this.showWindow(url, refreshedNow ? formatAsOf(readLastRefresh()) : "refreshing…");
    if (!refreshedNow) {
      void this.refreshInBackground(scriptPath, port);
    }
    return { url };
  }

  /** One refresh at a time: a press during a refresh waits on the same run. */
  private runRefresh(scriptPath: string, port: number): Promise<void> {
    this.refreshing ??= (async () => {
      const run = runScript(scriptPath, ["--merge-only"], port);
      this.refresh = run.child;
      try {
        await waitForRefresh(run);
      } finally {
        this.refresh = null;
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** The dashboard reads SQLite per request, so a reload shows the new rows. */
  private async refreshInBackground(scriptPath: string, port: number): Promise<void> {
    try {
      await this.runRefresh(scriptPath, port);
      const window = this.window;
      if (window && !window.isDestroyed()) {
        this.setStatus(formatAsOf(readLastRefresh()));
        window.webContents.reload();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("[omp-fleet] background refresh failed", reason);
      this.setStatus(`${formatAsOf(readLastRefresh())} · refresh failed: ${reason}`);
    }
  }

  private async serve(scriptPath: string, port: number): Promise<void> {
    const run = runScript(scriptPath, ["--serve"], port);
    this.server = run.child;
    run.child.once("exit", (code, signal) => {
      log.info("[omp-fleet] dashboard exited", { code, signal });
      if (this.server === run.child) {
        this.server = null;
        this.closeWindow();
      }
    });
    try {
      await waitForDashboard(port, run);
    } catch (error) {
      killChild(run.child);
      this.server = null;
      throw error;
    }
  }

  private setStatus(status: string): void {
    const window = this.window;
    if (window && !window.isDestroyed()) {
      window.setTitle(`${WINDOW_TITLE} · ${status}`);
    }
  }

  private showWindow(url: string, status: string): void {
    const window = new BrowserWindow({
      title: `${WINDOW_TITLE} · ${status}`,
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
    // The dashboard's own <title> would replace the "as of" status.
    window.on("page-title-updated", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        killChild(this.server);
        this.server = null;
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
}

let manager: OmpStatsFleetManager | null = null;

/** Shows the fleet stats dashboard window, refreshing the data behind it. */
export function openOmpStatsFleet(): Promise<OpenOmpStatsFleetResult> {
  manager ??= new OmpStatsFleetManager();
  return manager.open();
}

export function stopOmpStatsFleet(): void {
  manager?.stop();
}
