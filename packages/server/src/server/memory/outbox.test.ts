import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { MemoryOutbox, type OutboxTransport } from "./outbox.js";
import type { MemoryItem } from "./types.js";

const item = (id: string, text = "t"): MemoryItem => ({ id, kind: "turn", title: "x", text });

describe("MemoryOutbox", () => {
  const dirs: string[] = [];
  const outboxes: MemoryOutbox[] = [];
  afterEach(async () => {
    for (const o of outboxes.splice(0)) o.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function open(transport: OutboxTransport) {
    const home = await mkdtemp(path.join(tmpdir(), "outbox-"));
    dirs.push(home);
    const outbox = await MemoryOutbox.open({
      paseoHome: home,
      transport: () => transport,
      logger: createTestLogger(),
    });
    if (!outbox) throw new Error("node:sqlite unavailable");
    outboxes.push(outbox);
    return { outbox, home };
  }

  it("keeps items while the memory host is down and delivers them when it is back", async () => {
    let up = false;
    const delivered: string[] = [];
    const { outbox } = await open({
      ingest: async (items) => {
        if (!up) throw new Error("ECONNREFUSED");
        delivered.push(...items.map((i) => i.id));
      },
      writeNote: async () => ({}),
    });
    outbox.enqueueItems([item("a"), item("b")]);
    await outbox.flush();
    expect(outbox.pendingCount()).toBe(2);
    up = true;
    // The failed flush backed off; once the backoff is over, the next flush delivers.
    await outbox.retryNow();
    expect(delivered.sort()).toEqual(["a", "b"]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("drops an item identical to one already delivered, but sends a changed one", async () => {
    const delivered: string[] = [];
    const { outbox } = await open({
      ingest: async (items) => void delivered.push(...items.map((i) => `${i.id}:${i.text}`)),
      writeNote: async () => ({}),
    });
    outbox.enqueueItems([item("a")]);
    await outbox.flush();
    expect(outbox.enqueueItems([item("a")])).toBe(0);
    expect(outbox.enqueueItems([item("a", "changed")])).toBe(1);
    await outbox.flush();
    expect(delivered).toEqual(["a:t", "a:changed"]);
  });

  it("survives a restart with undelivered items", async () => {
    const down: OutboxTransport = {
      ingest: async () => {
        throw new Error("down");
      },
      writeNote: async () => ({}),
    };
    const { outbox, home } = await open(down);
    outbox.enqueueItems([item("a")]);
    await outbox.flush();
    outbox.stop();
    outboxes.pop();
    const delivered: string[] = [];
    const reopened = await MemoryOutbox.open({
      paseoHome: home,
      transport: () => ({
        ingest: async (items) => void delivered.push(...items.map((i) => i.id)),
        writeNote: async () => ({}),
      }),
      logger: createTestLogger(),
    });
    outboxes.push(reopened!);
    await reopened!.flush();
    expect(delivered).toEqual(["a"]);
  });
});
