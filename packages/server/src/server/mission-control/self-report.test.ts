import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { MISSION_CONTROL_SELF_REPORT_PROMPT, buildSelfReportSystemPrompt } from "./self-report.js";
import { MissionControlService } from "./service.js";
import { MissionControlStore } from "./store.js";
import { MissionControlSummarizer, type MissionControlSummarizerConfig } from "./summarizer.js";

function makeTimelineRow(seq: number, text: string): AgentTimelineRow {
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    item: { type: "user_message", text },
  };
}

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

const GATEWAY_OK_BODY = JSON.stringify({
  worth_posting: true,
  kind: "milestone",
  headline: "Fixed the flaky test",
});

function stubGatewayResponse(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("buildSelfReportSystemPrompt", () => {
  test("returns the paragraph for a normal agent when enabled", () => {
    expect(buildSelfReportSystemPrompt({}, true)).toBe(MISSION_CONTROL_SELF_REPORT_PROMPT);
    expect(MISSION_CONTROL_SELF_REPORT_PROMPT.length).toBeGreaterThan(0);
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

describe("MissionControlService.reportSelfMilestone", () => {
  let dir: string;
  let service: MissionControlService;
  let broadcast: ReturnType<typeof vi.fn>;
  let updateAgentMetadata: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let getAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-self-report-service-"));
    broadcast = vi.fn();
    updateAgentMetadata = vi.fn(async () => undefined);
    enqueue = vi.fn();
    getAgent = vi.fn(() => null);
    service = new MissionControlService({
      paseoHome: dir,
      logger: createTestLogger(),
      agentManager: {
        getAgent,
        updateAgentMetadata,
        subscribe: vi.fn(() => () => {}),
      } as unknown as AgentManager,
      agentStorage: { get: async () => null } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast,
      digest: { enqueue },
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    const internals = service as unknown as { store: MissionControlStore };
    await awaitStoreWrites(internals.store);
    await rm(dir, { recursive: true, force: true });
  });

  test("stores a self-sourced event, broadcasts it, and refreshes identity", async () => {
    const result = await service.reportSelfMilestone("agent-1", {
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
    expect(enqueue).toHaveBeenCalledWith(result.event, {
      serverId: "test-server",
      hostName: "test-host",
    });
    expect(updateAgentMetadata).toHaveBeenCalledWith("agent-1", {
      shortDescription: "Tests are green",
    });
  });

  test("blocked self-reports map to attention severity and skip identity refresh", async () => {
    const result = await service.reportSelfMilestone("agent-1", {
      kind: "blocked",
      headline: "Stuck on a network issue",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.severity).toBe("attention");
    expect(updateAgentMetadata).not.toHaveBeenCalled();
  });

  test("polite error for mission-control-labeled agents", async () => {
    getAgent.mockReturnValue({ labels: { "paseo.mission-control": "commander" } });
    const result = await service.reportSelfMilestone("commander-1", {
      kind: "milestone",
      headline: "Dispatched work",
    });
    expect(result).toEqual({
      ok: false,
      reason: "excluded",
      message: expect.any(String),
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("rate limits a second self-report of a different kind within the window", async () => {
    await service.reportSelfMilestone("agent-1", { kind: "milestone", headline: "First" });
    const second = await service.reportSelfMilestone("agent-1", {
      kind: "finding",
      headline: "A discovery",
    });
    expect(second).toEqual({
      ok: false,
      reason: "rate_limited",
      message: expect.any(String),
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("same-kind excess within the window coalesces instead of erroring", async () => {
    const first = await service.reportSelfMilestone("agent-1", {
      kind: "milestone",
      headline: "First",
    });
    expect(first.ok).toBe(true);
    const second = await service.reportSelfMilestone("agent-1", {
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
    const first = await service.reportSelfMilestone("agent-1", {
      kind: "milestone",
      headline: "First",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    service.ackEvents([first.event.id]);
    const second = await service.reportSelfMilestone("agent-1", {
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

describe("MissionControlSummarizer demotion", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-summarizer-demotion-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  function makeSummarizer(rows: AgentTimelineRow[]) {
    const publish = vi.fn();
    const onIdentityUpdate = vi.fn();
    const config: MissionControlSummarizerConfig = {
      enabled: true,
      backend: "gateway",
      baseUrl: "http://gateway.test",
      apiKey: null,
      model: "extract",
      minNewItems: 2,
      debounceSeconds: 0,
    };
    const summarizer = new MissionControlSummarizer({
      logger: createTestLogger(),
      store,
      getTimeline: () => rows,
      publish,
      getConfig: () => config,
      onIdentityUpdate,
    });
    return { summarizer, publish, onIdentityUpdate };
  }

  test("item-count pass is skipped when the agent self-reported after the last pass", async () => {
    store.updateObservation("agent-a", {
      lastTimelineSeq: 0,
      lastSummarizerTs: "2026-01-01T00:00:00.000Z",
      lastSelfReportTs: "2026-01-02T00:00:00.000Z",
    });
    const rows = [makeTimelineRow(1, "First step"), makeTimelineRow(2, "Second step")];
    const { summarizer, publish } = makeSummarizer(rows);
    const fetchMock = stubGatewayResponse(GATEWAY_OK_BODY);

    summarizer.notifyTimelineRows("agent-a", rows);
    await vi.runAllTimersAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const observation = store.getObservation("agent-a");
    expect(observation.lastTimelineSeq).toBe(2);
    expect(observation.lastSummarizerTs).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("finished-transition outcome pass runs even after a self-report", async () => {
    store.updateObservation("agent-a", {
      lastTimelineSeq: 0,
      lastSummarizerTs: "2026-01-01T00:00:00.000Z",
      lastSelfReportTs: "2026-01-02T00:00:00.000Z",
    });
    const rows = [makeTimelineRow(1, "First step"), makeTimelineRow(2, "Second step")];
    const { summarizer, publish, onIdentityUpdate } = makeSummarizer(rows);
    const fetchMock = stubGatewayResponse(GATEWAY_OK_BODY);

    summarizer.notifyFinished("agent-a");
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-a",
        kind: "milestone",
        source: "summarizer",
        severity: "info",
        headline: "Fixed the flaky test",
      }),
    );
    expect(onIdentityUpdate).toHaveBeenCalledWith({
      agentId: "agent-a",
      description: "Fixed the flaky test",
    });
  });
});

describe("report_milestone tool", () => {
  test("is registered and routes through the mission control service", async () => {
    const reportSelfMilestone = vi.fn(async () => ({
      ok: true,
      event: { id: "mce_test" } as MissionControlEvent,
    }));
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: {} as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      missionControlService: { reportSelfMilestone } as unknown as MissionControlService,
      callerAgentId: "agent-1",
      logger: createTestLogger(),
    });

    const tool = catalog.getTool("report_milestone");
    expect(tool).toBeDefined();

    const result = await catalog.executeTool("report_milestone", {
      kind: "finding",
      headline: "Discovered a faster algorithm",
      proof: [{ kind: "url", url: "https://example.com/alg" }],
    });
    expect(reportSelfMilestone).toHaveBeenCalledWith("agent-1", {
      kind: "finding",
      headline: "Discovered a faster algorithm",
      proof: [{ kind: "url", url: "https://example.com/alg" }],
    });
    expect(result.structuredContent).toEqual({ ok: true, eventId: "mce_test" });
  });

  test("surfaces a rate-limit rejection as a tool error", async () => {
    const reportSelfMilestone = vi.fn(async () => ({
      ok: false,
      reason: "rate_limited",
      message: "Rate limited: one self-report per minute per agent.",
    }));
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: {} as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      missionControlService: { reportSelfMilestone } as unknown as MissionControlService,
      callerAgentId: "agent-1",
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("report_milestone", {
      kind: "milestone",
      headline: "Too fast",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      reason: "rate_limited",
      error: "Rate limited: one self-report per minute per agent.",
    });
  });
});
