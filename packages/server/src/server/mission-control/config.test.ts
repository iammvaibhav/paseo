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

  test("defaults: silence 120, status 300, escalate 300", async () => {
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    expect(store.get()).toMatchObject({
      silenceNudgeSeconds: 120,
      statusNudgeSeconds: 300,
      escalateSeconds: 300,
    });
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
