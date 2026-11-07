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

  test("verifier delivery defaults to interrupt and round-trips; the retired commander mode is dropped", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().verifierToWorkerMode).toBe("interrupt");

    // An older app still patches commanderToWorkerMode: accepted, never stored.
    const patched = await store.patch({
      commanderToWorkerMode: "queue",
      verifierToWorkerMode: "queue",
    });
    expect(patched.verifierToWorkerMode).toBe("queue");
    const stored = JSON.parse(
      await readFile(join(dir, "mission-control", "central-config.json"), "utf8"),
    );
    expect(stored).not.toHaveProperty("commanderToWorkerMode");
    // A second store instance reads the persisted values back.
    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
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

  test("ADR 0002 keys: verifierEnabled/projectSettings/itsaplan default off/empty/null and round-trip through patch and reload", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get().verifierEnabled).toBe(false);
    expect(store.get().projectSettings).toEqual({});
    expect(store.get().itsaplan).toBeNull();

    const patched = await store.patch({
      verifierEnabled: true,
      projectSettings: { "proj-1": { alwaysRaisePr: true } },
      itsaplan: {
        baseUrl: "https://itsaplan.internal",
        apiKey: "sk-test",
        webhookSecret: "whsec-test",
        humanUserId: "user-42",
        commanderUsername: "verify-run-1",
      },
    });
    expect(patched.verifierEnabled).toBe(true);
    expect(patched.projectSettings).toEqual({ "proj-1": { alwaysRaisePr: true } });
    expect(patched.itsaplan).toEqual({
      baseUrl: "https://itsaplan.internal",
      apiKey: "sk-test",
      webhookSecret: "whsec-test",
      humanUserId: "user-42",
      commanderUsername: "verify-run-1",
    });
    // Unpatched keys keep defaults.
    expect(patched.trackVerifiers).toBe(true);

    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().verifierEnabled).toBe(true);
    expect(reloaded.get().projectSettings).toEqual({ "proj-1": { alwaysRaisePr: true } });
    expect(reloaded.get().itsaplan).toEqual({
      baseUrl: "https://itsaplan.internal",
      apiKey: "sk-test",
      webhookSecret: "whsec-test",
      humanUserId: "user-42",
      commanderUsername: "verify-run-1",
    });
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

  test("reload re-reads the persisted file into the live store", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    await store.patch({
      itsaplan: {
        baseUrl: "http://100.123.178.38:3000",
        apiKey: "test-key",
        webhookSecret: "sec",
        humanUserId: "u1",
        webBaseUrl: "http://dev.netbird.cloud:3001",
      },
    });
    expect(store.get().itsaplan?.baseUrl).toBe("http://100.123.178.38:3000");

    // File is updated externally (e.g. by deploy syncConfig)
    await writeFile(
      join(dir, "mission-control", "central-config.json"),
      JSON.stringify({
        itsaplan: {
          baseUrl: "https://itsaplan.thevm.space/__api",
          apiKey: "test-key",
          webhookSecret: "sec",
          humanUserId: "u1",
          webBaseUrl: "https://itsaplan.thevm.space",
        },
      }),
      "utf-8",
    );

    store.reload();
    expect(store.get().itsaplan?.baseUrl).toBe("https://itsaplan.thevm.space/__api");
  });
});
