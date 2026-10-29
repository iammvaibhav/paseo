import { execFile, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";

export type KeepAwakeLevel = "off" | "idle" | "lid-closed";

const CAFFEINATE = "/usr/bin/caffeinate";
const PMSET = "/usr/bin/pmset";
const NOTIFYUTIL = "/usr/bin/notifyutil";
const IOREG = "/usr/sbin/ioreg";
const SUDO = "/usr/bin/sudo";
// Must match the installed sudoers rule (`/usr/bin/pmset -a disablesleep 1` / `... 0`)
// argument for argument; `-n` makes sudo fail instead of prompting.
const DISABLESLEEP_ON = ["-n", PMSET, "-a", "disablesleep", "1"];
const DISABLESLEEP_OFF = ["-n", PMSET, "-a", "disablesleep", "0"];
const MARKER_FILE = "keep-awake-disablesleep.json";

const DEFAULT_LEVEL: KeepAwakeLevel = "idle";
// Agents go idle between turns; holding on this long keeps the assertion from flapping and
// lets the next turn start without the Mac having slept.
const DEFAULT_RELEASE_GRACE_MINUTES = 5;
const DEFAULT_BATTERY_FLOOR_PERCENT = 10;
const GUARD_POLL_MS = 30_000;
const CAFFEINATE_RESPAWN_DELAY_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
// notify(3) thermal pressure levels: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping.
const THERMAL_PRESSURE_HEAVY = 2;

export interface KeepAwakeChild {
  kill(): void;
}

/** Starts a long-lived process; `onExit` fires once when it exits or fails to start. */
export type KeepAwakeSpawner = (
  command: string,
  args: string[],
  onExit: () => void,
) => KeepAwakeChild;

/** Runs a command to completion; resolves stdout and rejects on a non-zero exit. */
export type KeepAwakeCommandRunner = (command: string, args: string[]) => Promise<string>;

export interface KeepAwakeServiceOptions {
  agentManager: Pick<AgentManager, "subscribe" | "listAgents" | "listProviderSubagentActivity">;
  daemonConfigStore: Pick<DaemonConfigStore, "get" | "onChange">;
  logger: Logger;
  paseoHome: string;
  /** Overridable for tests; the service only acts on darwin. */
  platform?: NodeJS.Platform;
  /** The process caffeinate waits on (`-w`); defaults to this daemon. */
  pid?: number;
  runCommand?: KeepAwakeCommandRunner;
  spawnProcess?: KeepAwakeSpawner;
}

interface KeepAwakeSettings {
  level: KeepAwakeLevel;
  releaseGraceMs: number;
  batteryFloorPercent: number;
}

const defaultRunCommand: KeepAwakeCommandRunner = (command, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
  return promise;
};

const defaultSpawnProcess: KeepAwakeSpawner = (command, args, onExit) => {
  const child = spawn(command, args, { stdio: "ignore" });
  let exited = false;
  const handleExit = () => {
    if (!exited) {
      exited = true;
      onExit();
    }
  };
  child.once("exit", handleExit);
  child.once("error", handleExit);
  return {
    kill: () => {
      child.kill();
    },
  };
};

function parseSleepDisabled(pmsetOutput: string): boolean {
  const match = /^\s*SleepDisabled\s+(\d+)/m.exec(pmsetOutput);
  return match !== null && match[1] !== "0";
}

function parseBattery(pmsetBattOutput: string): { onBattery: boolean; percent: number | null } {
  const percent = /(\d+)%/.exec(pmsetBattOutput);
  return {
    onBattery: pmsetBattOutput.includes("'Battery Power'"),
    percent: percent ? Number(percent[1]) : null,
  };
}

function parseThermalPressure(notifyutilOutput: string): number | null {
  const match = /(\d+)\s*$/.exec(notifyutilOutput.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Keeps a macOS host awake while any agent of any provider is running.
 *
 * - `idle`: one `caffeinate -i -s -w <daemon pid>` child while busy. `-w` ties
 *   the assertion to the daemon, so it cannot outlive a crash. On AC power the
 *   `-s` assertion also keeps a closed Mac running (display off, DarkWake).
 * - `lid-closed`: additionally sets `SleepDisabled` through `sudo -n pmset`,
 *   the only setting that keeps a closed Mac running on battery. It also stops
 *   macOS from sleeping for heat or an empty battery, so the flag is released
 *   on battery at the configured floor and under heavy thermal pressure, never
 *   cleared when someone else set it, and tracked by a marker file so the next
 *   start can undo a crash. There is no time limit while agents run.
 *
 * Clearing `SleepDisabled` does not make macOS re-check a lid that was closed
 * while it was set, so the service puts a closed Mac to sleep itself
 * (`pmset sleepnow`) right after clearing the flag. A `caffeinate -s` still held
 * on AC turns that into a DarkWake that keeps agents running.
 *
 * The settings are read from the daemon config on every evaluation. Busy→idle
 * waits for a grace period so the assertion does not flap between turns.
 */
export class KeepAwakeService {
  private readonly agentManager: KeepAwakeServiceOptions["agentManager"];
  private readonly daemonConfigStore: KeepAwakeServiceOptions["daemonConfigStore"];
  private readonly logger: Logger;
  private readonly markerPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly runCommand: KeepAwakeCommandRunner;
  private readonly spawnProcess: KeepAwakeSpawner;

  private unsubscribers: Array<() => void> = [];
  private started = false;
  private stopped = false;
  // Every state change runs through this chain so pmset/sudo calls never interleave.
  private chain: Promise<void> = Promise.resolve();
  private queuedEvaluation: Promise<void> | null = null;

  // Effective busy state: true from the first running agent until the debounce elapses.
  private held = false;
  private idleSince: number | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;

  private caffeinate: KeepAwakeChild | null = null;
  private caffeinateGeneration = 0;
  private respawnTimer: NodeJS.Timeout | null = null;

  // Non-null while this daemon owns SleepDisabled.
  private disableSleepTakenAt: number | null = null;
  // Set when a guard trips, sudo fails, or someone else holds the flag; cleared on idle→busy.
  private disableSleepLatched = false;
  private guardTimer: NodeJS.Timeout | null = null;

  constructor(options: KeepAwakeServiceOptions) {
    this.agentManager = options.agentManager;
    this.daemonConfigStore = options.daemonConfigStore;
    this.logger = options.logger.child({ module: "keep-awake" });
    this.markerPath = path.join(options.paseoHome, MARKER_FILE);
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  start(): void {
    if (this.started || this.platform !== "darwin") {
      return;
    }
    this.started = true;
    this.unsubscribers.push(
      this.agentManager.subscribe(
        (event) => {
          if (event.type === "agent_state" || event.type === "provider_subagent") {
            void this.evaluate();
          }
        },
        { replayState: false },
      ),
      this.daemonConfigStore.onChange(() => {
        void this.evaluate();
      }),
    );
    void this.enqueue(() => this.recoverAbandonedDisableSleep());
    void this.evaluate();
  }

  /**
   * Releases caffeinate and any SleepDisabled this daemon owns. It never sleeps the Mac: a
   * shutdown is usually a restart, and the next daemon takes the flag again for running agents.
   */
  async stop(): Promise<void> {
    if (!this.started || this.stopped) {
      return;
    }
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    await this.enqueue(() => this.releaseAll({ sleepIfLidClosed: false }));
    // A failed release keeps its marker for the next start; nothing retries after stop.
    this.stopGuardTimer();
  }

  /** Recomputes the busy state and applies it; coalesces with a pending evaluation. */
  evaluate(): Promise<void> {
    if (this.queuedEvaluation) {
      return this.queuedEvaluation;
    }
    const evaluation = this.enqueue(async () => {
      this.queuedEvaluation = null;
      await this.reconcile();
    });
    this.queuedEvaluation = evaluation;
    return evaluation;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task).catch((error) => {
      this.logger.error({ err: error }, "Keep-awake evaluation failed");
    });
    this.chain = run;
    return run;
  }

  private readSettings(): KeepAwakeSettings {
    const config = this.daemonConfigStore.get();
    const graceMinutes = config.keepAwakeReleaseGraceMinutes ?? DEFAULT_RELEASE_GRACE_MINUTES;
    return {
      level: config.keepAwakeWhileAgentsRun ?? DEFAULT_LEVEL,
      releaseGraceMs: graceMinutes * 60_000,
      batteryFloorPercent: config.keepAwakeBatteryFloorPercent ?? DEFAULT_BATTERY_FLOOR_PERCENT,
    };
  }

  private isBusy(): boolean {
    return (
      this.agentManager.listAgents().some((agent) => agent.lifecycle === "running") ||
      this.agentManager
        .listProviderSubagentActivity()
        .some((subagent) => subagent.status === "running")
    );
  }

  private async reconcile(): Promise<void> {
    // Never started (non-darwin) or already stopped.
    if (!this.started || this.stopped) {
      return;
    }
    const settings = this.readSettings();
    if (settings.level === "off") {
      await this.releaseAll();
      return;
    }
    this.updateHeld(this.isBusy(), settings.releaseGraceMs);
    if (!this.held) {
      await this.releaseAll();
      return;
    }

    this.ensureCaffeinate();
    if (settings.level === "lid-closed" && !this.disableSleepLatched) {
      if (this.disableSleepTakenAt === null) {
        await this.takeDisableSleep();
      }
    } else if (this.disableSleepTakenAt !== null) {
      await this.releaseDisableSleep();
    }
  }

  private updateHeld(busy: boolean, releaseGraceMs: number): void {
    if (busy) {
      this.idleSince = null;
      this.clearReleaseTimer();
      if (!this.held) {
        this.held = true;
        this.disableSleepLatched = false;
        this.logger.info("Agents running; keeping the host awake");
      }
      return;
    }
    if (!this.held) {
      return;
    }
    const now = Date.now();
    this.idleSince ??= now;
    const remainingMs = this.idleSince + releaseGraceMs - now;
    if (remainingMs <= 0) {
      this.held = false;
      this.idleSince = null;
      this.logger.info("No agents running; letting the host sleep");
      return;
    }
    if (!this.releaseTimer) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        void this.evaluate();
      }, remainingMs);
      this.releaseTimer.unref?.();
    }
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  private async releaseAll(options: { sleepIfLidClosed: boolean } = { sleepIfLidClosed: true }) {
    this.held = false;
    this.idleSince = null;
    this.clearReleaseTimer();
    this.killCaffeinate();
    if (this.disableSleepTakenAt !== null) {
      await this.releaseDisableSleep(options);
    }
  }

  private ensureCaffeinate(): void {
    if (this.caffeinate || this.respawnTimer) {
      return;
    }
    const generation = ++this.caffeinateGeneration;
    try {
      this.caffeinate = this.spawnProcess(CAFFEINATE, ["-i", "-s", "-w", String(this.pid)], () =>
        this.handleCaffeinateExit(generation),
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to start caffeinate");
      this.scheduleCaffeinateRespawn();
    }
  }

  private handleCaffeinateExit(generation: number): void {
    // A child we killed on purpose, or one already replaced.
    if (generation !== this.caffeinateGeneration || this.caffeinate === null) {
      return;
    }
    this.caffeinate = null;
    this.logger.warn("caffeinate exited unexpectedly");
    this.scheduleCaffeinateRespawn();
  }

  private scheduleCaffeinateRespawn(): void {
    if (this.stopped || this.respawnTimer) {
      return;
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      void this.evaluate();
    }, CAFFEINATE_RESPAWN_DELAY_MS);
    this.respawnTimer.unref?.();
  }

  private killCaffeinate(): void {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.caffeinate;
    if (!child) {
      return;
    }
    this.caffeinate = null;
    child.kill();
  }

  private async takeDisableSleep(): Promise<void> {
    let alreadyDisabled: boolean;
    try {
      alreadyDisabled = parseSleepDisabled(await this.runCommand(PMSET, ["-g"]));
    } catch (error) {
      this.logger.warn({ err: error }, "Could not read SleepDisabled; keeping idle-only");
      this.disableSleepLatched = true;
      return;
    }
    if (alreadyDisabled) {
      // Amphetamine or the user set it: theirs to clear, not ours.
      this.logger.info("SleepDisabled is already set elsewhere; leaving it alone");
      this.disableSleepLatched = true;
      return;
    }

    const takenAt = Date.now();
    // The marker goes down before the flag so a crash in between never leaves an untracked flag.
    await writeJsonFileAtomic(this.markerPath, {
      pid: this.pid,
      takenAt: new Date(takenAt).toISOString(),
    });
    try {
      await this.runCommand(SUDO, DISABLESLEEP_ON);
    } catch (error) {
      await rm(this.markerPath, { force: true });
      this.logger.warn(
        { err: error },
        "sudo -n pmset -a disablesleep 1 failed; keeping the host awake for idle sleep only",
      );
      this.disableSleepLatched = true;
      return;
    }
    this.disableSleepTakenAt = takenAt;
    this.startGuardTimer();
    this.logger.info("Set SleepDisabled so the host stays awake with the lid closed");
  }

  private async releaseDisableSleep(
    options: { sleepIfLidClosed: boolean } = { sleepIfLidClosed: true },
  ): Promise<void> {
    try {
      await this.runCommand(SUDO, DISABLESLEEP_OFF);
    } catch (error) {
      // Keep ownership and the marker; the guard tick or the next start retries.
      this.logger.error({ err: error }, "Failed to clear SleepDisabled");
      return;
    }
    this.disableSleepTakenAt = null;
    this.stopGuardTimer();
    await rm(this.markerPath, { force: true });
    this.logger.info("Cleared SleepDisabled");
    if (options.sleepIfLidClosed) {
      await this.sleepIfLidClosed();
    }
  }

  /**
   * A lid closed while SleepDisabled was set stays "awake but closed" after the flag clears,
   * because macOS only evaluates the lid on a lid or power event. Ask for the sleep the lid
   * close would have caused. A remaining `caffeinate -s` on AC demotes it to a DarkWake.
   */
  private async sleepIfLidClosed(): Promise<void> {
    try {
      const ioreg = await this.runCommand(IOREG, [
        "-r",
        "-n",
        "IOPMrootDomain",
        "-d",
        "1",
        "-k",
        "AppleClamshellState",
      ]);
      if (!/"AppleClamshellState"\s*=\s*Yes/.test(ioreg)) {
        return;
      }
      // Allowed for the console user without sudo (RootDomainUserClient local-user privilege).
      await this.runCommand(PMSET, ["sleepnow"]);
      this.logger.info("Lid is closed; asked macOS to sleep");
    } catch (error) {
      this.logger.warn({ err: error }, "Could not put the closed Mac to sleep");
    }
  }

  private startGuardTimer(): void {
    if (this.guardTimer) {
      return;
    }
    this.guardTimer = setInterval(() => {
      void this.enqueue(() => this.runGuards());
    }, GUARD_POLL_MS);
    this.guardTimer.unref?.();
  }

  private stopGuardTimer(): void {
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }

  private async runGuards(): Promise<void> {
    if (this.stopped || this.disableSleepTakenAt === null) {
      return;
    }
    if (!this.disableSleepLatched) {
      const reason = await this.findTrippedGuard();
      if (reason) {
        this.logger.warn(
          { reason },
          "Releasing SleepDisabled; caffeinate stays until agents go idle",
        );
        this.disableSleepLatched = true;
      }
    }
    await this.reconcile();
  }

  /** Fails safe: a guard input that cannot be read counts as tripped. */
  private async findTrippedGuard(): Promise<string | null> {
    try {
      const battery = parseBattery(await this.runCommand(PMSET, ["-g", "batt"]));
      if (
        battery.onBattery &&
        (battery.percent === null || battery.percent <= this.readSettings().batteryFloorPercent)
      ) {
        return "low-battery";
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Could not read battery state");
      return "battery-unreadable";
    }
    try {
      const level = parseThermalPressure(
        await this.runCommand(NOTIFYUTIL, ["-g", "com.apple.system.thermalpressurelevel"]),
      );
      if (level === null || level >= THERMAL_PRESSURE_HEAVY) {
        return "thermal-pressure";
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Could not read thermal pressure");
      return "thermal-unreadable";
    }
    return null;
  }

  /** A marker at start means the previous daemon died holding SleepDisabled. */
  private async recoverAbandonedDisableSleep(): Promise<void> {
    let marker: string;
    try {
      marker = await readFile(this.markerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      if (parseSleepDisabled(await this.runCommand(PMSET, ["-g"]))) {
        await this.runCommand(SUDO, DISABLESLEEP_OFF);
      }
    } catch (error) {
      // Leave the marker so the next start tries again.
      this.logger.error(
        { err: error, marker },
        "Failed to clear SleepDisabled left by a previous daemon",
      );
      return;
    }
    await rm(this.markerPath, { force: true });
    this.logger.warn({ marker }, "Cleared SleepDisabled left by a previous daemon");
  }
}
