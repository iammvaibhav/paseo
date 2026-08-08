import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { MissionControlService } from "./service.js";
import { AgentNamingService, AGENT_NAMING_THEMES, NAME_POOLS, NAME_QUALIFIERS } from "./naming.js";
import { CentralMissionControlConfigStore } from "./config.js";

/**
 * Fakes for the naming service. setAgentName is the assignment seam: the
 * naming service only ever calls it from the boot backfill (per assigned
 * record), so asserting the calls here pins who gets a name — and, because
 * AgentManager.setAgentName is write-once, that backfill assignments only
 * ever land on never-named records.
 */
interface NamingHarnessOptions {
  theme?: string;
  liveAgents?: Array<{
    id: string;
    name?: string;
    labels?: Record<string, string>;
    internal?: boolean;
  }>;
  storedRecords?: Array<{
    id: string;
    name?: string;
    labels?: Record<string, string>;
    internal?: boolean;
    archivedAt?: string | null;
  }>;
}

function createNamingHarness(options: NamingHarnessOptions = {}) {
  const setAgentName = vi.fn(async () => undefined);
  const listAgents = vi.fn(() =>
    (options.liveAgents ?? []).map((agent) => Object.assign({ labels: {} }, agent)),
  );
  const agentStorage = {
    list: vi.fn(async () =>
      (options.storedRecords ?? []).map((record) => ({
        id: record.id,
        provider: "omp",
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: null,
        labels: record.labels ?? {},
        config: {},
        persistence: null,
        name: record.name,
        internal: record.internal,
        archivedAt: record.archivedAt,
      })),
    ),
  } as unknown as AgentStorage;
  const service = new AgentNamingService({
    agentStorage,
    getAgentManager: () =>
      ({ listAgents, setAgentName }) as unknown as Pick<
        AgentManager,
        "listAgents" | "setAgentName"
      >,
    readTheme: () => options.theme ?? "mixed",
    logger: createTestLogger(),
  });
  return { service, setAgentName };
}

describe("AgentNamingService.backfillMissingNames", () => {
  test("assigns names only to never-named records and never touches named ones", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "indian",
      liveAgents: [{ id: "live-named", name: "Ripley" }],
      storedRecords: [{ id: "named", name: "Miso" }, { id: "unnamed-1" }, { id: "unnamed-2" }],
    });
    const count = await service.backfillMissingNames();
    expect(count).toBe(2);
    expect(setAgentName).toHaveBeenCalledTimes(2);
    const assignedIds = setAgentName.mock.calls.map((call) => call[0] as string).sort();
    expect(assignedIds).toEqual(["unnamed-1", "unnamed-2"]);
    for (const [, assignedName] of setAgentName.mock.calls) {
      expect(NAME_POOLS.indian).toContain(assignedName);
    }
  });

  test("skips internal and mission-control-labeled records", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "indian",
      storedRecords: [
        { id: "internal", internal: true },
        { id: "mc", labels: { "paseo.mission-control": "commander" } },
        { id: "plain" },
      ],
    });
    const count = await service.backfillMissingNames();
    expect(count).toBe(1);
    expect(setAgentName).toHaveBeenCalledTimes(1);
    expect(setAgentName).toHaveBeenCalledWith("plain", expect.any(String));
  });

  test("no missing records → zero assignments, no manager calls", async () => {
    const { service, setAgentName } = createNamingHarness({
      storedRecords: [{ id: "named", name: "Ripley" }],
    });
    expect(await service.backfillMissingNames()).toBe(0);
    expect(setAgentName).not.toHaveBeenCalled();
  });
});

describe("AgentNamingService overflow generation", () => {
  test("an exhausted pool draws 'Qualifier Name' combos before Roman numerals", async () => {
    const theme = "astronauts";
    const pool = NAME_POOLS[theme];
    const { service } = createNamingHarness({
      theme,
      liveAgents: pool.map((name, index) => ({ id: `used-${index}`, name })),
    });
    const name = await service.assignNameForCreatedAgent({
      agentId: "new",
      labels: {},
      internal: false,
    });
    expect(name).not.toBeNull();
    // A two-word qualified combo — and specifically NOT a Roman suffix.
    const parts = name!.split(" ");
    expect(parts).toHaveLength(2);
    expect(NAME_QUALIFIERS).toContain(parts[0]);
    expect(pool).toContain(parts[1]);
    expect(name!).not.toMatch(/ (II|III|IV|V|VI|VII|VIII|IX|X)$/);
  });

  test("Roman numerals appear only after the entire combo space is exhausted", async () => {
    const theme = "nature";
    const pool = NAME_POOLS[theme];
    const combos: string[] = [];
    for (const qualifier of NAME_QUALIFIERS) {
      for (const poolName of pool) {
        combos.push(`${qualifier} ${poolName}`);
      }
    }
    const { service } = createNamingHarness({
      theme,
      liveAgents: [...pool, ...combos].map((name, index) => ({ id: `used-${index}`, name })),
    });
    const name = await service.assignNameForCreatedAgent({
      agentId: "new",
      labels: {},
      internal: false,
    });
    expect(name).not.toBeNull();
    // Last resort: a Roman-numeral suffix off a pool name.
    expect(name!).toMatch(/ (II|III|IV|V|VI|VII|VIII|IX|X)$/);
  });

  test("every theme has at least 2400 qualifier+name combinations", () => {
    for (const theme of AGENT_NAMING_THEMES) {
      expect(NAME_QUALIFIERS.length * NAME_POOLS[theme].length).toBeGreaterThanOrEqual(2400);
    }
  });
});

describe("AgentNamingService theme changes affect future assignments only", () => {
  test("a theme patched after construction renames nobody and is used by the next assignment (fresh read)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-naming-central-"));
    try {
      const store = new CentralMissionControlConfigStore({
        paseoHome: dir,
        logger: createTestLogger(),
      });
      await store.initialize();
      const setAgentName = vi.fn(async () => undefined);
      // Bootstrap wiring: readTheme closes over the SHARED central store, so
      // assignments must see the theme as of call time, not boot time.
      const service = new AgentNamingService({
        agentStorage: {
          list: vi.fn(async () => [
            {
              id: "existing",
              provider: "omp",
              cwd: "/repo",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              title: null,
              labels: {},
              config: {},
              persistence: null,
              name: "Ripley",
              internal: false,
              archivedAt: null,
            },
          ]),
        } as unknown as AgentStorage,
        getAgentManager: () =>
          ({
            listAgents: vi.fn(() => []),
            setAgentName,
          }) as unknown as Pick<AgentManager, "listAgents" | "setAgentName">,
        readTheme: () => store.get().namingTheme,
        logger: createTestLogger(),
      });
      // Constructed under the default ("mixed"), then the theme switches —
      // exactly the production sequence: patch lands, nobody is re-mapped.
      expect(store.get().namingTheme).toBe("mixed");
      await store.patch({ namingTheme: "indian" });
      // A NEW assignment reads the NEW theme…
      const name = await service.assignNameForCreatedAgent({
        agentId: "new",
        labels: {},
        internal: false,
      });
      expect(NAME_POOLS.indian).toContain(name);
      // …while existing names are untouched: setAgentName was never called.
      expect(setAgentName).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MissionControlService namingTheme patch", () => {
  let dir: string;
  let service: MissionControlService;

  async function createService(): Promise<void> {
    service = new MissionControlService({
      paseoHome: dir,
      logger: createTestLogger(),
      agentManager: {
        getAgent: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
    });
    await service.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-naming-service-"));
    await createService();
  });

  afterEach(async () => {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a namingTheme patch renames nobody and persists the new theme", async () => {
    const config = await service.patchCentralConfig({ namingTheme: "indian" });
    expect(config.namingTheme).toBe("indian");
  });

  test("patching the same theme is idempotent", async () => {
    await service.patchCentralConfig({ namingTheme: "indian" });
    await service.patchCentralConfig({ namingTheme: "indian" });
    expect(service.getCentralConfig().namingTheme).toBe("indian");
  });
});

describe("MissionControlService shares the injected central store", () => {
  let dir: string;
  let store: CentralMissionControlConfigStore;
  let service: MissionControlService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-naming-shared-"));
    store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    service = new MissionControlService({
      paseoHome: dir,
      logger: createTestLogger(),
      agentManager: {
        getAgent: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      centralConfig: store,
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a patch through the service is visible on the injected store (single instance)", async () => {
    await service.patchCentralConfig({ namingTheme: "indian" });
    expect(store.get().namingTheme).toBe("indian");
  });

  test("a patch through the injected store is visible on the service (single instance)", async () => {
    await store.patch({ namingTheme: "nature" });
    expect(service.getCentralConfig().namingTheme).toBe("nature");
  });
});
