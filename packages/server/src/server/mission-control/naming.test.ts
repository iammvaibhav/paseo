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
import { AgentNamingService, isAutoAssignedName } from "./naming.js";
import { CentralMissionControlConfigStore } from "./config.js";

/**
 * Fakes for the naming service. setAgentName is the broadcast seam: the real
 * AgentManager's setAgentName → emitState → agent_state → agent_update
 * pipeline (covered by session tests) is what pushes renames to clients, so
 * asserting the call here proves the broadcast path fires per renamed agent.
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

describe("isAutoAssignedName", () => {
  test("pool names across themes are auto-assigned", () => {
    expect(isAutoAssignedName("Ripley")).toBe(true); // mixed
    expect(isAutoAssignedName("Arjun")).toBe(true); // indian
    expect(isAutoAssignedName("Mickey")).toBe(true); // cartoon
    expect(isAutoAssignedName("Einstein")).toBe(true); // scientists
    expect(isAutoAssignedName("Armstrong")).toBe(true); // astronauts
    expect(isAutoAssignedName("Zeus")).toBe(true); // mythology
    expect(isAutoAssignedName("Willow")).toBe(true); // nature + mixed
  });

  test("Roman-numeral suffix names are auto-assigned", () => {
    expect(isAutoAssignedName("Ripley II")).toBe(true);
    expect(isAutoAssignedName("Ripley X")).toBe(true);
  });

  test("non-pool names are user-set", () => {
    expect(isAutoAssignedName("Payments worker")).toBe(false);
    expect(isAutoAssignedName("fix-auth-slug")).toBe(false);
    expect(isAutoAssignedName("vaibhav")).toBe(false);
    expect(isAutoAssignedName("")).toBe(false);
    expect(isAutoAssignedName("   ")).toBe(false);
  });
});

describe("AgentNamingService.remapAllNames", () => {
  test("renames every auto-assigned agent to the new theme pool and returns the count", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "indian",
      liveAgents: [
        { id: "a", name: "Pixel" },
        { id: "c", name: "Ripley" },
      ],
      storedRecords: [{ id: "b", name: "Noodle" }],
    });
    const count = await service.remapAllNames();
    expect(count).toBe(3);
    // Deterministic: agents sorted by id, pool order → Pixel/Arjun, Noodle/Meera, Ripley/Kiran.
    expect(setAgentName).toHaveBeenCalledTimes(3);
    expect(setAgentName).toHaveBeenCalledWith("a", "Arjun");
    expect(setAgentName).toHaveBeenCalledWith("b", "Meera");
    expect(setAgentName).toHaveBeenCalledWith("c", "Kiran");
  });

  test("user-set, internal, mission-control-labeled, and archived agents are untouched", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "indian",
      liveAgents: [
        { id: "user", name: "Payments worker" },
        { id: "mc", name: "Ripley", labels: { "paseo.mission-control": "commander" } },
      ],
      storedRecords: [
        { id: "internal", name: "Pixel", internal: true },
        { id: "archived", name: "Miso", archivedAt: "2026-01-01T00:00:00.000Z" },
        { id: "auto", name: "Bolt" },
      ],
    });
    const count = await service.remapAllNames();
    expect(count).toBe(1);
    expect(setAgentName).toHaveBeenCalledTimes(1);
    expect(setAgentName).toHaveBeenCalledWith("auto", "Arjun");
  });

  test("a name already in the target pool is kept (no churn)", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "nature",
      liveAgents: [
        { id: "a", name: "Iris" }, // in nature pool already
        { id: "b", name: "Ripley" },
      ],
    });
    const count = await service.remapAllNames();
    expect(count).toBe(1);
    expect(setAgentName).toHaveBeenCalledTimes(1);
    expect(setAgentName).toHaveBeenCalledWith("b", "Willow");
  });

  test("re-map is deterministic: same inputs produce the same names", async () => {
    const options = {
      theme: "astronauts",
      liveAgents: [
        { id: "z", name: "Miso" },
        { id: "y", name: "Tango" },
        { id: "x", name: "Zippy" },
      ],
    };
    const first = createNamingHarness(options);
    const second = createNamingHarness(options);
    await first.service.remapAllNames();
    await second.service.remapAllNames();
    const calls = (h: { setAgentName: ReturnType<typeof vi.fn> }) =>
      h.setAgentName.mock.calls.map((call) => call.slice()).sort();
    expect(calls(second)).toEqual(calls(first));
  });

  test("no auto-assigned agents → zero renames, no manager calls", async () => {
    const { service, setAgentName } = createNamingHarness({
      theme: "indian",
      liveAgents: [{ id: "a", name: "My custom agent" }],
    });
    expect(await service.remapAllNames()).toBe(0);
    expect(setAgentName).not.toHaveBeenCalled();
  });
});

describe("AgentNamingService reads the theme from the central store", () => {
  test("a theme patched after construction is used by the next re-map (fresh read)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-naming-central-"));
    try {
      const store = new CentralMissionControlConfigStore({
        paseoHome: dir,
        logger: createTestLogger(),
      });
      await store.initialize();
      const setAgentName = vi.fn(async () => undefined);
      // Bootstrap wiring: readTheme closes over the SHARED central store, so
      // the re-map must see the theme as of call time, not boot time.
      const service = new AgentNamingService({
        agentStorage: { list: vi.fn(async () => []) } as unknown as AgentStorage,
        getAgentManager: () =>
          ({
            listAgents: vi.fn(() => [{ id: "a", name: "Ripley", labels: {} }]),
            setAgentName,
          }) as unknown as Pick<AgentManager, "listAgents" | "setAgentName">,
        readTheme: () => store.get().namingTheme,
        logger: createTestLogger(),
      });
      // Constructed under the default ("mixed"), then the theme switches —
      // exactly the bug-1 sequence (patch lands, re-map follows).
      expect(store.get().namingTheme).toBe("mixed");
      await store.patch({ namingTheme: "indian" });
      const count = await service.remapAllNames();
      expect(count).toBe(1);
      // First indian-pool entry — proves the re-map used the NEW theme.
      expect(setAgentName).toHaveBeenCalledWith("a", "Arjun");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MissionControlService theme patch triggers the re-map", () => {
  let dir: string;
  let service: MissionControlService;
  let remapAllNames: ReturnType<typeof vi.fn>;

  async function createService(): Promise<void> {
    remapAllNames = vi.fn(async () => 0);
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
      naming: { remapAllNames } as unknown as AgentNamingService,
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

  test("a namingTheme patch re-maps immediately", async () => {
    const config = await service.patchCentralConfig({ namingTheme: "indian" });
    expect(config.namingTheme).toBe("indian");
    expect(remapAllNames).toHaveBeenCalledTimes(1);
  });

  test("a patch without namingTheme does not re-map", async () => {
    await service.patchCentralConfig({ mode: "auto" });
    expect(remapAllNames).not.toHaveBeenCalled();
  });

  test("patching the same theme does not re-map again", async () => {
    await service.patchCentralConfig({ namingTheme: "indian" });
    await service.patchCentralConfig({ namingTheme: "indian" });
    expect(remapAllNames).toHaveBeenCalledTimes(1);
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
