import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { OrchestratorPlanSchema } from "@getpaseo/protocol/messages";
import type { OrchestratorPlan } from "@getpaseo/protocol/agent-types";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { AgentMetadata } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { validatePlanDag, OrchestratorDagError } from "./dag.js";
import { applyTaskUpdate, OrchestratorTransitionError } from "./transitions.js";
import { buildOrchestratorSystemPrompt } from "./prompt.js";
import { AgentManagerOrchestratorDispatcher } from "./dispatcher.js";

function planInput() {
  return {
    title: "Ship it",
    tasks: [
      { id: "a", title: "Write code", brief: "write it", files: ["f.ts"] },
      { id: "b", title: "Test", brief: "test it", dependsOn: ["a"] },
    ],
  };
}

describe("validatePlanDag", () => {
  test("accepts a diamond DAG with defaults", () => {
    const out = validatePlanDag({
      title: "  Ship it ",
      tasks: [
        { id: "a", title: "a" },
        { id: "b", title: "b", dependsOn: ["a"] },
        { id: "c", title: "c", dependsOn: ["a"] },
        { id: "d", title: "d", dependsOn: ["b", "c"] },
      ],
    });
    expect(out.title).toBe("Ship it");
    expect(out.maxParallel).toBe(4);
    expect(out.tasks.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.tasks[0]).toMatchObject({ brief: "", files: [], dependsOn: [], status: "pending" });
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      validatePlanDag({
        title: "t",
        tasks: [
          { id: "a", title: "a" },
          { id: " a ", title: "b" },
        ],
      }),
    ).toThrow(OrchestratorDagError);
  });

  test("rejects unknown and self dependencies", () => {
    expect(() =>
      validatePlanDag({ title: "t", tasks: [{ id: "a", title: "a", dependsOn: ["nope"] }] }),
    ).toThrow(/nonexistent/);
    expect(() =>
      validatePlanDag({ title: "t", tasks: [{ id: "a", title: "a", dependsOn: ["a"] }] }),
    ).toThrow(/itself/);
  });

  test("rejects cycles", () => {
    expect(() =>
      validatePlanDag({
        title: "t",
        tasks: [
          { id: "a", title: "a", dependsOn: ["b"] },
          { id: "b", title: "b", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/Cycle/);
  });

  test("rejects empty plans and bad maxParallel", () => {
    expect(() => validatePlanDag({ title: "t", tasks: [] })).toThrow(OrchestratorDagError);
    expect(() => validatePlanDag({ title: " ", tasks: [{ id: "a", title: "a" }] })).toThrow(
      OrchestratorDagError,
    );
    expect(() =>
      validatePlanDag({ title: "t", maxParallel: 0, tasks: [{ id: "a", title: "a" }] }),
    ).toThrow(OrchestratorDagError);
  });
});

describe("task transitions", () => {
  function blankPlan(): OrchestratorPlan {
    return {
      planId: "p1",
      version: 1,
      title: "t",
      maxParallel: 4,
      tasks: [{ id: "a", title: "a", brief: "", files: [], dependsOn: [], status: "pending" }],
    };
  }

  test("pending runs and completes; terminal states stick", () => {
    const plan = blankPlan();
    applyTaskUpdate(plan, { taskId: "a", status: "running" });
    expect(plan.tasks[0]?.status).toBe("running");
    applyTaskUpdate(plan, { taskId: "a", status: "completed" });
    expect(plan.tasks[0]?.status).toBe("completed");
    expect(() => applyTaskUpdate(plan, { taskId: "a", status: "pending" })).toThrow(
      OrchestratorTransitionError,
    );
  });

  test("pending cannot jump straight to completed; unknown tasks throw", () => {
    const plan = blankPlan();
    expect(() => applyTaskUpdate(plan, { taskId: "a", status: "completed" })).toThrow(
      OrchestratorTransitionError,
    );
    expect(() => applyTaskUpdate(plan, { taskId: "zzz", status: "running" })).toThrow(
      OrchestratorTransitionError,
    );
  });

  test("childAgentId links without a status change", () => {
    const plan = blankPlan();
    const { modified } = applyTaskUpdate(plan, { taskId: "a", childAgentId: "child-1" });
    expect(modified).toBe(true);
    expect(plan.tasks[0]?.childAgentId).toBe("child-1");
    expect(plan.tasks[0]?.status).toBe("pending");
  });
});

describe("OrchestratorPlanSchema (wire shape)", () => {
  test("parses the contract shape and rejects bad status", () => {
    const ok = OrchestratorPlanSchema.parse({
      planId: "p1",
      version: 1,
      title: "t",
      maxParallel: 2,
      tasks: [{ id: "a", title: "a", brief: "b", files: ["f"], dependsOn: [] }],
    });
    expect(ok.tasks[0]?.status).toBe("pending");
    expect(() =>
      OrchestratorPlanSchema.parse({
        planId: "p1",
        version: 1,
        title: "t",
        tasks: [{ id: "a", title: "a", status: "bogus" }],
      }),
    ).toThrow();
  });
});

interface Harness {
  root: string;
  manager: AgentManager;
  storage: AgentStorage;
  orchId: string;
  dispatcher: AgentManagerOrchestratorDispatcher;
  cleanup: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "orchestrator-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
  const created = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
    workspaceId: "ws-orch",
    orchestrator: true,
  });
  const orchId = created.id;
  const dispatcher = new AgentManagerOrchestratorDispatcher(manager, logger);
  return {
    root,
    manager,
    storage,
    orchId,
    dispatcher,
    cleanup: async () => {
      await manager.closeAgent(orchId).catch(() => undefined);
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForPendingApprovalId(h: Harness): Promise<string> {
  // proposePlan persists the plan + emits the row before raising the daemon
  // permission, so poll instead of reading pending synchronously.
  let pending = h.manager.getPendingPermissions(h.orchId);
  await vi.waitFor(() => {
    pending = h.manager.getPendingPermissions(h.orchId);
    expect(pending).toHaveLength(1);
  });
  const req = pending[0];
  expect(req).toMatchObject({
    name: "OrchestratorPlanApproval",
    kind: "plan",
    metadata: { source: "orchestrator" },
  });
  expect((req?.input as { plan?: { title?: string } } | undefined)?.plan?.title).toBe("Ship it");
  if (!req) throw new Error("expected a pending approval");
  return req.id;
}

function pluginRows(h: Harness) {
  return h.manager
    .getTimeline(h.orchId)
    .filter(
      (item): item is Extract<typeof item, { type: "plugin" }> =>
        item.type === "plugin" && item.pluginId === "orchestrator" && item.kind === "plan",
    );
}

describe("propose_plan permission flow", () => {
  test("approve stores v1, emits the plan row, and unblocks the call", async () => {
    const h = await createHarness();
    try {
      const proposed = h.dispatcher.proposePlan(h.orchId, planInput());
      const requestId = await waitForPendingApprovalId(h);
      expect(h.manager.getOrchestratorPlan(h.orchId)?.version).toBe(1);
      expect(pluginRows(h)).toHaveLength(1);

      await h.manager.respondToPermission(h.orchId, requestId, { behavior: "allow" });
      const result = await proposed;
      expect(result).toMatchObject({ approved: true, edited: false, rejected: false, version: 1 });
      expect(h.manager.getPendingPermissions(h.orchId)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("edit applies updatedInput.tasks briefs and bumps the version", async () => {
    const h = await createHarness();
    try {
      const proposed = h.dispatcher.proposePlan(h.orchId, planInput());
      const requestId = await waitForPendingApprovalId(h);
      await h.manager.respondToPermission(h.orchId, requestId, {
        behavior: "allow",
        updatedInput: { tasks: [{ id: "a", brief: "edited brief" }] } as unknown as AgentMetadata,
      });
      const result = await proposed;
      expect(result).toMatchObject({ approved: true, edited: true, version: 2 });
      expect(result.plan.tasks.find((t) => t.id === "a")?.brief).toBe("edited brief");
      expect(pluginRows(h)).toHaveLength(1);
      expect(pluginRows(h)[0]?.version).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("reject clears the plan", async () => {
    const h = await createHarness();
    try {
      const proposed = h.dispatcher.proposePlan(h.orchId, planInput());
      const requestId = await waitForPendingApprovalId(h);
      await h.manager.respondToPermission(h.orchId, requestId, { behavior: "deny" });
      const result = await proposed;
      expect(result).toMatchObject({ approved: false, rejected: true });
      expect(h.manager.getOrchestratorPlan(h.orchId)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("non-orchestrator callers are refused", async () => {
    const h = await createHarness();
    try {
      const worker = await h.manager.createAgent({ provider: "codex", cwd: h.root }, undefined, {
        workspaceId: "ws-orch",
      });
      try {
        await expect(h.dispatcher.proposePlan(worker.id, planInput())).rejects.toThrow(
          /orchestrator agent caller/,
        );
        expect(h.dispatcher.isOrchestratorAgent(worker.id)).toBe(false);
        expect(h.dispatcher.isOrchestratorAgent(h.orchId)).toBe(true);
      } finally {
        await h.manager.closeAgent(worker.id).catch(() => undefined);
      }
    } finally {
      await h.cleanup();
    }
  });
});

describe("orchestrator_task_update and child-failure rule", () => {
  async function approvedPlan(h: Harness): Promise<void> {
    const proposed = h.dispatcher.proposePlan(h.orchId, planInput());
    const requestId = await waitForPendingApprovalId(h);
    await h.manager.respondToPermission(h.orchId, requestId, { behavior: "allow" });
    await proposed;
  }

  test("task updates bump the version and emit rows", async () => {
    const h = await createHarness();
    try {
      await approvedPlan(h);
      const first = await h.dispatcher.updateTask(h.orchId, {
        taskId: "a",
        status: "running",
        childAgentId: "child-1",
      });
      expect(first.version).toBe(2);
      const second = await h.dispatcher.updateTask(h.orchId, {
        taskId: "a",
        status: "completed",
      });
      expect(second.version).toBe(3);
      expect(pluginRows(h)).toHaveLength(1);
      expect(pluginRows(h)[0]?.version).toBe(3);
      await expect(
        h.dispatcher.updateTask(h.orchId, { taskId: "a", status: "pending" }),
      ).rejects.toThrow(OrchestratorTransitionError);
    } finally {
      await h.cleanup();
    }
  });

  test("a failed child fails its running task and bumps the version", async () => {
    const h = await createHarness();
    try {
      await approvedPlan(h);
      await h.dispatcher.updateTask(h.orchId, {
        taskId: "a",
        status: "running",
        childAgentId: "child-1",
      });
      await h.manager.handleChildAgentFailure("child-1");
      const plan = h.manager.getOrchestratorPlan(h.orchId);
      expect(plan?.tasks.find((t) => t.id === "a")?.status).toBe("failed");
      expect(plan?.version).toBe(3);
      expect(pluginRows(h)).toHaveLength(1);
      expect(pluginRows(h)[0]?.version).toBe(3);

      const before = plan?.version;
      await h.manager.handleChildAgentFailure("unrelated-child");
      expect(h.manager.getOrchestratorPlan(h.orchId)?.version).toBe(before);
    } finally {
      await h.cleanup();
    }
  });

  test("archiving a running child fails its task and bumps the version", async () => {
    const h = await createHarness();
    try {
      await approvedPlan(h);
      const child = await h.manager.createAgent({ provider: "codex", cwd: h.root }, undefined, {
        workspaceId: "ws-orch",
      });
      try {
        await h.dispatcher.updateTask(h.orchId, {
          taskId: "a",
          status: "running",
          childAgentId: child.id,
        });
        await h.manager.archiveAgent(child.id);
        const plan = h.manager.getOrchestratorPlan(h.orchId);
        expect(plan?.tasks.find((t) => t.id === "a")?.status).toBe("failed");
        expect(plan?.version).toBe(3);
        expect(pluginRows(h)).toHaveLength(1);
        expect(pluginRows(h)[0]?.version).toBe(3);
        const stored = await h.storage.get(h.orchId);
        expect(stored?.orchestratorPlan?.version).toBe(3);
        expect(stored?.orchestratorPlan?.tasks.find((t) => t.id === "a")?.status).toBe("failed");
      } finally {
        await h.manager.closeAgent(child.id).catch(() => undefined);
      }
    } finally {
      await h.cleanup();
    }
  });
});

describe("orchestrator flag persistence across reload", () => {
  test("create flag survives close + reload and keeps the plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestrator-reload-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const agentId = "00000000-0000-4000-8000-000000000701";
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
      idFactory: () => agentId,
    });
    try {
      await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: "ws-orch",
        orchestrator: true,
      });
      const dispatcher = new AgentManagerOrchestratorDispatcher(manager, logger);
      const proposed = dispatcher.proposePlan(agentId, planInput());
      let pending = manager.getPendingPermissions(agentId);
      await vi.waitFor(() => {
        pending = manager.getPendingPermissions(agentId);
        expect(pending).toHaveLength(1);
      });
      await manager.respondToPermission(agentId, pending[0]?.id ?? "", { behavior: "allow" });
      await proposed;

      await manager.flush();
      await storage.flush();
      await manager.closeAgent(agentId);
      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });

      const reloaded = manager.getAgent(agentId);
      expect(reloaded?.orchestrator).toBe(true);
      expect(manager.getOrchestratorPlan(agentId)?.version).toBe(1);

      const stored = await storage.get(agentId);
      expect(stored?.orchestrator).toBe(true);
      expect(stored?.orchestratorPlan?.version).toBe(1);
    } finally {
      await manager.closeAgent(agentId).catch(() => undefined);
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orchestrator prompt is appended only for orchestrator agents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestrator-prompt-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const seen: Array<{ id: string | undefined; prompt: string }> = [];
    const base = createTestAgentClients().codex;
    if (!base) throw new Error("expected Codex test client");
    const origCreateSession = base.createSession.bind(base);
    base.createSession = (async (config, ctx) => {
      seen.push({
        id: ctx?.agentId,
        prompt: config.daemonAppendSystemPrompt ?? "",
      });
      return origCreateSession(config, ctx);
    }) as typeof base.createSession;
    const manager = new AgentManager({
      clients: { codex: base },
      registry: storage,
      logger,
    });
    try {
      const orch = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: "ws-orch",
        orchestrator: true,
      });
      const plain = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: "ws-orch",
      });
      const marker = buildOrchestratorSystemPrompt().split("\n")[0] ?? "# Orchestrator Mode";
      expect(seen.find((s) => s.id === orch.id)?.prompt).toContain(marker);
      expect(seen.find((s) => s.id === plain.id)?.prompt).not.toContain(marker);
    } finally {
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
