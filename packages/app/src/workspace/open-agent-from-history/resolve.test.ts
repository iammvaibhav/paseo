import { describe, expect, it, vi } from "vitest";
import {
  resolveOpenAgentFromHistory,
  type OpenAgentFromHistoryDeps,
} from "@/workspace/open-agent-from-history/resolve";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

function createRecordingDeps(overrides?: Partial<OpenAgentFromHistoryDeps>): {
  deps: OpenAgentFromHistoryDeps;
  hydrations: { serverId: string; agentId: string }[];
  unarchives: { serverId: string; agentId: string }[];
  navigations: Parameters<OpenAgentFromHistoryDeps["navigateToAgent"]>[0][];
} {
  const hydrations: { serverId: string; agentId: string }[] = [];
  const unarchives: { serverId: string; agentId: string }[] = [];
  const navigations: Parameters<OpenAgentFromHistoryDeps["navigateToAgent"]>[0][] = [];
  return {
    hydrations,
    unarchives,
    navigations,
    deps: {
      hydrateArchivedAgent: async (input) => {
        hydrations.push(input);
      },
      unarchiveAgent: async (input) => {
        unarchives.push(input);
      },
      navigateToAgent: (input) => {
        navigations.push(input);
      },
      ...overrides,
    },
  };
}

describe("resolveOpenAgentFromHistory", () => {
  it("navigates active agents straight to their workspace tab without hydrating or pinning", async () => {
    const { deps, hydrations, unarchives, navigations } = createRecordingDeps();

    await resolveOpenAgentFromHistory(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, archived: false },
      deps,
    );

    expect(hydrations).toEqual([]);
    expect(unarchives).toEqual([]);
    expect(navigations).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
    ]);
  });

  it("hydrates then unarchives an archived agent before pinning its tab", async () => {
    const order: string[] = [];
    const { deps, hydrations, unarchives, navigations } = createRecordingDeps({
      hydrateArchivedAgent: async (input) => {
        order.push("hydrate");
        hydrations.push(input);
      },
      unarchiveAgent: async (input) => {
        order.push("unarchive");
        unarchives.push(input);
      },
      navigateToAgent: (input) => {
        order.push("navigate");
        navigations.push(input);
      },
    });

    await resolveOpenAgentFromHistory(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, archived: true },
      deps,
    );

    expect(order).toEqual(["hydrate", "unarchive", "navigate"]);
    expect(hydrations).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(unarchives).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(navigations).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, pin: true },
    ]);
  });

  it("waits for hydration and unarchive to finish before navigating", async () => {
    const deferred: { resolveHydrate: () => void; resolveUnarchive: () => void } = {
      resolveHydrate: () => {},
      resolveUnarchive: () => {},
    };
    const hydrateStarted = vi.fn();
    const unarchiveStarted = vi.fn();
    const { deps, navigations } = createRecordingDeps({
      hydrateArchivedAgent: () => {
        hydrateStarted();
        return new Promise<void>((resolve) => {
          deferred.resolveHydrate = resolve;
        });
      },
      unarchiveAgent: () => {
        unarchiveStarted();
        return new Promise<void>((resolve) => {
          deferred.resolveUnarchive = resolve;
        });
      },
    });

    const pending = resolveOpenAgentFromHistory(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, archived: true },
      deps,
    );

    expect(hydrateStarted).toHaveBeenCalledTimes(1);
    expect(unarchiveStarted).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);

    deferred.resolveHydrate();
    await Promise.resolve();
    expect(unarchiveStarted).toHaveBeenCalledTimes(1);
    expect(navigations).toEqual([]);

    deferred.resolveUnarchive();
    await pending;

    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.pin).toBe(true);
  });
});
