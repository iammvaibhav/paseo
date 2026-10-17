import { vi } from "vitest";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
  Object.assign(global, { __DEV__: false });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { selectSelectionAsks } from "./asks-list";
import { selectSubagentsForParent } from "@/subagents/select";

const SERVER_ID = "server-asks-test";
const SOURCE_AGENT_ID = "agent-parent";

function createMockAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    serverId: SERVER_ID,
    name: overrides.name ?? `Agent ${overrides.id}`,
    title: overrides.title ?? null,
    provider: "claude",
    status: "idle",
    activeTurn: null,
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    lastUserMessageAt: null,
    lastActivityAt: new Date(1000),
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    cwd: "/repo",
    model: null,
    parentAgentId: SOURCE_AGENT_ID,
    labels: { "paseo.selection-ask": "1" },
    archivedAt: null,
    ...overrides,
  } as Agent;
}

describe("selectSelectionAsks", () => {
  beforeEach(() => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("returns empty array when no agents exist in session", () => {
    const state = useSessionStore.getState();
    expect(selectSelectionAsks(state, SERVER_ID, SOURCE_AGENT_ID)).toEqual([]);
  });

  it("selects only unarchived selection asks for the parent agent", () => {
    const ask1 = createMockAgent({
      id: "ask-1",
      title: "Ask 1",
      createdAt: new Date(2000),
    });
    const ask2 = createMockAgent({
      id: "ask-2",
      title: "Ask 2",
      createdAt: new Date(3000),
    });
    const regularSubagent = createMockAgent({
      id: "sub-1",
      labels: {},
    });
    const otherParentAsk = createMockAgent({
      id: "ask-other",
      parentAgentId: "other-parent",
    });
    const archivedAsk = createMockAgent({
      id: "ask-archived",
      archivedAt: new Date(4000),
    });

    useSessionStore.getState().setAgents(SERVER_ID, () => {
      const map = new Map<string, Agent>();
      map.set(ask1.id, ask1);
      map.set(ask2.id, ask2);
      map.set(regularSubagent.id, regularSubagent);
      map.set(otherParentAsk.id, otherParentAsk);
      map.set(archivedAsk.id, archivedAsk);
      return map;
    });

    const state = useSessionStore.getState();
    const result = selectSelectionAsks(state, SERVER_ID, SOURCE_AGENT_ID);

    expect(result.map((a) => a.id)).toEqual(["ask-2", "ask-1"]);
  });
});

describe("selectSubagentsForParent exclusion", () => {
  it("excludes selection asks from the generic subagents track", () => {
    const ask1 = createMockAgent({
      id: "ask-1",
      title: "Ask 1",
    });
    const sub1 = createMockAgent({
      id: "sub-1",
      title: "Sub 1",
      labels: {},
    });
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().setAgents(SERVER_ID, () => {
      return new Map([
        [ask1.id, ask1],
        [sub1.id, sub1],
      ]);
    });
    const state = useSessionStore.getState();
    const rows = selectSubagentsForParent(
      state,
      { serverId: SERVER_ID, parentAgentId: SOURCE_AGENT_ID },
      new Set(),
    );

    expect(rows.map((r) => r.id)).toEqual(["sub-1"]);
  });
});
