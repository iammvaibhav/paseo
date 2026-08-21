import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CentralMissionControlConfigStore } from "./config.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

/** Fake DaemonClient: only the central-config surface is real. */
interface FakePeerClient {
  missionControlConfigPatch: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  missionControlConfigReplica: ReturnType<typeof vi.fn>;
}

function createPeerClient(
  overrides: {
    patchResponse?: {
      ok: boolean;
      config?: MissionControlCentralConfig;
      error?: string;
      unreachableCommanderHost?: string;
    };
    patchThrows?: Error;
  } = {},
): FakePeerClient {
  return {
    missionControlConfigPatch: vi.fn(async () => {
      if (overrides.patchThrows) {
        throw overrides.patchThrows;
      }
      const response = overrides.patchResponse ?? { ok: true };
      return {
        requestId: "req-peer",
        config: response.config ?? {},
        ok: response.ok,
        ...(response.error !== undefined ? { error: response.error } : {}),
        ...(response.unreachableCommanderHost !== undefined
          ? { unreachableCommanderHost: response.unreachableCommanderHost }
          : {}),
      };
    }),
    missionControlConfigReplica: vi.fn(),
  } as unknown as DaemonClient;
}

interface FakePeerHarness {
  peerManager: PeerManager;
  client: FakePeerClient;
}

function createPeerHarness(
  options: {
    statuses?: Array<{ name: string; state: "online" | "unreachable" }>;
    patchResponse?: {
      ok: boolean;
      config?: MissionControlCentralConfig;
      error?: string;
      unreachableCommanderHost?: string;
    };
    patchThrows?: Error;
  } = {},
): FakePeerHarness {
  const statuses = options.statuses ?? [];
  const client = createPeerClient({
    patchResponse: options.patchResponse,
    patchThrows: options.patchThrows,
  });
  const onlineNames = new Set(
    statuses.filter((status) => status.state === "online").map((status) => status.name),
  );
  const peerManager = {
    getPeerStatus: (name: string) => statuses.find((status) => status.name === name) ?? null,
    getPeerStatuses: () =>
      statuses.map((status) => ({
        name: status.name,
        url: `tcp://${status.name}:6767`,
        state: status.state,
        lastSeenAt: status.state === "online" ? new Date().toISOString() : null,
      })),
    getPeerClient: (name: string) => (onlineNames.has(name) ? client : null),
  } as unknown as PeerManager;
  return { peerManager, client };
}

describe("MissionControlService central-config ownership + replication", () => {
  let dir: string;
  let store: CentralMissionControlConfigStore;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      hostName?: string;
      hostAlias?: string | null;
      peerManager?: PeerManager | null | (() => PeerManager | null);
      seedConfig?: MissionControlCentralConfig;
      start?: boolean;
    } = {},
  ): Promise<void> {
    logger = createMockLogger();
    store = new CentralMissionControlConfigStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
    if (options.seedConfig && Object.keys(options.seedConfig).length > 0) {
      await store.patch(options.seedConfig);
    }
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: () => null,
        listAgents: () => [],
        subscribe: vi.fn((_cb: (event: AgentManagerEvent) => void) => () => {}),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: options.hostName ?? "host-a",
      hostAlias: options.hostAlias ?? null,
      peerManager: options.peerManager ?? null,
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      centralConfig: store,
    });
    if (options.start !== false) {
      await service.start();
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-config-repl-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Standalone: no commanderHost designated — local apply, no routing.
  // ==========================================================================

  test("standalone (no commanderHost): patch applies locally, nothing forwarded or replicated", async () => {
    await createService();
    const result = await service.patchCentralConfigRouted({ statusNudgeSeconds: 420 });
    expect(result).toMatchObject({ ok: true });
    expect(store.get().statusNudgeSeconds).toBe(420);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("standalone mode toggle applies locally", async () => {
    await createService();
    const result = await service.setModeRouted("auto");
    expect(result).toMatchObject({ ok: true });
    expect(store.get().mode).toBe("auto");
  });

  // ==========================================================================
  // Owner: applies + persists + replicates to every online peer.
  // ==========================================================================

  test("owner applies the patch, persists it, and pushes a replica to every online peer", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [
        { name: "peer-b", state: "online" },
        { name: "peer-c", state: "unreachable" },
      ],
    });
    await createService({
      hostAlias: "commander-a",
      seedConfig: { commanderHost: "commander-a" },
      peerManager,
    });
    const result = await service.patchCentralConfigRouted({ silenceNudgeSeconds: 90 });

    expect(result).toMatchObject({ ok: true });
    // Local store + persisted file updated.
    expect(store.get().silenceNudgeSeconds).toBe(90);
    const persisted = JSON.parse(
      await readFile(join(dir, "mission-control", "central-config.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(persisted["silenceNudgeSeconds"]).toBe(90);

    // Replica pushed ONLY to the online peer, carrying the FULL resolved snapshot.
    expect(client.missionControlConfigReplica).toHaveBeenCalledTimes(1);
    const replicaArgs = vi.mocked(client.missionControlConfigReplica).mock.calls[0];
    expect(replicaArgs[0]).toMatchObject({ silenceNudgeSeconds: 90, commanderHost: "commander-a" });
    expect(replicaArgs[1]).toEqual({ from: "host-a" });
    // The unreachable peer never gets a replica (only online peers are pushed).
    expect(vi.mocked(client.missionControlConfigReplica).mock.calls.length).toBe(1);
  });

  test("owner mode toggle applies + replicates", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "peer-b", state: "online" }],
    });
    await createService({
      hostAlias: "commander-a",
      seedConfig: { commanderHost: "commander-a" },
      peerManager,
    });
    const result = await service.setModeRouted("auto");
    expect(result).toMatchObject({ ok: true });
    expect(store.get().mode).toBe("auto");
    expect(client.missionControlConfigReplica).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.missionControlConfigReplica).mock.calls[0][0]).toMatchObject({
      mode: "auto",
    });
  });

  // ==========================================================================
  // Non-owner: forwards to the commander host, returns ITS response.
  // ==========================================================================

  test("non-owner forwards the patch to the commander host and returns its response", async () => {
    const peerResponse = { ok: true as const, config: { statusNudgeSeconds: 777 } };
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "commander-a", state: "online" }],
      patchResponse: peerResponse,
    });
    await createService({
      hostName: "host-b",
      hostAlias: "host-b-alias",
      seedConfig: { commanderHost: "commander-a", statusNudgeSeconds: 300 },
      peerManager,
    });

    const result = await service.patchCentralConfigRouted({ statusNudgeSeconds: 777 });
    expect(result).toEqual({ ok: true, config: { statusNudgeSeconds: 777 } });
    // Forwarded verbatim (the commander host's session applies + replicates).
    expect(vi.mocked(client.missionControlConfigPatch)).toHaveBeenCalledWith({
      statusNudgeSeconds: 777,
    });
    // NEVER applied locally; NEVER replicated by the non-owner.
    expect(store.get().statusNudgeSeconds).toBe(300);
    expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
  });

  test("non-owner forwards the mode toggle to the commander host", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "commander-a", state: "online" }],
      patchResponse: { ok: true, config: { mode: "auto" } },
    });
    await createService({
      hostName: "host-b",
      seedConfig: { commanderHost: "commander-a", mode: "ask" },
      peerManager,
    });
    const result = await service.setModeRouted("auto");
    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(client.missionControlConfigPatch)).toHaveBeenCalledWith({ mode: "auto" });
    expect(store.get().mode).toBe("ask");
  });

  // ==========================================================================
  // Unreachable commander host: explicit error, NEVER applied locally.
  // ==========================================================================

  test.each([
    ["not a configured peer", []],
    ["peer exists but offline", [{ name: "commander-a", state: "unreachable" }]],
  ] as const)(
    "commander host %s: explicit unreachable error, local config untouched",
    async (_label, statuses) => {
      const { peerManager, client } = createPeerHarness({
        statuses: statuses as Array<{ name: string; state: "online" | "unreachable" }>,
      });
      await createService({
        hostName: "host-b",
        seedConfig: { commanderHost: "commander-a", statusNudgeSeconds: 300 },
        peerManager,
      });
      const result = await service.patchCentralConfigRouted({ statusNudgeSeconds: 600 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.unreachableCommanderHost).toBe("commander-a");
        expect(result.error).toContain("NOT updated");
        expect(result.config).toMatchObject({ statusNudgeSeconds: 300 });
      }
      // NEVER applied locally, NEVER forwarded, NEVER silently succeeded.
      expect(store.get().statusNudgeSeconds).toBe(300);
      expect(client.missionControlConfigPatch).not.toHaveBeenCalled();
      expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
    },
  );

  test("commander host round-trip failure: explicit unreachable error, local config untouched", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "commander-a", state: "online" }],
      patchThrows: new Error("socket hang up"),
    });
    await createService({
      hostName: "host-b",
      seedConfig: { commanderHost: "commander-a", statusNudgeSeconds: 300 },
      peerManager,
    });
    const result = await service.patchCentralConfigRouted({ statusNudgeSeconds: 600 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unreachableCommanderHost).toBe("commander-a");
      expect(result.error).toContain("socket hang up");
    }
    expect(store.get().statusNudgeSeconds).toBe(300);
    expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
  });

  test("commander host rejection is propagated with its error (no unreachable flag)", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "commander-a", state: "online" }],
      patchResponse: { ok: false, error: "validation failed: escalateSeconds too small" },
    });
    await createService({
      hostName: "host-b",
      seedConfig: { commanderHost: "commander-a" },
      peerManager,
    });
    const result = await service.patchCentralConfigRouted({ escalateSeconds: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("validation failed: escalateSeconds too small");
      expect(result.unreachableCommanderHost).toBeUndefined();
    }
    expect(store.get().escalateSeconds).toBe(300);
    expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Replica path: full snapshot replace, persists + updates in-memory.
  // ==========================================================================

  test("replica replaces the local snapshot (in-memory + persisted, last-writer-wins)", async () => {
    await createService({ seedConfig: { commanderHost: "commander-a", statusNudgeSeconds: 300 } });
    await service.applyCentralConfigReplica({
      commanderHost: "commander-a",
      silenceNudgeSeconds: 45,
      statusNudgeSeconds: 480,
      mode: "auto",
    });
    expect(store.get().silenceNudgeSeconds).toBe(45);
    expect(store.get().statusNudgeSeconds).toBe(480);
    expect(store.get().mode).toBe("auto");
    // Unmentioned keys fall back to defaults, NOT to the previous snapshot
    // (a replace is authoritative — no merging).
    expect(store.get().escalateSeconds).toBe(300);
    // A fresh store instance reads the persisted replica back.
    const reloaded = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await reloaded.initialize();
    expect(reloaded.get().statusNudgeSeconds).toBe(480);
    expect(reloaded.get().mode).toBe("auto");
  });

  test("replica receive never re-pushes (no replication loop)", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "peer-b", state: "online" }],
    });
    await createService({
      hostAlias: "commander-a",
      seedConfig: { commanderHost: "commander-a" },
      peerManager,
    });
    await service.applyCentralConfigReplica({ silenceNudgeSeconds: 42 });
    expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Sync-on-connect: the commander host pushes its snapshot to a peer that
  // just came online; other hosts never do.
  // ==========================================================================

  test("sync-on-connect: commander host pushes its current snapshot to the peer", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [{ name: "peer-b", state: "online" }],
    });
    await createService({
      hostAlias: "commander-a",
      seedConfig: { commanderHost: "commander-a", statusNudgeSeconds: 480 },
      peerManager,
    });
    await service.syncCentralConfigToPeer("peer-b");
    expect(client.missionControlConfigReplica).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.missionControlConfigReplica).mock.calls[0][0]).toMatchObject({
      commanderHost: "commander-a",
      statusNudgeSeconds: 480,
    });
  });

  test("sync-on-connect: a non-owner host never pushes", async () => {
    const { peerManager, client } = createPeerHarness({ statuses: [] });
    await createService({
      hostName: "host-b",
      seedConfig: { commanderHost: "commander-a" },
      peerManager,
    });
    await service.syncCentralConfigToPeer("commander-a");
    expect(client.missionControlConfigReplica).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // commanderHost migration: the old owner applies, then pushes the final
  // snapshot to every peer (new owner included) — one migration hop.
  // ==========================================================================

  test("changing commanderHost: old owner applies and pushes the final snapshot to ALL online peers", async () => {
    const { peerManager, client } = createPeerHarness({
      statuses: [
        { name: "new-owner", state: "online" },
        { name: "peer-c", state: "online" },
      ],
    });
    await createService({
      hostAlias: "old-owner",
      seedConfig: { commanderHost: "old-owner", statusNudgeSeconds: 300 },
      peerManager,
    });
    const result = await service.patchCentralConfigRouted({
      commanderHost: "new-owner",
      statusNudgeSeconds: 540,
    });
    expect(result).toMatchObject({ ok: true });
    // One migration hop: the old owner pushed to EVERY online peer, including
    // the new owner, and the snapshot carries the NEW commanderHost.
    expect(client.missionControlConfigReplica).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(client.missionControlConfigReplica).mock.calls) {
      expect(call[0]).toMatchObject({ commanderHost: "new-owner", statusNudgeSeconds: 540 });
    }
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: "config", from: "old-owner", to: "new-owner" }),
      expect.stringContaining("commander_host_migrated"),
    );
  });
});
