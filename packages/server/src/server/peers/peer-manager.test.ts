import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  PeerManager,
  buildPeerUnreachableError,
  formatPeerLastSeen,
  resolvePeerIdentityName,
} from "./peer-manager.js";

describe("resolvePeerIdentityName", () => {
  const peers = [
    {
      config: { name: "iammvaibhav" },
      serverId: "srv_personal",
      hostname: "vaibhav-dev",
      missionControlHostAlias: "personal/i am vaibhav server",
    },
    {
      config: { name: "blrofc3" },
      serverId: "srv_office",
      hostname: "blrofc3.local",
      missionControlHostAlias: "office server",
    },
  ];

  it("matches configured peer name first", () => {
    expect(resolvePeerIdentityName(peers, "iammvaibhav")).toBe("iammvaibhav");
  });

  it("matches serverId", () => {
    expect(resolvePeerIdentityName(peers, "srv_office")).toBe("blrofc3");
  });

  it("matches hostname so central commanderHost designations resolve", () => {
    expect(resolvePeerIdentityName(peers, "vaibhav-dev")).toBe("iammvaibhav");
  });

  it("matches missionControl host alias", () => {
    expect(resolvePeerIdentityName(peers, "personal/i am vaibhav server")).toBe("iammvaibhav");
  });

  it("trims the designation and returns null for unknown peers", () => {
    expect(resolvePeerIdentityName(peers, "  vaibhav-dev  ")).toBe("iammvaibhav");
    expect(resolvePeerIdentityName(peers, "ghost")).toBeNull();
    expect(resolvePeerIdentityName(peers, "   ")).toBeNull();
  });
});

describe("PeerManager reconcile", () => {
  it("reconciles added, removed, changed, and unchanged peers", async () => {
    const manager = new PeerManager({
      logger: pino({ level: "silent" }),
      peers: [
        { name: "stay", url: "tcp://127.0.0.1:10001", password: "p1" },
        { name: "change-url", url: "tcp://127.0.0.1:10002", password: "p2" },
        { name: "change-pass", url: "tcp://127.0.0.1:10003", password: "p3" },
        { name: "remove-me", url: "tcp://127.0.0.1:10004" },
      ],
    });

    const stayClientBefore = manager.getPeerClient("stay");
    const changeUrlClientBefore = manager.getPeerClient("change-url");
    const changePassClientBefore = manager.getPeerClient("change-pass");
    const removeClientBefore = manager.getPeerClient("remove-me");

    expect(stayClientBefore).not.toBeNull();
    expect(changeUrlClientBefore).not.toBeNull();
    expect(changePassClientBefore).not.toBeNull();
    expect(removeClientBefore).not.toBeNull();

    manager.reconcile([
      { name: "stay", url: "tcp://127.0.0.1:10001", password: "p1" },
      { name: "change-url", url: "tcp://127.0.0.1:10005", password: "p2" },
      { name: "change-pass", url: "tcp://127.0.0.1:10003", password: "p3-new" },
      { name: "new-peer", url: "tcp://127.0.0.1:10006" },
    ]);

    // Allow in-flight client.close() promises to settle
    await Promise.resolve();
    await Promise.resolve();

    // Unchanged peer: identical client instance, kept untouched
    expect(manager.getPeerClient("stay")).toBe(stayClientBefore);
    expect(stayClientBefore?.getConnectionState().status).not.toBe("disposed");

    // Changed URL peer: old client disposed, new client created
    expect(changeUrlClientBefore?.getConnectionState().status).toBe("disposed");
    const changeUrlClientAfter = manager.getPeerClient("change-url");
    expect(changeUrlClientAfter).not.toBeNull();
    expect(changeUrlClientAfter).not.toBe(changeUrlClientBefore);
    expect(manager.getPeerStatus("change-url")?.url).toBe("tcp://127.0.0.1:10005");

    // Changed password peer: old client disposed, new client created
    expect(changePassClientBefore?.getConnectionState().status).toBe("disposed");
    const changePassClientAfter = manager.getPeerClient("change-pass");
    expect(changePassClientAfter).not.toBeNull();
    expect(changePassClientAfter).not.toBe(changePassClientBefore);

    // Removed peer: old client disposed, lookup returns null
    expect(removeClientBefore?.getConnectionState().status).toBe("disposed");
    expect(manager.getPeerClient("remove-me")).toBeNull();
    expect(manager.getPeerStatus("remove-me")).toBeNull();
    expect(manager.resolvePeerName("remove-me")).toBeNull();

    // Added peer: client created, status and resolution reflect immediately
    const newPeerClient = manager.getPeerClient("new-peer");
    expect(newPeerClient).not.toBeNull();
    expect(manager.getPeerStatus("new-peer")?.url).toBe("tcp://127.0.0.1:10006");
    expect(manager.resolvePeerName("new-peer")).toBe("new-peer");

    // Active peers list reflects immediately
    expect(manager.getPeerStatuses().map((p) => p.name)).toEqual([
      "stay",
      "change-url",
      "change-pass",
      "new-peer",
    ]);

    await manager.close();
  });

  it("reflects new set immediately and deduplicates duplicate peer names", async () => {
    const manager = new PeerManager({
      logger: pino({ level: "silent" }),
      peers: [{ name: "peer1", url: "tcp://127.0.0.1:10001" }],
    });

    // Reconcile with duplicates in next list
    manager.reconcile([
      { name: "peer2", url: "tcp://127.0.0.1:10002" },
      { name: "peer2", url: "tcp://127.0.0.1:10003" },
      { name: "peer3", url: "tcp://127.0.0.1:10004" },
    ]);

    // Synchronously updated before any tick
    expect(manager.getPeerStatuses().map((p) => p.name)).toEqual(["peer2", "peer3"]);
    expect(manager.getPeerStatus("peer2")?.url).toBe("tcp://127.0.0.1:10002");
    expect(manager.resolvePeerName("peer1")).toBeNull();
    expect(manager.resolvePeerName("peer2")).toBe("peer2");

    // Reconcile with empty list closes all
    manager.reconcile([]);
    expect(manager.getPeerStatuses()).toEqual([]);
    expect(manager.resolvePeerName("peer2")).toBeNull();
    expect(manager.getPeerClient("peer2")).toBeNull();

    await manager.close();
  });
});

describe("PeerManager lastSeen", () => {
  it("restores a sleeping peer's lastSeenAt from the persisted file after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-last-seen-"));
    const lastSeenPath = join(dir, "peer-last-seen.json");
    writeFileSync(lastSeenPath, JSON.stringify({ macbook: "2026-10-12T23:12:53.000Z" }));
    const manager = new PeerManager({
      logger: pino({ level: "silent" }),
      peers: [
        { name: "macbook", url: "tcp://127.0.0.1:1" },
        { name: "grok-bot", url: "tcp://127.0.0.1:2" },
      ],
      lastSeenPath,
    });
    try {
      expect(manager.getPeerStatus("macbook")).toMatchObject({
        state: "unreachable",
        lastSeenAt: "2026-10-12T23:12:53.000Z",
      });
      expect(manager.getPeerStatus("grok-bot")?.lastSeenAt).toBeNull();
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unreadable lastSeen file as no history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-last-seen-"));
    const lastSeenPath = join(dir, "peer-last-seen.json");
    writeFileSync(lastSeenPath, "{not json");
    const manager = new PeerManager({
      logger: pino({ level: "silent" }),
      peers: [{ name: "macbook", url: "tcp://127.0.0.1:1" }],
      lastSeenPath,
    });
    try {
      expect(manager.getPeerStatus("macbook")?.lastSeenAt).toBeNull();
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPeerUnreachableError", () => {
  it("says a never-connected host never connected, not 'since never'", () => {
    const message = buildPeerUnreachableError("grok-bot", null).message;
    expect(message).not.toContain("since never");
    expect(message).toContain('Host "grok-bot" has never connected to this host');
  });

  it("names the last-seen moment in UTC with its age", () => {
    const now = Date.parse("2026-10-13T05:12:53.000Z");
    expect(formatPeerLastSeen("2026-10-12T23:12:53.000Z", now)).toBe(
      "2026-10-12 23:12 UTC (6h ago)",
    );
    expect(formatPeerLastSeen("2026-10-13T05:02:53.000Z", now)).toBe(
      "2026-10-13 05:02 UTC (10m ago)",
    );
    expect(formatPeerLastSeen("2026-10-10T05:12:53.000Z", now)).toBe(
      "2026-10-10 05:12 UTC (3d ago)",
    );
  });
});
