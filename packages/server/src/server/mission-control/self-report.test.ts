import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { MISSION_CONTROL_SELF_REPORT_PROMPT, buildSelfReportSystemPrompt } from "./self-report.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { MissionControlService } from "./service.js";
import { MissionControlStore } from "./store.js";

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

describe("buildSelfReportSystemPrompt", () => {
  test("returns the static self-report paragraph for a normal agent when enabled", () => {
    const prompt = buildSelfReportSystemPrompt({}, true);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(MISSION_CONTROL_SELF_REPORT_PROMPT);
    // The paragraph is static: it never embeds per-agent identity, so the
    // composed daemon append (and the OMP warm-pool key) is identical for
    // every pool-eligible agent.
    expect(prompt).toBe(MISSION_CONTROL_SELF_REPORT_PROMPT);
    expect(MISSION_CONTROL_SELF_REPORT_PROMPT.length).toBeGreaterThan(0);
  });

  test("injects the report_status tool with the spec discipline rules", () => {
    const prompt = MISSION_CONTROL_SELF_REPORT_PROMPT;
    expect(prompt).toContain("report_status");
    expect(prompt).not.toContain("report_milestone");
    // completed/blocked discipline and hub-wait guidance per spec; the
    // prompt never steers agents to working/inconclusive.
    expect(prompt).toContain("completed");
    expect(prompt).toContain("blocked");
    expect(prompt).not.toContain("inconclusive");
    expect(prompt).toContain("hub-wait");
    expect(prompt).toContain("proof");
  });

  test("paragraph carries the title/description ownership rules", () => {
    const prompt = MISSION_CONTROL_SELF_REPORT_PROMPT;
    // Spec 06: title is write-once and FROZEN (never resent); description is
    // living and replaced on EVERY report.
    expect(prompt).toContain("title");
    expect(prompt).toContain("description");
    expect(prompt).toContain("FROZEN");
    expect(prompt).toContain("title is fixed; description updated");
    expect(prompt).toContain("fleet_rename_agent_title");
    expect(prompt).toContain("FRESH description on EVERY report");
    expect(prompt).toContain("~400 characters");
  });

  test("never embeds the agent's title or description", () => {
    const prompt = buildSelfReportSystemPrompt({}, true);
    expect(prompt).not.toContain("- Title:");
    expect(prompt).not.toContain("- Description:");
    expect(prompt).not.toContain("Your current identity");
    expect(prompt).not.toContain("no title or description yet");
  });

  test("returns null for a mission-control-labeled agent", () => {
    expect(buildSelfReportSystemPrompt({ "paseo.mission-control": "commander" }, true)).toBeNull();
  });

  test("returns null when the kill-switch is off", () => {
    expect(buildSelfReportSystemPrompt({}, false)).toBeNull();
  });
});

describe("MissionControlStore self-report support", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-self-report-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  test("append accepts source self", async () => {
    const event = await store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Root cause found",
    });
    expect(event.source).toBe("self");
    expect(store.getObservation("agent-1").lastEventByKind.milestone).toBe(event.id);
  });

  test("wouldCoalesce tracks the unacked same-kind head", async () => {
    expect(store.wouldCoalesce("agent-1", "milestone")).toBe(false);
    const first = await store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "First",
    });
    expect(store.wouldCoalesce("agent-1", "milestone")).toBe(true);
    expect(store.wouldCoalesce("agent-1", "finding")).toBe(false);
    const second = await store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Second",
    });
    expect(second.supersedesId).toBe(first.id);
    expect(second.coalescedCount).toBe(1);
    store.ackEvents([second.id]);
    expect(store.wouldCoalesce("agent-1", "milestone")).toBe(false);
  });
});

describe("MissionControlService.reportSelfStatus", () => {
  let dir: string;
  let service: MissionControlService;
  let broadcast: ReturnType<typeof vi.fn>;
  let updateAgentMetadata: ReturnType<typeof vi.fn>;
  let getAgent: ReturnType<typeof vi.fn>;
  let getStoredAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-self-report-service-"));
    broadcast = vi.fn();
    updateAgentMetadata = vi.fn(async () => undefined);
    getAgent = vi.fn(() => null);
    getStoredAgent = vi.fn(async () => null);
    service = new MissionControlService({
      paseoHome: dir,
      logger: createTestLogger(),
      agentManager: {
        getAgent,
        updateAgentMetadata,
        subscribe: vi.fn(() => () => {}),
      } as unknown as AgentManager,
      agentStorage: { get: getStoredAgent } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast,
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    const internals = service as unknown as { store: MissionControlStore };
    await awaitStoreWrites(internals.store);
    await rm(dir, { recursive: true, force: true });
  });

  test("stores a self-sourced working report and broadcasts it; no identity change without title/description", async () => {
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "Tests are green",
      detail: "Full suite passes",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.source).toBe("self");
    expect(result.event.severity).toBe("info");
    expect(result.event.headline).toBe("Tests are green");
    expect(result.event.detail).toBe("Full suite passes");
    expect(broadcast).toHaveBeenCalledWith({
      type: "mission_control_event",
      event: result.event,
    });
    // M3: the feed keeps the event; nothing is enqueued for the Commander.
    // title/description only update when the agent explicitly provides them.
    expect(updateAgentMetadata).not.toHaveBeenCalled();
    // Nothing was sent, so there is nothing to compare: no identity echo.
    expect(result.identity).toEqual({});
  });

  test("preserves the original report_status kind as reportKind for card icons", async () => {
    // progress|milestone collapse onto kind "milestone" and finding|fix|
    // decision onto kind "finding" — reportKind keeps the original so the app
    // can icon them distinctly. Absent when the report carries no kind.
    // (Distinct agents: one self-report per agent per minute, no coalesce
    // across kinds.)
    const progress = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "Halfway there",
    });
    expect(progress.ok).toBe(true);
    if (!progress.ok) {
      return;
    }
    expect(progress.event.kind).toBe("milestone");
    expect(progress.event.reportKind).toBe("progress");

    const finding = await service.reportSelfStatus("agent-2", {
      status: "working",
      kind: "finding",
      headline: "Root cause isolated",
    });
    expect(finding.ok).toBe(true);
    if (!finding.ok) {
      return;
    }
    expect(finding.event.kind).toBe("finding");
    expect(finding.event.reportKind).toBe("finding");

    const bare = await service.reportSelfStatus("agent-3", {
      status: "working",
      headline: "No kind given",
    });
    expect(bare.ok).toBe(true);
    if (!bare.ok) {
      return;
    }
    expect(bare.event.kind).toBe("milestone");
    expect(bare.event.reportKind).toBeUndefined();
  });

  test("description replaces on every report; a set title is frozen and ignored", async () => {
    // The record already has a title (frozen at registration, spec 06): the
    // agent's title write is IGNORED (backfill only when unset) and the
    // result notices "title is fixed; description updated". The description
    // is living and replaces.
    getStoredAgent.mockResolvedValue({
      title: "Pipeline rename",
      shortDescription: "Decided on the new pipeline shape",
    });
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "decision",
      headline: "Renamed the pipeline",
      title: "Renamed again",
      description: "Decided on the new pipeline shape",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(updateAgentMetadata).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ shortDescription: "Decided on the new pipeline shape" }),
    );
    // The frozen title never reaches the record; the echo tells the agent
    // the stored (frozen) title so it stops resending it.
    expect(updateAgentMetadata.mock.calls[0][1].title).toBeUndefined();
    expect(result.notice).toContain("title is fixed; description updated");
    expect(result.identity).toEqual({ title: "Pipeline rename" });
  });

  test("a title accepted as backfill when the record has none", async () => {
    // No title on record: the agent's title is the backfill that fills it.
    // The mock storage is stateful so the backfill write sticks.
    getStoredAgent.mockResolvedValue({
      shortDescription: "Decided on the new pipeline shape",
    });
    updateAgentMetadata.mockImplementation(async (agentId: string, updates: object) => {
      const stored = await getStoredAgent(agentId);
      getStoredAgent.mockResolvedValue({ ...stored, ...updates });
    });
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "decision",
      headline: "Renamed the pipeline",
      title: "Pipeline rename",
      description: "Decided on the new pipeline shape",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(updateAgentMetadata).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        title: "Pipeline rename",
        shortDescription: "Decided on the new pipeline shape",
      }),
    );
    expect(result.notice).toBeUndefined();
    expect(result.identity).toEqual({});
  });

  test("echoes stored identity only when it drifted from what the agent sent", async () => {
    // The title is frozen at "Legacy title": a differing title send is
    // ignored, and the echo tells the agent the stored (frozen) value.
    getStoredAgent.mockResolvedValue({
      title: "Legacy title",
      shortDescription: "Legacy description",
    });
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "decision",
      headline: "Changed direction",
      title: "New direction",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The frozen title echoes (with the stored value); the description was
    // not sent, so it stays silent even though the record holds one.
    expect(result.identity).toEqual({ title: "Legacy title" });
  });

  test("echoes null for a side whose write did not stick", async () => {
    // The agent sent a title but the record holds none: drift, echoed as null.
    getStoredAgent.mockResolvedValue(null);
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "decision",
      headline: "Renamed",
      title: "Pipeline rename",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.identity).toEqual({ title: null });
  });

  test("completed self-reports map to a finished event and move the agent to ready-for-review", async () => {
    const result = await service.reportSelfStatus("agent-1", {
      status: "completed",
      headline: "Everything asked is done",
      proofs: [{ kind: "url", url: "https://example.com/evidence" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.kind).toBe("finished");
    expect(result.event.proof).toEqual([{ kind: "url", url: "https://example.com/evidence" }]);
    expect(service.getReviewState("agent-1")).toMatchObject({ reviewState: "ready" });
  });

  test("blocked self-reports map to a blocker-severity blocked event", async () => {
    const result = await service.reportSelfStatus("agent-1", {
      status: "blocked",
      headline: "Stuck on a network issue",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.kind).toBe("blocked");
    expect(result.event.severity).toBe("blocker");
    expect(updateAgentMetadata).not.toHaveBeenCalled();
  });

  test("polite error for mission-control-labeled agents", async () => {
    getAgent.mockReturnValue({ labels: { "paseo.mission-control": "commander" } });
    const result = await service.reportSelfStatus("commander-1", {
      status: "working",
      headline: "Dispatched work",
    });
    expect(result).toEqual({
      ok: false,
      reason: "excluded",
      message: expect.any(String),
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("rate limits a second self-report within the window", async () => {
    await service.reportSelfStatus("agent-1", { status: "working", headline: "First" });
    const second = await service.reportSelfStatus("agent-1", {
      status: "blocked",
      headline: "Now stuck",
    });
    expect(second).toEqual({
      ok: false,
      reason: "rate_limited",
      message: expect.any(String),
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("a run-boundary self-report within the window is admitted as a fresh card", async () => {
    const first = await service.reportSelfStatus("agent-1", {
      status: "completed",
      headline: "First run done",
      detail: "stale detail",
      proofs: [{ kind: "url", url: "https://example.com/evidence" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    // The run ends and a new run starts: the daemon emits a `started` card,
    // which bumps the agent's run epoch in the store.
    const internals = service as unknown as { store: MissionControlStore };
    await internals.store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started running",
    });
    // The report lands within the 60s window but in the NEW run: it is never
    // spam, so it is admitted — and it must NOT fold into the previous run's
    // chain (no inherited detail/proof, no supersede).
    const second = await service.reportSelfStatus("agent-1", {
      status: "completed",
      headline: "Second run done",
      detail: "fresh detail",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.event.supersedesId).toBeUndefined();
    expect(second.event.detail).toBe("fresh detail");
    expect(second.event.proof).toBeUndefined();
    expect(second.event.runEpoch).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("same-kind excess within the window coalesces instead of erroring", async () => {
    const first = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "First",
    });
    expect(first.ok).toBe(true);
    const second = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "Also fixed the build",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.event.supersedesId).toBe(first.ok ? first.event.id : undefined);
    expect(second.event.coalescedCount).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("acked same-kind head cannot be coalesced, so the window rate limit applies", async () => {
    const first = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "First",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    service.ackEvents([first.event.id]);
    const second = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "Second",
    });
    expect(second).toEqual({
      ok: false,
      reason: "rate_limited",
      message: expect.any(String),
    });
  });
});

describe("report_status tool", () => {
  function createCatalog(
    overrides: {
      reportSelfStatus?: ReturnType<typeof vi.fn>;
      callerAgentId?: string | null;
    } = {},
  ) {
    const reportSelfStatus =
      overrides.reportSelfStatus ??
      vi.fn(async () => ({
        ok: true,
        event: { id: "mce_test" } as MissionControlEvent,
        identity: { title: "Drifted title", description: "Drifted description" },
      }));
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: {} as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      missionControlService: { reportSelfStatus } as unknown as MissionControlService,
      callerAgentId: overrides.callerAgentId === undefined ? "agent-1" : overrides.callerAgentId,
      logger: createTestLogger(),
    });
    return { catalog, reportSelfStatus };
  }

  test("is registered, replaces report_milestone, and routes the full spec input through the service", async () => {
    const { catalog, reportSelfStatus } = createCatalog();
    expect(catalog.getTool("report_milestone")).toBeUndefined();
    const tool = catalog.getTool("report_status");
    expect(tool).toBeDefined();

    const input = {
      status: "completed" as const,
      headline: "Shipped the migration",
      detail: "All tests green across the fleet.",
      kind: "milestone" as const,
      title: "Migration shipped",
      description: "Fleet migration complete",
      proofs: [
        { kind: "url" as const, url: "https://example.com/migration", label: "PR" },
        { kind: "code" as const, excerpt: "await migrate()", label: "Diff" },
      ],
    };
    const result = await catalog.executeTool("report_status", input);
    expect(reportSelfStatus).toHaveBeenCalledWith("agent-1", input);
    expect(result.structuredContent).toEqual({
      ok: true,
      eventId: "mce_test",
      title: "Drifted title",
      description: "Drifted description",
    });
  });

  test("omits identity fields from the result when the agent's values are current", async () => {
    const { catalog } = createCatalog({
      reportSelfStatus: vi.fn(async () => ({
        ok: true,
        event: { id: "mce_test" } as MissionControlEvent,
        identity: {},
      })),
    });
    const result = await catalog.executeTool("report_status", {
      status: "working",
      headline: "All current",
    });
    expect(result.structuredContent).toEqual({ ok: true, eventId: "mce_test" });
  });

  test("validates the schema: bad status, headline over 120 chars, and unknown proof kinds are rejected", async () => {
    const { catalog, reportSelfStatus } = createCatalog();
    await expect(
      catalog.executeTool("report_status", { status: "done", headline: "nope" }),
    ).rejects.toThrow();
    await expect(
      catalog.executeTool("report_status", {
        status: "working",
        headline: "x".repeat(121),
      }),
    ).rejects.toThrow();
    await expect(
      catalog.executeTool("report_status", {
        status: "working",
        headline: "fine",
        proofs: [{ kind: "screenshot", path: "/tmp/a.png" }],
      }),
    ).rejects.toThrow();
    expect(reportSelfStatus).not.toHaveBeenCalled();
  });

  test("surfaces a rate-limit rejection as a tool error", async () => {
    const { catalog } = createCatalog({
      reportSelfStatus: vi.fn(async () => ({
        ok: false,
        reason: "rate_limited",
        message: "Rate limited: one self-report per minute per agent.",
      })),
    });

    const result = await catalog.executeTool("report_status", {
      status: "working",
      headline: "Too fast",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      reason: "rate_limited",
      error: "Rate limited: one self-report per minute per agent.",
    });
  });

  test("requires an agent-scoped session", async () => {
    const { catalog } = createCatalog({ callerAgentId: null });
    await expect(
      catalog.executeTool("report_status", { status: "working", headline: "nope" }),
    ).rejects.toThrow("report_status requires an agent-scoped session");
  });
});
