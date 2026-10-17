import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { PeerManager } from "./peer-manager.js";

describe("PeerManager lastSeen against a real peer daemon", () => {
  it("stamps and persists lastSeenAt when a connected peer goes away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-last-seen-e2e-"));
    const lastSeenPath = join(dir, "peer-last-seen.json");
    const peer = await createTestPaseoDaemon();
    const manager = new PeerManager({
      logger: pino({ level: "silent" }),
      peers: [{ name: "peer-a", url: `tcp://127.0.0.1:${peer.port}` }],
      lastSeenPath,
    });
    try {
      await vi.waitFor(() => expect(manager.getPeerStatus("peer-a")?.state).toBe("online"), {
        timeout: 15_000,
        interval: 100,
      });
      const onlineAt = manager.getPeerStatus("peer-a")?.lastSeenAt;
      expect(onlineAt).toEqual(expect.any(String));

      const closedAt = Date.now();
      await peer.close();
      await vi.waitFor(() => expect(manager.getPeerStatus("peer-a")?.state).toBe("unreachable"), {
        timeout: 15_000,
        interval: 100,
      });

      // The drop, not the earlier connect, is the last moment this host saw it.
      const droppedAt = manager.getPeerStatus("peer-a")?.lastSeenAt ?? "";
      expect(Date.parse(droppedAt)).toBeGreaterThanOrEqual(closedAt);
      await vi.waitFor(
        () =>
          expect(JSON.parse(readFileSync(lastSeenPath, "utf8"))).toEqual({ "peer-a": droppedAt }),
        { timeout: 5_000, interval: 50 },
      );

      // A restarted daemon (new PeerManager) still knows when the peer was last seen.
      const restarted = new PeerManager({
        logger: pino({ level: "silent" }),
        peers: [{ name: "peer-a", url: `tcp://127.0.0.1:${peer.port}` }],
        lastSeenPath,
      });
      expect(restarted.getPeerStatus("peer-a")).toMatchObject({
        state: "unreachable",
        lastSeenAt: droppedAt,
      });
      await restarted.close();
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
