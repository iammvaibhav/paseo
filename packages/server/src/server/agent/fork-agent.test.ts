import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgentToSibling } from "./fork-agent.js";
import { wrapSessionProvider } from "./provider-registry.js";
import type {
  AgentPromptInput,
  AgentSession,
  AgentSessionConfig,
  AgentTimelineItem,
} from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/** A source session as the manager actually holds it: behind `wrapSessionProvider`. */
function createWrappedSourceSession(): AgentSession {
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
  } as unknown as AgentSession;
  return wrapSessionProvider("omp", inner);
}

function timelineRow(seq: number, item: AgentTimelineItem): AgentTimelineRow {
  return { seq, timestamp: `2026-07-30T10:20:3${seq}.400Z`, item };
}

function createForkScenario() {
  const source: ManagedAgent = Object.create(null);
  Reflect.set(source, "id", "source-agent");
  Reflect.set(source, "provider", "omp");
  Reflect.set(source, "lifecycle", "running");
  Reflect.set(source, "cwd", "/tmp/project");
  Reflect.set(source, "workspaceId", "wks_1");
  Reflect.set(source, "config", {
    provider: "omp",
    cwd: "/tmp/project",
    title: "Source",
    systemPrompt: "be terse",
    modeId: "omp-build",
    model: "omp/default",
    thinkingOptionId: "omp-high",
    approvalPolicy: "never",
    extra: { claude: { fallbackModel: "sonnet" } },
  });
  Reflect.set(source, "session", createWrappedSourceSession());

  const forked: ManagedAgent = Object.create(null);
  Reflect.set(forked, "id", "forked-agent");
  Reflect.set(forked, "provider", "omp");
  Reflect.set(forked, "lifecycle", "idle");

  const resumeAgentFromPersistence = vi.fn(async () => forked);
  const createAgent = vi.fn(async () => forked);
  const streamAgent = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => (agentId === "source-agent" ? source : forked)),
  );
  Reflect.set(agentManager, "resumeAgentFromPersistence", resumeAgentFromPersistence);
  Reflect.set(agentManager, "createAgent", createAgent);
  Reflect.set(
    agentManager,
    "fetchTimeline",
    vi.fn(() => ({
      epoch: "epoch-1",
      rows: [
        timelineRow(1, { type: "user_message", text: "first prompt" }),
        timelineRow(2, {
          type: "assistant_message",
          messageId: "assistant-1",
          text: "first answer",
        }),
      ],
    })),
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
    fork: (overrides?: Partial<AgentSessionConfig>) =>
      forkAgentToSibling({
        agentManager,
        agentStorage,
        sourceAgentId: "source-agent",
        text: "continue from here",
        ...(overrides ? { overrides } : {}),
        logger: createTestLogger(),
      }),
    firstTurnPrompt: (): AgentPromptInput => streamAgent.mock.calls[0]?.[1] as AgentPromptInput,
    resumeAgentFromPersistence,
    createAgent,
  };
}

test("forks into a brand-new agent in the source's workspace", async () => {
  const scenario = createForkScenario();

  await expect(scenario.fork()).resolves.toEqual({ agentId: "forked-agent" });
  expect(scenario.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "omp", cwd: "/tmp/project", internal: false }),
    undefined,
    expect.objectContaining({ workspaceId: "wks_1" }),
  );
  // A fork never resumes or branches the provider-side session: the history
  // travels as an attachment, so nothing depends on a provider fork primitive.
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});

test("carries the source's chat history on the fork's first turn", async () => {
  const scenario = createForkScenario();

  await scenario.fork();

  const prompt = scenario.firstTurnPrompt();
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as Exclude<AgentPromptInput, string>;
  expect(blocks.some((block) => block.type === "text" && block.text === "continue from here")).toBe(
    true,
  );
  const history = blocks.find(
    (block) => block.type === "text" && block.text.includes("first answer"),
  );
  expect(history).toBeDefined();
});

test("keeps the source's config when the fork stays on the same provider", async () => {
  const scenario = createForkScenario();

  await scenario.fork({ provider: "omp", model: "omp/other" });

  expect(scenario.createAgent.mock.calls[0]?.[0]).toMatchObject({
    provider: "omp",
    model: "omp/other",
    modeId: "omp-build",
    thinkingOptionId: "omp-high",
    approvalPolicy: "never",
    extra: { claude: { fallbackModel: "sonnet" } },
  });
});

test("drops provider-specific config when the fork switches provider", async () => {
  const scenario = createForkScenario();

  await scenario.fork({ provider: "claude", model: "opus", modeId: "plan" });

  const config = scenario.createAgent.mock.calls[0]?.[0] as AgentSessionConfig;
  expect(config).toMatchObject({
    provider: "claude",
    model: "opus",
    modeId: "plan",
    // The fork still runs where the source ran.
    cwd: "/tmp/project",
    // Provider-agnostic config survives the switch.
    systemPrompt: "be terse",
  });
  // OMP's model/mode/thinking and Claude-shaped `extra` would be nonsense here.
  expect(config.thinkingOptionId).toBeUndefined();
  expect(config.approvalPolicy).toBeUndefined();
  expect(config.extra).toBeUndefined();
});
