import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgentToSibling } from "./fork-agent.js";
import { wrapSessionProvider } from "./provider-registry.js";
import type {
  AgentPersistenceHandle,
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

/** A real OMP session JSONL on disk (large enough to not read as a stub). */
function createSessionFile(fileName: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fork-agent-omp-"));
  const file = path.join(dir, fileName);
  const sessionLine = JSON.stringify({
    type: "session",
    id: "omp-session-1",
    cwd: "/tmp/project",
    timestamp: "2026-08-12T00:00:00.000Z",
  });
  writeFileSync(file, sessionLine + "\n" + "x".repeat(3000) + "\n");
  return file;
}

function createForkScenario(options?: {
  provider?: string;
  persistence?: AgentPersistenceHandle | null;
  currentModeId?: string | null;
}) {
  const provider = options?.provider ?? "omp";
  const source: ManagedAgent = Object.create(null);
  Reflect.set(source, "id", "source-agent");
  Reflect.set(source, "provider", provider);
  Reflect.set(source, "lifecycle", "running");
  Reflect.set(source, "cwd", "/tmp/project");
  Reflect.set(source, "workspaceId", "wks_1");
  Reflect.set(source, "labels", { surface: "workspace" });
  Reflect.set(source, "currentModeId", options?.currentModeId ?? "omp-build");
  Reflect.set(source, "config", {
    provider,
    cwd: "/tmp/project",
    title: "Source",
    systemPrompt: "be terse",
    modeId: "omp-build",
    model: "omp/default",
    thinkingOptionId: "omp-high",
    providerOptions: { approval_policy: "never", fallbackModel: "sonnet" },
  });
  Reflect.set(source, "session", createWrappedSourceSession());
  Reflect.set(source, "persistence", options?.persistence ?? null);

  const forked: ManagedAgent = Object.create(null);
  Reflect.set(forked, "id", "forked-agent");
  Reflect.set(forked, "provider", provider);
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
    fork: (overrides?: Partial<AgentSessionConfig>, labels?: Record<string, string>) =>
      forkAgentToSibling({
        agentManager,
        agentStorage,
        sourceAgentId: "source-agent",
        text: "continue from here",
        ...(overrides ? { overrides } : {}),
        ...(labels ? { labels } : {}),
        logger: createTestLogger(),
      }),
    firstTurnPrompt: (): AgentPromptInput => streamAgent.mock.calls[0]?.[1] as AgentPromptInput,
    resumeAgentFromPersistence,
    createAgent,
  };
}

test("forks into a brand-new agent in the source's workspace via snapshot without persistence", async () => {
  const scenario = createForkScenario();

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "snapshot",
  });
  expect(scenario.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "omp", cwd: "/tmp/project", internal: false }),
    undefined,
    expect.objectContaining({ workspaceId: "wks_1" }),
  );
  // Without a durable provider session file, the history travels as an
  // attachment: nothing depends on a provider fork primitive.
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});

test("carries the source's chat history on the fork's first turn via snapshot", async () => {
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
    providerOptions: { approval_policy: "never", fallbackModel: "sonnet" },
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
  // OMP's model/mode/thinking and providerOptions would be nonsense here.
  expect(config.thinkingOptionId).toBeUndefined();
  expect(config.providerOptions).toBeUndefined();
});

test("forks an OMP source with a session file by cloning and resuming natively", async () => {
  const sessionFile = createSessionFile(
    "2026-08-12T00-00-00-000Z_019f0000-0000-7000-8000-000000000001.jsonl",
  );
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: sessionFile },
  });

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "native",
  });

  // The fork resumes from a COPY of the source's session file...
  expect(scenario.resumeAgentFromPersistence).toHaveBeenCalledTimes(1);
  const [handle, overrides, agentId, options] = scenario.resumeAgentFromPersistence.mock
    .calls[0] as unknown as [
    AgentPersistenceHandle,
    Partial<AgentSessionConfig>,
    string | undefined,
    { workspaceId?: string; initialTitle?: string | null; labels?: Record<string, string> },
  ];
  expect(handle.provider).toBe("omp");
  expect(handle.sessionId).toBe("omp-session-1");
  expect(handle.nativeHandle).not.toBe(sessionFile);
  expect(handle.nativeHandle).toMatch(/\.jsonl$/);
  expect(handle.nativeHandle).toBeDefined();
  // ...and the copy is a real, identical session file that owns the fork's history.
  expect(existsSync(handle.nativeHandle as string)).toBe(true);
  expect(readFileSync(handle.nativeHandle as string)).toEqual(readFileSync(sessionFile));
  expect(handle.metadata).toMatchObject({
    cwd: "/tmp/project",
    model: "omp/default",
    modeId: "omp-build",
    thinkingOptionId: "omp-high",
    systemPrompt: "be terse",
  });
  expect(overrides).toMatchObject({
    provider: "omp",
    cwd: "/tmp/project",
    model: "omp/default",
    thinkingOptionId: "omp-high",
    modeId: "omp-build",
    internal: false,
    title: "continue from here",
  });
  expect(agentId).toBeUndefined();
  expect(options).toMatchObject({
    workspaceId: "wks_1",
    initialTitle: "continue from here",
  });
  expect(options.labels).toBeUndefined();

  // The native path never creates a fresh session and the first turn is only
  // the caller's text — no chat-history attachment.
  expect(scenario.createAgent).not.toHaveBeenCalled();
  const prompt = scenario.firstTurnPrompt();
  expect(prompt).toBe("continue from here");
});

test("native fork carries user overrides and current mode over config mode", async () => {
  const sessionFile = createSessionFile("native-override-session.jsonl");
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: sessionFile },
    currentModeId: "omp-code",
  });

  await scenario.fork({ provider: "omp", model: "omp/other", thinkingOptionId: "omp-low" });

  const [handle, overrides] = scenario.resumeAgentFromPersistence.mock.calls[0] as unknown as [
    AgentPersistenceHandle,
    Partial<AgentSessionConfig>,
  ];
  expect(overrides).toMatchObject({
    model: "omp/other",
    thinkingOptionId: "omp-low",
    modeId: "omp-code",
  });
  expect(handle.metadata).toMatchObject({ model: "omp/other", modeId: "omp-code" });
});

test("uses an explicit title override instead of deriving one from the prompt", async () => {
  const scenario = createForkScenario();

  await scenario.fork({ title: "Ask: what does this variable do?" });

  const config = scenario.createAgent.mock.calls[0]?.[0] as AgentSessionConfig;
  expect(config.title).toBe("Ask: what does this variable do?");
  const options = scenario.createAgent.mock.calls[0]?.[2];
  expect(options?.initialTitle).toBe("Ask: what does this variable do?");
});

test("native fork honors an explicit title override", async () => {
  const sessionFile = createSessionFile("native-title-session.jsonl");
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: sessionFile },
  });

  await scenario.fork({ title: "Ask: why is this here?" });

  const [handle, overrides, , options] = scenario.resumeAgentFromPersistence.mock
    .calls[0] as unknown as [
    AgentPersistenceHandle,
    Partial<AgentSessionConfig>,
    string | undefined,
    { workspaceId?: string; initialTitle?: string | null },
  ];
  expect(overrides.title).toBe("Ask: why is this here?");
  expect(options.initialTitle).toBe("Ask: why is this here?");
  // The fork's handle metadata stays provider-config only; the title travels
  // as the resumed agent's initialTitle.
  expect(handle.metadata?.title).toBeUndefined();
});

test("falls back to snapshot when an OMP source's session file is missing", async () => {
  const missingFile = path.join(tmpdir(), "fork-agent-omp-missing", "gone.jsonl");
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: missingFile },
  });

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "snapshot",
  });
  expect(scenario.createAgent).toHaveBeenCalledTimes(1);
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});

test("falls back to snapshot when the fork switches away from OMP", async () => {
  const sessionFile = createSessionFile("native-switch-away-session.jsonl");
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: sessionFile },
  });

  await scenario.fork({ provider: "claude", model: "opus" });

  expect(scenario.createAgent).toHaveBeenCalledTimes(1);
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});

test("falls back to snapshot for a non-OMP source even with a persistence handle", async () => {
  const scenario = createForkScenario({
    provider: "claude",
    persistence: {
      provider: "claude",
      sessionId: "claude-session-1",
      nativeHandle: "/tmp/some-thread.jsonl",
    },
  });

  await expect(scenario.fork()).resolves.toEqual({
    agentId: "forked-agent",
    strategy: "snapshot",
  });
  expect(scenario.createAgent).toHaveBeenCalledTimes(1);
  expect(scenario.resumeAgentFromPersistence).not.toHaveBeenCalled();
});

test("native fork passes custom labels when provided without inheriting source labels", async () => {
  const sessionFile = createSessionFile("native-labels-session.jsonl");
  const scenario = createForkScenario({
    persistence: { provider: "omp", sessionId: "omp-session-1", nativeHandle: sessionFile },
  });

  await scenario.fork(undefined, {
    "paseo.selection-ask": "1",
    "paseo.parent-agent-id": "source-agent",
  });

  const options = scenario.resumeAgentFromPersistence.mock.calls[0]?.[3];
  expect(options?.labels).toEqual({
    "paseo.selection-ask": "1",
    "paseo.parent-agent-id": "source-agent",
  });
});

test("snapshot fork passes custom labels when provided", async () => {
  const scenario = createForkScenario();

  await scenario.fork(undefined, { "paseo.selection-ask": "1" });

  const options = scenario.createAgent.mock.calls[0]?.[2];
  expect(options?.labels).toEqual({ "paseo.selection-ask": "1" });
});
