import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";
import { ProviderCatalogStore } from "./provider-catalog-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPaseoHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-provider-catalog-store-"));
  dirs.push(dir);
  return dir;
}

const CODEX_READY_ENTRY: ProviderSnapshotEntry = {
  provider: "codex",
  status: "ready",
  enabled: true,
  models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
  modes: [{ id: "agent", label: "Agent" }],
};

test("loadSync returns an empty map when no catalog file has been written yet", async () => {
  const store = new ProviderCatalogStore({
    paseoHome: await tempPaseoHome(),
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  expect(store.loadSync().size).toBe(0);
});

test("persist writes an entry that a fresh store for the same directory restores", async () => {
  const paseoHome = await tempPaseoHome();
  const writer = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  await writer.persist("codex", '["provider","host"]', CODEX_READY_ENTRY);

  const reader = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  const restored = reader.loadSync();
  expect(restored.size).toBe(1);
  const entry = restored.get("codex");
  expect(entry?.cacheKey).toBe('["provider","host"]');
  expect(entry?.daemonVersion).toBe("1.0.0");
  expect(entry?.result).toEqual(CODEX_READY_ENTRY);
});

test("loadSync memoizes across calls instead of re-reading the file", async () => {
  const paseoHome = await tempPaseoHome();
  const store = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  await store.persist("codex", '["provider","host"]', CODEX_READY_ENTRY);
  // persist() already refreshed the in-memory map; loadSync must not drop it
  // by re-reading a file it hasn't written to since.
  const first = store.loadSync();
  const second = store.loadSync();
  expect(second).toBe(first);
});

test("drops an entry written by a different daemon version", async () => {
  const paseoHome = await tempPaseoHome();
  const writer = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  await writer.persist("codex", '["provider","host"]', CODEX_READY_ENTRY);

  const reader = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "2.0.0",
  });
  expect(reader.loadSync().size).toBe(0);
});

test("drops the whole file when it fails schema validation", async () => {
  const paseoHome = await tempPaseoHome();
  await writeFile(
    path.join(paseoHome, "provider-catalogs.json"),
    JSON.stringify({ version: 999, providers: {} }),
  );
  const store = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  expect(store.loadSync().size).toBe(0);
});

test("drops the whole file when it is not valid JSON", async () => {
  const paseoHome = await tempPaseoHome();
  await writeFile(path.join(paseoHome, "provider-catalogs.json"), "not json");
  const store = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  expect(store.loadSync().size).toBe(0);
});

test("persist overwrites only the given provider's entry, keeping siblings", async () => {
  const paseoHome = await tempPaseoHome();
  const store = new ProviderCatalogStore({
    paseoHome,
    logger: createTestLogger(),
    daemonVersion: "1.0.0",
  });
  await store.persist("codex", '["provider","host"]', CODEX_READY_ENTRY);
  const claudeEntry: ProviderSnapshotEntry = {
    provider: "claude",
    status: "ready",
    enabled: true,
    models: [{ provider: "claude", id: "claude-opus-5", label: "Opus 5" }],
    modes: [],
  };
  await store.persist("claude", '["provider","host"]', claudeEntry);

  const onDisk = JSON.parse(
    await readFile(path.join(paseoHome, "provider-catalogs.json"), "utf-8"),
  );
  expect(Object.keys(onDisk.providers).sort()).toEqual(["claude", "codex"]);
});
