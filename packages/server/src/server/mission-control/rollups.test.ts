import { describe, expect, test } from "vitest";
import {
  RollupCache,
  buildPriorWorkBlock,
  deriveProjectRollup,
  deriveWorkspaceRollup,
} from "./rollups.js";
import type { MissionControlRunRecord } from "./run-records.js";

function runRecord(
  overrides: Partial<MissionControlRunRecord> & { id: string },
): MissionControlRunRecord {
  return {
    id: overrides.id,
    agentId: "agent-1",
    agentName: "Rusty",
    agentTitle: "Rusty",
    hostAlias: "local",
    serverId: "server-1",
    workspaceId: "ws-1",
    workspaceTitle: "mission-control",
    projectId: "proj-1",
    projectName: "paseo",
    runEpoch: 1,
    startedAt: "2026-08-09T09:00:00.000Z",
    endedAt: "2026-08-09T10:00:00.000Z",
    outcome: "finished",
    brief: "Ship run records for M6",
    reports: [],
    verdict: null,
    proofs: [],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  } as MissionControlRunRecord;
}

describe("M6 rollup derivation", () => {
  test("workspace rollup aggregates the latest run records for that workspace, newest first", () => {
    const older = runRecord({
      id: "mcr_agent-1_1",
      endedAt: "2026-08-09T10:00:00.000Z",
      brief: "Old run",
    });
    const newer = runRecord({
      id: "mcr_agent-2_1",
      agentId: "agent-2",
      agentName: "Sage",
      endedAt: "2026-08-09T11:00:00.000Z",
      brief: "New run",
      reports: [
        {
          ts: "2026-08-09T10:30:00.000Z",
          kind: "finding",
          headline: "Decided: key by runEpoch",
          reportKind: "decision",
        },
        {
          ts: "2026-08-09T10:31:00.000Z",
          kind: "blocked",
          headline: "Blocked on API probe",
        },
      ],
    });
    const otherWorkspace = runRecord({
      id: "mcr_agent-3_1",
      agentId: "agent-3",
      agentName: "Quill",
      workspaceId: "ws-other",
      endedAt: "2026-08-09T12:00:00.000Z",
    });

    const rollup = deriveWorkspaceRollup([older, newer, otherWorkspace], "ws-1");
    expect(rollup).not.toBeNull();
    expect(rollup!.runs.map((entry) => entry.agentName)).toEqual(["Sage", "Rusty"]);
    expect(rollup!.workspaceTitle).toBe("mission-control");
    expect(rollup!.projectName).toBe("paseo");
    // What was decided + what's open, derived deterministically.
    expect(rollup!.runs[0].decisions).toEqual(["Decided: key by runEpoch"]);
    expect(rollup!.runs[0].open).toEqual(["Blocked on API probe", "awaiting verdict"]);
    // A finished run without a verdict is open ("awaiting verdict").
    expect(rollup!.runs[1].open).toEqual(["awaiting verdict"]);
  });

  test("workspace rollup is null when the workspace has no run records", () => {
    expect(deriveWorkspaceRollup([], "ws-empty")).toBeNull();
  });

  test("project rollup aggregates across the project's workspaces", () => {
    const records = [
      runRecord({
        id: "mcr_a_1",
        agentId: "a",
        agentName: "Alpha",
        workspaceId: "ws-1",
        endedAt: "2026-08-09T10:00:00.000Z",
      }),
      runRecord({
        id: "mcr_b_1",
        agentId: "b",
        agentName: "Beta",
        workspaceId: "ws-2",
        endedAt: "2026-08-09T11:00:00.000Z",
      }),
      runRecord({
        id: "mcr_c_1",
        agentId: "c",
        agentName: "Gamma",
        projectId: "proj-other",
        workspaceId: "ws-3",
        endedAt: "2026-08-09T12:00:00.000Z",
      }),
    ];
    const rollup = deriveProjectRollup(records, "proj-1");
    expect(rollup!.runs.map((entry) => entry.agentName)).toEqual(["Beta", "Alpha"]);
    expect(rollup!.projectName).toBe("paseo");
    expect(deriveProjectRollup(records, "proj-missing")).toBeNull();
  });

  test("buildPriorWorkBlock renders the '# Prior work in this workspace' block and is bounded", () => {
    const records = [
      runRecord({
        id: "mcr_a_1",
        agentId: "a",
        agentName: "Alpha",
        endedAt: "2026-08-09T10:00:00.000Z",
        brief: "Ship the auth rewrite",
        reports: [
          {
            ts: "2026-08-09T09:30:00.000Z",
            kind: "finding",
            headline: "Decided: JWT over sessions",
            reportKind: "decision",
          },
        ],
        verdict: { by: "verifier", summary: "Proofs match", at: "2026-08-09T10:05:00.000Z" },
      }),
    ];
    const rollup = deriveWorkspaceRollup(records, "ws-1")!;
    const block = buildPriorWorkBlock(rollup);
    expect(block).toContain("# Prior work in this workspace");
    expect(block).toContain("Alpha");
    expect(block).toContain("decided: Decided: JWT over sessions");
    expect(block).toContain("verdict: Proofs match");
    expect(Buffer.byteLength(block!, "utf8")).toBeLessThanOrEqual(2048);
  });

  test("buildPriorWorkBlock respects a tight budget (newest entries win)", () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      runRecord({
        id: `mcr_x_${index}`,
        agentId: `x-${index}`,
        agentName: `Agent${index}`,
        endedAt: `2026-08-09T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
        brief: "A deliberately long launch brief line that repeats to consume budget ".repeat(4),
      }),
    );
    const rollup = deriveWorkspaceRollup(records, "ws-1", 10)!;
    const block = buildPriorWorkBlock(rollup, 400);
    expect(Buffer.byteLength(block!, "utf8")).toBeLessThanOrEqual(400);
    // The newest entry survives the budget cut.
    expect(block).toContain("Agent9");
  });

  test("RollupCache caches per key and invalidates wholesale", () => {
    const cache = new RollupCache();
    let computes = 0;
    const first = cache.getWorkspace("ws-1", () => {
      computes += 1;
      return deriveWorkspaceRollup([runRecord({ id: "mcr_a_1" })], "ws-1");
    });
    expect(first).not.toBeNull();
    const second = cache.getWorkspace("ws-1", () => {
      computes += 1;
      return null;
    });
    expect(second).not.toBeNull();
    expect(computes).toBe(1);

    cache.invalidate();
    const third = cache.getWorkspace("ws-1", () => {
      computes += 1;
      return null;
    });
    expect(third).toBeNull();
    expect(computes).toBe(2);
  });
});
