import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CentralMissionControlConfigStore } from "./config.js";

describe("CentralMissionControlConfigStore stall knobs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("defaults: silence 120, status 300, escalate 300, dormant turn 300", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get()).toMatchObject({
      silenceNudgeSeconds: 120,
      statusNudgeSeconds: 300,
      escalateSeconds: 300,
      dormantTurnSeconds: 300,
    });
  });

  test("dormantTurnSeconds round-trips through patch and a fresh store instance", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    const patched = await store.patch({ dormantTurnSeconds: 600 });
    expect(patched.dormantTurnSeconds).toBe(600);
    // A second store instance reads the persisted value back.
    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().dormantTurnSeconds).toBe(600);
    // Unpatched keys keep defaults.
    expect(reloaded.get().escalateSeconds).toBe(300);
  });

  test("delivery modes default to interrupt and accept the full union via patch", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().commanderToWorkerMode).toBe("interrupt");
    expect(store.get().verifierToWorkerMode).toBe("interrupt");

    const patched = await store.patch({
      commanderToWorkerMode: "steer",
      verifierToWorkerMode: "queue",
    });
    expect(patched.commanderToWorkerMode).toBe("steer");
    expect(patched.verifierToWorkerMode).toBe("queue");
    // A second store instance reads the persisted values back.
    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().commanderToWorkerMode).toBe("steer");
    expect(reloaded.get().verifierToWorkerMode).toBe("queue");
  });

  test("legacy nudgeSeconds migrates to statusNudgeSeconds at load and is dropped from the file", async () => {
    await mkdir(join(dir, "mission-control"), { recursive: true });
    await writeFile(
      join(dir, "mission-control", "central-config.json"),
      JSON.stringify({ nudgeSeconds: 250 }),
      "utf-8",
    );
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().statusNudgeSeconds).toBe(250);
    expect(store.get().silenceNudgeSeconds).toBe(120);
    const persisted = JSON.parse(
      await readFile(join(dir, "mission-control", "central-config.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(persisted["statusNudgeSeconds"]).toBe(250);
    expect(persisted["nudgeSeconds"]).toBeUndefined();
  });

  test("the new statusNudgeSeconds key wins over the legacy alias", async () => {
    await mkdir(join(dir, "mission-control"), { recursive: true });
    await writeFile(
      join(dir, "mission-control", "central-config.json"),
      JSON.stringify({ nudgeSeconds: 250, statusNudgeSeconds: 400 }),
      "utf-8",
    );
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().statusNudgeSeconds).toBe(400);
  });

  test("voiceNodeUrl defaults null and round-trips through patch and reload", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().voiceNodeUrl).toBeNull();

    const patched = await store.patch({ voiceNodeUrl: "ws://127.0.0.1:8787/ws" });
    expect(patched.voiceNodeUrl).toBe("ws://127.0.0.1:8787/ws");
    // Unpatched keys keep defaults.
    expect(patched.hindsightUrl).toBeNull();

    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().voiceNodeUrl).toBe("ws://127.0.0.1:8787/ws");
  });

  test("voiceMode defaults relay and round-trips direct through patch and reload", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().voiceMode).toBe("relay");

    const patched = await store.patch({ voiceMode: "direct" });
    expect(patched.voiceMode).toBe("direct");
    // Unpatched keys keep defaults.
    expect(patched.voiceNodeUrl).toBeNull();

    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().voiceMode).toBe("direct");
  });

  test("initialize is idempotent: a second call never re-reads the file", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    await store.patch({ namingTheme: "indian" });
    // Manually clobber the file; a re-read would load this value, so the
    // in-memory patch surviving proves the second initialize was a no-op.
    await writeFile(
      join(dir, "mission-control", "central-config.json"),
      JSON.stringify({ namingTheme: "nature" }),
      "utf-8",
    );
    await store.initialize();
    expect(store.get().namingTheme).toBe("indian");
  });
});
