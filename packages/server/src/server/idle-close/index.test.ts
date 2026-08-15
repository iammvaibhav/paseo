import { describe, expect, test, vi } from "vitest";

import {
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
} from "../mission-control/commander-contract.js";
import { IdleCloseOmpService } from "./index.js";

interface IdleCloseTestAgent {
  id: string;
  provider: string;
  lifecycle: string;
  updatedAt: Date;
  labels: Record<string, string>;
  pendingPermissions: Map<string, unknown>;
}

function createAgent(overrides: Partial<IdleCloseTestAgent> & { id: string }): IdleCloseTestAgent {
  return {
    provider: "omp",
    lifecycle: "idle",
    updatedAt: new Date(Date.now() - 3_600_000),
    labels: {},
    pendingPermissions: new Map(),
    ...overrides,
  };
}

function createCloser(options: {
  agents: IdleCloseTestAgent[];
  thresholdSeconds: number;
  runningSubagents?: Array<{ parentAgentId: string; status: string }>;
}) {
  const closed: string[] = [];
  const service = new IdleCloseOmpService({
    agentManager: {
      listAgents: () => options.agents,
      listProviderSubagentActivity: () => options.runningSubagents ?? [],
      closeAgent: async (agentId: string) => {
        closed.push(agentId);
      },
    } as never,
    daemonConfigStore: {
      get: () => ({ ompIdleCloseAfterSeconds: options.thresholdSeconds }),
    } as never,
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } as never,
  });
  return { service, closed };
}

describe("IdleCloseOmpService", () => {
  test("closes an idle OMP agent past the threshold", async () => {
    const { service, closed } = createCloser({
      agents: [createAgent({ id: "idle-old" })],
      thresholdSeconds: 1800,
    });

    await service.sweep();

    expect(closed).toEqual(["idle-old"]);
  });

  test("skips running agents, the Commander, and a disabled knob", async () => {
    const running = createCloser({
      agents: [createAgent({ id: "running", lifecycle: "running" })],
      thresholdSeconds: 1800,
    });
    const commander = createCloser({
      agents: [
        createAgent({
          id: "commander",
          labels: { [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE },
        }),
      ],
      thresholdSeconds: 1800,
    });
    const disabled = createCloser({
      agents: [createAgent({ id: "idle-old" })],
      thresholdSeconds: 0,
    });

    await running.service.sweep();
    await commander.service.sweep();
    await disabled.service.sweep();

    expect(running.closed).toEqual([]);
    expect(commander.closed).toEqual([]);
    expect(disabled.closed).toEqual([]);
  });
});
