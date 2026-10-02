import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutomationClaimStore } from "./claim-store.js";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("AutomationClaimStore", () => {
  it("claims an event exactly once (atomic INSERT OR IGNORE)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-automation-claims-"));
    const store = await AutomationClaimStore.open({
      dbPath: join(dir, "claims.db"),
      execMkdir: (path: string) => mkdir(path, { recursive: true }).then(() => undefined),
      dirname,
      logger: logger(),
    });
    expect(store.durable).toBe(true);
    expect(store.claim("auto-1", "github:issue:acme/web:12", 1)).toBe(true);
    expect(store.claim("auto-1", "github:issue:acme/web:12", 2)).toBe(false);
    // A different automation may claim the same event key independently.
    expect(store.claim("auto-2", "github:issue:acme/web:12", 3)).toBe(true);
    store.dropAutomation("auto-1");
    expect(store.claim("auto-1", "github:issue:acme/web:12", 4)).toBe(true);
  });

  it("falls back to an in-memory set when node:sqlite is missing", async () => {
    const store = new (AutomationClaimStore as unknown as {
      new (db: null): AutomationClaimStore;
    })(null);
    expect(store.durable).toBe(false);
    expect(store.claim("auto-1", "k", 1)).toBe(true);
    expect(store.claim("auto-1", "k", 1)).toBe(false);
  });

  it("prunes claims outside the retention window in memory", async () => {
    const store = new (AutomationClaimStore as unknown as {
      new (db: null): AutomationClaimStore;
    })(null);
    expect(store.claim("auto-1", "old", 100)).toBe(true);
    expect(store.claim("auto-1", "new", 900)).toBe(true);
    store.pruneOlderThan(500);
    // The pruned key is claimable again; the retained key is still claimed.
    expect(store.claim("auto-1", "old", 1000)).toBe(true);
    expect(store.claim("auto-1", "new", 1000)).toBe(false);
  });

  it("prunes durable claims outside the retention window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-automation-claims-"));
    const store = await AutomationClaimStore.open({
      dbPath: join(dir, "claims.db"),
      execMkdir: (path: string) => mkdir(path, { recursive: true }).then(() => undefined),
      dirname,
      logger: logger(),
    });
    expect(store.claim("auto-1", "old", 100)).toBe(true);
    expect(store.claim("auto-1", "new", 900)).toBe(true);
    store.pruneOlderThan(500);
    expect(store.claim("auto-1", "old", 1000)).toBe(true);
    expect(store.claim("auto-1", "new", 1000)).toBe(false);
  });
});
