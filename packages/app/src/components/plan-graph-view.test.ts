import { describe, expect, it } from "vitest";
import {
  layoutPlanLayers,
  parseOrchestratorPlan,
  type OrchestratorPlanTaskView,
} from "./plan-graph-view-core";

function task(id: string, dependsOn: string[] = []): OrchestratorPlanTaskView {
  return { id, title: id, brief: "", files: [], dependsOn, status: "pending" };
}

describe("layoutPlanLayers", () => {
  it("layers tasks by dependency depth", () => {
    const { layers, maxLayer } = layoutPlanLayers([
      task("a"),
      task("b", ["a"]),
      task("c", ["b"]),
      task("d"),
    ]);
    expect(maxLayer).toBe(2);
    expect(layers[0]?.map((entry) => entry.id).sort()).toEqual(["a", "d"]);
    expect(layers[1]?.map((entry) => entry.id)).toEqual(["b"]);
    expect(layers[2]?.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("ignores unknown dependencies and survives cycles", () => {
    const { layers } = layoutPlanLayers([
      task("a", ["missing"]),
      task("b", ["c"]),
      task("c", ["b"]),
    ]);
    expect(
      layers
        .flat()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("parseOrchestratorPlan", () => {
  it("parses plan tasks and normalizes unknown status", () => {
    const plan = parseOrchestratorPlan({
      planId: "p1",
      version: 2,
      title: "Plan",
      maxParallel: 2,
      tasks: [
        {
          id: "t1",
          title: "First",
          brief: "brief",
          files: ["a.ts"],
          dependsOn: [],
          status: "ready",
          childAgentId: "agent-1",
        },
        { id: "t2", title: "Second", brief: "", files: [], dependsOn: ["t1"], status: "weird" },
      ],
    });
    expect(plan?.planId).toBe("p1");
    expect(plan?.version).toBe(2);
    expect(plan?.tasks).toHaveLength(2);
    expect(plan?.tasks[0]?.childAgentId).toBe("agent-1");
    expect(plan?.tasks[1]?.status).toBe("pending");
  });

  it("rejects non-plan values", () => {
    expect(parseOrchestratorPlan(null)).toBeNull();
    expect(parseOrchestratorPlan({ planId: "p1", tasks: [] })).toBeNull();
    expect(parseOrchestratorPlan({ planId: "p1", tasks: [{ nope: true }] })).toBeNull();
  });
});

describe("planTaskStatusToJsonPatchBriefs", () => {
  it("returns only changed briefs as id/brief patches", async () => {
    const { planTaskStatusToJsonPatchBriefs } = await import("./plan-graph-view-core");
    const tasks = [
      { id: "a", title: "A", brief: "one", files: [], dependsOn: [], status: "pending" as const },
      { id: "b", title: "B", brief: "two", files: [], dependsOn: [], status: "pending" as const },
    ];
    expect(planTaskStatusToJsonPatchBriefs({ planTasks: tasks, briefDrafts: {} })).toEqual([]);
    expect(
      planTaskStatusToJsonPatchBriefs({
        planTasks: tasks,
        briefDrafts: { a: "one", b: "two edited" },
      }),
    ).toEqual([{ id: "b", brief: "two edited" }]);
  });
});
