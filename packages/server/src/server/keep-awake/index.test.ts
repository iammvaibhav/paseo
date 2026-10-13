import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { KeepAwakeService, type KeepAwakeLevel } from "./index.js";

const DAEMON_PID = 4242;
const MARKER_FILE = "keep-awake-disablesleep.json";
const TAKE_FLAG = "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1";
const CLEAR_FLAG = "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0";

interface FakeChild {
  args: string[];
  alive: boolean;
  /** Simulates the process dying on its own. */
  exit: () => void;
}

interface HarnessOptions {
  level?: KeepAwakeLevel;
  maxLidClosedMinutes?: number;
  platform?: NodeJS.Platform;
  sleepDisabled?: boolean;
  sudoFails?: boolean;
  paseoHome?: string;
}

const paseoHomes: string[] = [];

function createPaseoHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "keep-awake-"));
  paseoHomes.push(home);
  return home;
}

function createHarness(options: HarnessOptions = {}) {
  const paseoHome = options.paseoHome ?? createPaseoHome();
  const agents: Array<{ provider: string; lifecycle: string }> = [];
  const subagents: Array<{ status: string }> = [];
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const configListeners = new Set<() => void>();
  const config = {
    keepAwakeWhileAgentsRun: options.level ?? "idle",
    keepAwakeMaxLidClosedMinutes: options.maxLidClosedMinutes ?? 240,
  };
  const host = {
    sleepDisabled: options.sleepDisabled ?? false,
    sudoFails: options.sudoFails ?? false,
    battery: { onBattery: false, percent: 100 },
    thermalPressure: 0,
  };
  const commands: string[] = [];
  const children: FakeChild[] = [];

  const service = new KeepAwakeService({
    agentManager: {
      subscribe: (callback: (event: AgentManagerEvent) => void) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
      listAgents: () => agents,
      listProviderSubagentActivity: () => subagents,
    } as never,
    daemonConfigStore: {
      get: () => config,
      onChange: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    } as never,
    logger: createTestLogger(),
    paseoHome,
    platform: options.platform ?? "darwin",
    pid: DAEMON_PID,
    runCommand: async (command, args) => {
      const line = [command, ...args].join(" ");
      commands.push(line);
      if (line === "/usr/bin/pmset -g") {
        return ` Sleep On Power Button 1\n SleepDisabled\t\t${host.sleepDisabled ? 1 : 0}\n womp 1\n`;
      }
      if (line === "/usr/bin/pmset -g batt") {
        const source = host.battery.onBattery ? "Battery Power" : "AC Power";
        return `Now drawing from '${source}'\n -InternalBattery-0 (id=1)\t${host.battery.percent}%; discharging; present: true\n`;
      }
      if (line === "/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel") {
        return `com.apple.system.thermalpressurelevel ${host.thermalPressure}\n`;
      }
      if (line === TAKE_FLAG || line === CLEAR_FLAG) {
        if (host.sudoFails) {
          throw new Error("sudo: a password is required");
        }
        host.sleepDisabled = line === TAKE_FLAG;
        return "";
      }
      throw new Error(`unexpected command: ${line}`);
    },
    spawnProcess: (command, args, onExit) => {
      const child: FakeChild = {
        args: [command, ...args],
        alive: true,
        exit: () => {
          child.alive = false;
          onExit();
        },
      };
      children.push(child);
      return { kill: child.exit };
    },
  });

  const emit = (type: "agent_state" | "provider_subagent") => {
    for (const subscriber of subscribers) {
      subscriber({ type } as AgentManagerEvent);
    }
  };

  return {
    service,
    agents,
    subagents,
    config,
    host,
    commands,
    children,
    markerPath: path.join(paseoHome, MARKER_FILE),
    liveChildren: () => children.filter((child) => child.alive),
    /** Changes agent state, emits the event and waits for the service to apply it. */
    async setRunning(running: boolean, provider = "claude") {
      agents.length = 0;
      if (running) {
        agents.push({ provider, lifecycle: "running" });
      }
      emit("agent_state");
      await service.evaluate();
    },
    async changeConfig(patch: Partial<typeof config>) {
      Object.assign(config, patch);
      for (const listener of configListeners) {
        listener();
      }
      await service.evaluate();
    },
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      await service.evaluate();
    },
    emit,
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const home of paseoHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("KeepAwakeService idle level", () => {
  test("holds one caffeinate while busy and releases it 60 s after agents go idle", async () => {
    const harness = createHarness();
    harness.service.start();

    await harness.setRunning(true);
    await harness.setRunning(true);
    expect(harness.children.map((child) => child.args)).toEqual([
      ["/usr/bin/caffeinate", "-i", "-s", "-w", String(DAEMON_PID)],
    ]);

    // A gap between turns shorter than the debounce keeps the same assertion.
    await harness.setRunning(false);
    await harness.advance(59_000);
    await harness.setRunning(true);
    await harness.setRunning(false);
    await harness.advance(59_000);
    expect(harness.liveChildren()).toHaveLength(1);
    expect(harness.children).toHaveLength(1);

    await harness.advance(1_000);
    expect(harness.liveChildren()).toHaveLength(0);
    expect(harness.commands).toEqual([]);
  });

  test("counts running agents of any provider and running subagents", async () => {
    const codex = createHarness();
    codex.service.start();
    await codex.setRunning(true, "codex");
    expect(codex.liveChildren()).toHaveLength(1);

    const subagent = createHarness();
    subagent.service.start();
    subagent.subagents.push({ status: "running" });
    subagent.emit("provider_subagent");
    await subagent.service.evaluate();
    expect(subagent.liveChildren()).toHaveLength(1);
  });

  test("respawns caffeinate when it dies while agents are still running", async () => {
    const harness = createHarness();
    harness.service.start();
    await harness.setRunning(true);

    harness.children[0]?.exit();
    await harness.setRunning(true);
    expect(harness.liveChildren()).toHaveLength(0);

    await harness.advance(5_000);
    expect(harness.children).toHaveLength(2);
    expect(harness.liveChildren()).toHaveLength(1);
  });

  test("does nothing when off or on a non-darwin host", async () => {
    const off = createHarness({ level: "off" });
    off.service.start();
    await off.setRunning(true);

    const linuxHome = createPaseoHome();
    writeFileSync(path.join(linuxHome, MARKER_FILE), "{}");
    const linux = createHarness({ platform: "linux", level: "lid-closed", paseoHome: linuxHome });
    linux.service.start();
    await linux.setRunning(true);

    expect(off.children).toEqual([]);
    expect(off.commands).toEqual([]);
    expect(linux.children).toEqual([]);
    expect(linux.commands).toEqual([]);
    expect(existsSync(linux.markerPath)).toBe(true);
  });

  test("turning the setting off releases at once without a restart", async () => {
    const harness = createHarness({ level: "lid-closed" });
    harness.service.start();
    await harness.setRunning(true);
    expect(harness.host.sleepDisabled).toBe(true);

    await harness.changeConfig({ keepAwakeWhileAgentsRun: "off" });

    expect(harness.liveChildren()).toHaveLength(0);
    expect(harness.host.sleepDisabled).toBe(false);
  });
});

describe("KeepAwakeService lid-closed level", () => {
  test("takes SleepDisabled with the exact sudo argv and releases it after the debounce", async () => {
    const harness = createHarness({ level: "lid-closed" });
    harness.service.start();

    await harness.setRunning(true);
    expect(harness.commands).toContain(TAKE_FLAG);
    expect(harness.host.sleepDisabled).toBe(true);
    expect(harness.liveChildren()).toHaveLength(1);
    expect(JSON.parse(readFileSync(harness.markerPath, "utf8"))).toMatchObject({
      pid: DAEMON_PID,
    });

    await harness.setRunning(false);
    await harness.advance(60_000);

    expect(harness.commands.filter((line) => line.startsWith("/usr/bin/sudo"))).toEqual([
      TAKE_FLAG,
      CLEAR_FLAG,
    ]);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(existsSync(harness.markerPath)).toBe(false);
    expect(harness.liveChildren()).toHaveLength(0);
  });

  test("never clears a SleepDisabled someone else set", async () => {
    const harness = createHarness({ level: "lid-closed", sleepDisabled: true });
    harness.service.start();

    await harness.setRunning(true);
    await harness.setRunning(false);
    await harness.advance(60_000);
    await harness.service.stop();

    expect(harness.commands.some((line) => line.startsWith("/usr/bin/sudo"))).toBe(false);
    expect(harness.host.sleepDisabled).toBe(true);
    expect(existsSync(harness.markerPath)).toBe(false);
  });

  test("releases the flag on battery at 25% but not 26%, keeping caffeinate", async () => {
    const harness = createHarness({ level: "lid-closed" });
    harness.service.start();
    await harness.setRunning(true);

    harness.host.battery = { onBattery: true, percent: 26 };
    await harness.advance(30_000);
    expect(harness.host.sleepDisabled).toBe(true);

    harness.host.battery = { onBattery: true, percent: 25 };
    await harness.advance(30_000);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(existsSync(harness.markerPath)).toBe(false);
    expect(harness.liveChildren()).toHaveLength(1);
  });

  test("releases the flag under heavy thermal pressure", async () => {
    const harness = createHarness({ level: "lid-closed" });
    harness.service.start();
    await harness.setRunning(true);

    harness.host.thermalPressure = 1;
    await harness.advance(30_000);
    expect(harness.host.sleepDisabled).toBe(true);

    harness.host.thermalPressure = 2;
    await harness.advance(30_000);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(harness.liveChildren()).toHaveLength(1);
  });

  test("a tripped guard latches until agents go idle and busy again", async () => {
    const harness = createHarness({ level: "lid-closed", maxLidClosedMinutes: 1 });
    harness.service.start();
    await harness.setRunning(true);

    await harness.advance(60_000);
    expect(harness.host.sleepDisabled).toBe(false);

    // Still busy: neither new events nor further guard polls retake the flag.
    await harness.setRunning(true);
    await harness.advance(30_000);
    expect(harness.commands.filter((line) => line === TAKE_FLAG)).toHaveLength(1);
    expect(harness.liveChildren()).toHaveLength(1);

    await harness.setRunning(false);
    await harness.advance(60_000);
    await harness.setRunning(true);
    expect(harness.commands.filter((line) => line === TAKE_FLAG)).toHaveLength(2);
    expect(harness.host.sleepDisabled).toBe(true);
  });

  test("falls back to caffeinate only when sudo -n fails", async () => {
    const harness = createHarness({ level: "lid-closed", sudoFails: true });
    harness.service.start();

    await harness.setRunning(true);
    await harness.setRunning(true);
    await harness.advance(30_000);

    expect(harness.commands.filter((line) => line === TAKE_FLAG)).toHaveLength(1);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(existsSync(harness.markerPath)).toBe(false);
    expect(harness.liveChildren()).toHaveLength(1);
  });

  test("stop releases caffeinate and the flag", async () => {
    const harness = createHarness({ level: "lid-closed" });
    harness.service.start();
    await harness.setRunning(true);

    await harness.service.stop();

    expect(harness.liveChildren()).toHaveLength(0);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(existsSync(harness.markerPath)).toBe(false);
  });
});

describe("KeepAwakeService crash recovery", () => {
  test("clears a flag left by a previous daemon and removes its marker", async () => {
    const paseoHome = createPaseoHome();
    writeFileSync(path.join(paseoHome, MARKER_FILE), JSON.stringify({ pid: 1, takenAt: "x" }));
    const harness = createHarness({ level: "idle", sleepDisabled: true, paseoHome });

    harness.service.start();
    await harness.service.evaluate();

    expect(harness.commands).toContain(CLEAR_FLAG);
    expect(harness.host.sleepDisabled).toBe(false);
    expect(existsSync(harness.markerPath)).toBe(false);
  });

  test("removes a stale marker without running sudo when the flag is already clear", async () => {
    const paseoHome = createPaseoHome();
    writeFileSync(path.join(paseoHome, MARKER_FILE), JSON.stringify({ pid: 1, takenAt: "x" }));
    const harness = createHarness({ paseoHome });

    harness.service.start();
    await harness.service.evaluate();

    expect(harness.commands).toEqual(["/usr/bin/pmset -g"]);
    expect(existsSync(harness.markerPath)).toBe(false);
  });

  test("leaves a flag alone at start when there is no marker", async () => {
    const harness = createHarness({ level: "lid-closed", sleepDisabled: true });

    harness.service.start();
    await harness.service.evaluate();

    expect(harness.commands).toEqual([]);
    expect(harness.host.sleepDisabled).toBe(true);
  });
});
