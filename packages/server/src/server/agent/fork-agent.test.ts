import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgentToSibling } from "./fork-agent.js";
import { wrapSessionProvider } from "./provider-registry.js";
import type { AgentPersistenceHandle, AgentSession } from "./agent-sdk-types.js";

const FORKED_HANDLE: AgentPersistenceHandle = {
  provider: "omp",
  sessionId: "forked-session",
  nativeHandle: "/tmp/forked.jsonl",
};

/**
 * A source session as the manager actually holds it: behind
 * `wrapSessionProvider`. Testing the bare provider session hid the regression
 * where the wrapper dropped `forkSessionForNewAgent` and every fork silently
 * became a snapshot.
 */
function createWrappedSourceSession(options: { supportsNativeFork: boolean }): AgentSession {
  const inner = {
    provider: "omp",
    id: "session-1",
    capabilities: {
      supportsStreaming: true,
      supportsPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
    },
    run: vi.fn(),
    startTurn: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    streamHistory: async function* () {},
    getRuntimeInfo: vi.fn(),
    getAvailableModes: async () => [],
    getCurrentMode: async () => null,
    setMode: async () => {},
    getPendingPermissions: () => [],
    respondToPermission: async () => {},
    describePersistence: () => null,
    interrupt: async () => {},
    close: async () => {},
    ...(options.supportsNativeFork
      ? { forkSessionForNewAgent: async (): Promise<AgentPersistenceHandle> => FORKED_HANDLE }
      : {}),
  } as unknown as AgentSession;
  return wrapSessionProvider("omp", inner);
}

function createForkScenario(options: { supportsNativeFork: boolean }) {
  const source: ManagedAgent = Object.create(null);
  Reflect.set(source, "id", "source-agent");
  Reflect.set(source, "provider", "omp");
  Reflect.set(source, "lifecycle", "running");
  Reflect.set(source, "cwd", "/tmp/project");
  Reflect.set(source, "workspaceId", "wks_1");
  Reflect.set(source, "config", { provider: "omp", cwd: "/tmp/project", title: "Source" });
  Reflect.set(source, "session", createWrappedSourceSession(options));

  const forked: ManagedAgent = Object.create(null);
  Reflect.set(forked, "id", "forked-agent");
  Reflect.set(forked, "provider", "omp");
  Reflect.set(forked, "lifecycle", "idle");

  const resumeAgentFromPersistence = vi.fn(async () => forked);
  const hydrateTimelineFromProvider = vi.fn(async () => {});
  const createAgent = vi.fn(async () => forked);
  const streamAgent = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => (agentId === "source-agent" ? source : forked)),
  );
  Reflect.set(agentManager, "resumeAgentFromPersistence", resumeAgentFromPersistence);
  Reflect.set(agentManager, "hydrateTimelineFromProvider", hydrateTimelineFromProvider);
  Reflect.set(agentManager, "createAgent", createAgent);
  Reflect.set(
    agentManager,
    "fetchTimeline",
    vi.fn(() => ({ rows: [], epoch: "epoch-1" })),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgent);
  Reflect.set(
    agentManager,
    "reloadAgentSession",
    vi.fn(async () => forked),
  );

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  return {
    fork: () =>
      forkAgentToSibling({
        agentManager,
        agentStorage,
        sourceAgentId: "source-agent",
        text: "continue from here",
        logger: createTestLogger(),
      }),
    resumeAgentFromPersistence,
    hydrateTimelineFromProvider,
    createAgent,
  };
}

test("forks natively when the provider can copy its own session", async () => {
  const scenario = createForkScenario({ supportsNativeFork: true });

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "native",
  });
  // The fork resumes the copied provider session, and its timeline is primed
  // from that copy — without this the new tab opens with nothing above the
  // user's first message.
  expect(scenario.resumeAgentFromPersistence).toHaveBeenCalledWith(
    FORKED_HANDLE,
    expect.anything(),
    undefined,
    { workspaceId: "wks_1" },
  );
  expect(scenario.hydrateTimelineFromProvider).toHaveBeenCalledWith("forked-agent");
  expect(scenario.createAgent).not.toHaveBeenCalled();
});

test("falls back to a snapshot fork when the provider has no session-fork primitive", async () => {
  const scenario = createForkScenario({ supportsNativeFork: false });

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "snapshot",
  });
  expect(scenario.createAgent).toHaveBeenCalled();
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});
