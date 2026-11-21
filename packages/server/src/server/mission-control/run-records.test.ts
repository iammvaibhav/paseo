import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { MissionControlStore } from "./store.js";
import { assembleRunRecord, readLaunchBrief, runRecordTags } from "./run-records.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { MissionControlVerdict } from "./store.js";

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

function timelineRow(seq: number, text: string, timestamp: string): AgentTimelineRow {
  return { seq, timestamp, item: { type: "user_message", text } };
}

describe("M6 run-record assembly (docs/commander.md Context architecture)", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-run-records-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  async function seedRunOne(): Promise<void> {
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started running",
    });
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Wired the store",
      detail: "Atomic JSONL append landed",
      reportKind: "milestone",
    });
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "finding",
      source: "self",
      severity: "info",
      headline: "Decided: run records key by runEpoch",
      reportKind: "decision",
    });
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Proof attached",
      proof: [{ kind: "url", url: "https://example.com/proof", label: "CI green" }],
      reportKind: "progress",
    });
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
  }

  test("assembleRunRecord builds brief + reports + verdict + proofs, run-scoped", async () => {
    await seedRunOne();
    const verdict: MissionControlVerdict = {
      by: "verifier",
      summary: "Proofs match the brief",
      at: new Date().toISOString(),
    };
    await store.setReviewState("agent-1", "done", { verdict });

    const record = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Wired the store",
      hostAlias: "local",
      serverId: "server-1",
      runEpoch: store.getObservation("agent-1").runEpoch,
      events: store.fetchEvents({ includeSuperseded: true }),
      timelineRows: [timelineRow(1, "Ship run records for M6", "2026-08-09T09:00:00.000Z")],
      reviewVerdict: store.getReviewState("agent-1").verdict,
      placement: {
        workspaceId: "ws-1",
        workspaceTitle: "mission-control",
        projectId: "proj-1",
        projectName: "paseo",
      },
    });

    expect(record.id).toBe("mcr_agent-1_1");
    expect(record.agentName).toBe("Rusty");
    expect(record.outcome).toBe("finished");
    // Launch brief = first non-empty user_message timeline row.
    expect(record.brief).toBe("Ship run records for M6");
    // Reports = self-sourced events only (the system started/finished cards are excluded).
    expect(record.reports).toHaveLength(3);
    expect(record.reports[0].headline).toBe("Wired the store");
    expect(record.reports[1].reportKind).toBe("decision");
    // Verdict included (recorded after the run started).
    expect(record.verdict?.summary).toBe("Proofs match the brief");
    // Proofs flattened + deduped from the self-report events.
    expect(record.proofs).toEqual([
      { kind: "url", url: "https://example.com/proof", label: "CI green" },
    ]);
    // Workspace/project attribution frozen in.
    expect(record.workspaceTitle).toBe("mission-control");
    expect(record.projectName).toBe("paseo");
  });

  test("reports are run-scoped: a later run's events never leak into an earlier run record", async () => {
    await seedRunOne();
    const runOneEpoch = store.getObservation("agent-1").runEpoch;

    // Run two: a started card opens a new epoch; its reports differ.
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started running",
    });
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "finding",
      source: "self",
      severity: "info",
      headline: "Second run: rollups cached",
      reportKind: "milestone",
    });

    const runOne = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      hostAlias: "local",
      serverId: "server-1",
      runEpoch: runOneEpoch,
      events: store.fetchEvents({ includeSuperseded: true }),
      timelineRows: [],
      reviewVerdict: null,
      placement: null,
    });
    expect(runOne.outcome).toBe("finished");
    expect(runOne.reports.map((report) => report.headline)).toEqual([
      "Wired the store",
      "Decided: run records key by runEpoch",
      "Proof attached",
    ]);

    const runTwo = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      hostAlias: "local",
      serverId: "server-1",
      runEpoch: store.getObservation("agent-1").runEpoch,
      events: store.fetchEvents({ includeSuperseded: true }),
      timelineRows: [],
      reviewVerdict: null,
      placement: null,
    });
    expect(runTwo.runEpoch).toBe(runOneEpoch + 1);
    expect(runTwo.outcome).toBe("running");
    expect(runTwo.reports.map((report) => report.headline)).toEqual(["Second run: rollups cached"]);
  });

  test("a verdict from an earlier run never leaks into a later run's record", async () => {
    await seedRunOne();
    const oldVerdict: MissionControlVerdict = {
      by: "verifier",
      summary: "Run one verdict",
      // Predates run two's start (real now) so it can only belong to run one.
      at: "2020-01-01T00:00:00.000Z",
    };
    await store.setReviewState("agent-1", "done", { verdict: oldVerdict });

    // Run two starts AFTER the verdict was recorded; the review state still
    // carries run one's verdict until the next completion resets it.
    await store.append({
      agentId: "agent-1",
      agentTitle: "Rusty",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started running",
    });
    const runTwo = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      hostAlias: "local",
      serverId: "server-1",
      runEpoch: store.getObservation("agent-1").runEpoch,
      events: store.fetchEvents({ includeSuperseded: true }),
      timelineRows: [],
      reviewVerdict: store.getReviewState("agent-1").verdict,
      placement: null,
    });
    expect(runTwo.verdict).toBeNull();
    expect(runTwo.outcome).toBe("running");
  });

  test("run records persist through the store and reload (own JSONL, latest wins)", async () => {
    await seedRunOne();
    const record = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      hostAlias: "local",
      serverId: "server-1",
      runEpoch: store.getObservation("agent-1").runEpoch,
      events: store.fetchEvents({ includeSuperseded: true }),
      timelineRows: [timelineRow(1, "Ship run records", "2026-08-09T09:00:00.000Z")],
      reviewVerdict: null,
      placement: null,
    });
    store.putRunRecord(record);
    // A verdict update re-writes the same id — the reloaded store keeps the latest.
    const updated = { ...record, verdict: { by: "verifier" as const, summary: "Done", at: "t1" } };
    store.putRunRecord(updated);
    await awaitStoreWrites(store);

    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getLatestRunRecord("agent-1")).toMatchObject({
      id: "mcr_agent-1_1",
      brief: "Ship run records",
      verdict: { by: "verifier", summary: "Done", at: "t1" },
    });
    expect(reloaded.getRunRecords()).toHaveLength(1);
  });

  test("readLaunchBrief takes the first non-empty user message and readLaunchBrief caps it", () => {
    expect(
      readLaunchBrief([
        { seq: 1, timestamp: "t1", item: { type: "user_message", text: "   " } },
        { seq: 2, timestamp: "t2", item: { type: "user_message", text: "Ship it" } },
      ]),
    ).toBe("Ship it");
    expect(readLaunchBrief([])).toBeNull();
  });

  test("runRecordTags carry host/project/workspace/agent attribution", () => {
    const record = assembleRunRecord({
      agentId: "agent-1",
      agentName: "Rusty",
      agentTitle: "Rusty",
      hostAlias: "work-server",
      serverId: "server-1",
      runEpoch: 1,
      events: [],
      timelineRows: [],
      reviewVerdict: null,
      placement: {
        workspaceId: "ws-1",
        workspaceTitle: "mission-control",
        projectId: "proj-1",
        projectName: "paseo",
      },
    });
    expect(runRecordTags(record)).toEqual([
      "host:work-server",
      "agent:Rusty",
      "project:paseo",
      "workspace:mission-control",
    ]);
  });
});
