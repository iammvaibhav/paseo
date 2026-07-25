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
  navigations: Parameters<OpenAgentFromHistoryDeps["navigateToAgent"]>[0][];
} {
  const hydrations: { serverId: string; agentId: string }[] = [];
  const navigations: Parameters<OpenAgentFromHistoryDeps["navigateToAgent"]>[0][] = [];
  return {
    hydrations,
    navigations,
    deps: {
      hydrateArchivedAgent: async (input) => {
        hydrations.push(input);
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
    const { deps, hydrations, navigations } = createRecordingDeps();

    await resolveOpenAgentFromHistory(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, archived: false },
      deps,
    );

    expect(hydrations).toEqual([]);
    expect(navigations).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
    ]);
  });

  it("hydrates an archived agent before pinning its tab", async () => {
    const order: string[] = [];
    const { deps, hydrations, navigations } = createRecordingDeps({
      hydrateArchivedAgent: async (input) => {
        order.push("hydrate");
        hydrations.push(input);
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

    expect(order).toEqual(["hydrate", "navigate"]);
    expect(hydrations).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(navigations).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, pin: true },
    ]);
  });

  it("waits for hydration to finish before navigating", async () => {
    const deferred: { resolve: () => void } = { resolve: () => {} };
    const hydrateStarted = vi.fn();
    const { deps, navigations } = createRecordingDeps({
      hydrateArchivedAgent: () => {
        hydrateStarted();
        return new Promise<void>((resolve) => {
          deferred.resolve = resolve;
        });
      },
    });

    const pending = resolveOpenAgentFromHistory(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID, archived: true },
      deps,
    );

    expect(hydrateStarted).toHaveBeenCalledTimes(1);
    expect(navigations).toEqual([]);

    deferred.resolve();
    await pending;

    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.pin).toBe(true);
  });
});
