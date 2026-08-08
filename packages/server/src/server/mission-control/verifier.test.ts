import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentRunResult } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { PaseoToolHostDependencies } from "../agent/tools/paseo-tools.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { MissionControlStore, type MissionControlAppendInput } from "./store.js";
import {
  loadVerifierAgentInstructions,
  MissionControlVerifierDispatcher,
  resolveVerifierModel,
  type VerifierCentralConfig,
  type VerifierProposal,
  type VerifierTaggedMessage,
} from "./verifier.js";

const BASE_CENTRAL_CONFIG: VerifierCentralConfig = {
  verifierModel: null,
  verifierConcurrency: 3,
  evaluationScope: "commander",
};

const VERIFIER_MD = `---
name: verifier
model:
  - "@verifier"
---
Audit the worker's evidence against the brief.

- Demand missing proofs via contact_worker.
- Never do the work.
- Verdict via submit_verdict.
`;

function makeWorker(id: string, labels: Record<string, string> = {}): ManagedAgent {
  return {
    id,
    labels,
    internal: false,
    cwd: `/tmp/${id}`,
    name: `Name-${id}`,
    config: { provider: "omp", cwd: `/tmp/${id}`, title: `Title-${id}` },
  } as unknown as ManagedAgent;
}

function makeCommander(): ManagedAgent {
  return makeWorker("commander-1", { "paseo.mission-control": "commander" });
}

function makeTimelineRow(seq: number, text: string): AgentTimelineRow {
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    item: { type: "user_message", text },
  };
}

interface PendingTurn {
  resolve: (result: AgentRunResult) => void;
  reject: (error: Error) => void;
}

interface Harness {
  dir: string;
  store: MissionControlStore;
  dispatcher: MissionControlVerifierDispatcher;
  published: Array<Omit<MissionControlAppendInput, "agentTitle">>;
  created: Array<{ config: Record<string, unknown>; options: Record<string, unknown> }>;
  createAgentError: Error | null;
  runs: Array<{ agentId: string; prompt: string }>;
  archived: string[];
  steers: Array<{ agentId: string; prompt: string }>;
  proposals: VerifierProposal[];
  setReviewStateCalls: Array<{ agentId: string; state: string; options?: unknown }>;
  taggedMessages: VerifierTaggedMessage[];
  emitReviewState: (agentId: string, state: "none" | "ready" | "done" | "cleared") => void;
  emitSelfReport: (event: MissionControlEvent) => void;
  emitProposalChange: (proposal: VerifierProposal) => void;
  emitManagerEvent: (event: AgentManagerEvent) => void;
  setWorker: (agent: ManagedAgent) => void;
  setTimeline: (agentId: string, rows: AgentTimelineRow[]) => void;
  completeVerifierTurn: (verifierAgentId: string) => void;
  failVerifierTurn: (verifierAgentId: string, error: Error) => void;
  setCentral: (patch: Partial<VerifierCentralConfig>) => void;
  addSelfReport: (input: Omit<MissionControlAppendInput, "agentTitle">) => Promise<void>;
}

async function createHarness(overrides?: {
  central?: Partial<VerifierCentralConfig>;
  autoApprove?: boolean;
  readyForReview?: Array<{ agentId: string; title: string; at: string }>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "mc-verifier-"));
  const store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
  await store.initialize();
  await writeFile(join(dir, "verifier-agent.md"), VERIFIER_MD);

  const published: Array<Omit<MissionControlAppendInput, "agentTitle">> = [];
  const created: Array<{ config: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const runs: Array<{ agentId: string; prompt: string }> = [];
  const archived: string[] = [];
  const steers: Array<{ agentId: string; prompt: string }> = [];
  const proposals: VerifierProposal[] = [];
  const setReviewStateCalls: Array<{ agentId: string; state: string; options?: unknown }> = [];
  const taggedMessages: VerifierTaggedMessage[] = [];
  const liveAgents = new Map<string, ManagedAgent>();
  const timelineByAgent = new Map<string, AgentTimelineRow[]>();
  const pendingTurns = new Map<string, PendingTurn>();
  let central: VerifierCentralConfig = { ...BASE_CENTRAL_CONFIG, ...overrides?.central };
  let autoApprove = overrides?.autoApprove ?? false;
  let createAgentError: Error | null = null;
  let reviewListener: ((agentId: string, state: string) => void) | null = null;
  let proposalListener: ((proposal: VerifierProposal) => void) | null = null;
  let selfReportListener: ((event: MissionControlEvent) => void) | null = null;
  let managerListener: ((event: AgentManagerEvent) => void) | null = null;

  const dispatcher = new MissionControlVerifierDispatcher({
    logger: createTestLogger(),
    serverId: "server-1",
    hostName: "test-host",
    agentManager: {
      subscribe: (callback) => {
        managerListener = callback;
        return () => {
          managerListener = null;
        };
      },
      getAgent: (agentId) => liveAgents.get(agentId) ?? null,
      getTimelineRows: async (agentId) => timelineByAgent.get(agentId) ?? [],
      createAgent: async (config, _agentId, options) => {
        if (createAgentError) {
          throw createAgentError;
        }
        created.push({
          config: config as Record<string, unknown>,
          options: options as Record<string, unknown>,
        });
        const id = `verifier-${created.length}`;
        const agent = makeWorker(id, { "paseo.mission-control": "verifier" });
        liveAgents.set(id, agent);
        return agent;
      },
      runAgent: (agentId, prompt) =>
        new Promise<AgentRunResult>((resolve, reject) => {
          runs.push({ agentId, prompt });
          pendingTurns.set(agentId, { resolve, reject });
        }),
      archiveAgent: async (agentId) => {
        archived.push(agentId);
        return { archivedAt: new Date().toISOString() };
      },
    },
    agentStorage: { get: async () => null },
    getCentralConfig: () => central,
    subscribeReviewState: (callback) => {
      reviewListener = callback;
      return () => {
        reviewListener = null;
      };
    },
    getReadyForReview: () => overrides?.readyForReview ?? [],
    fetchEvents: (options) => store.fetchEvents(options),
    listMessageTags: () => taggedMessages,
    createProposal: async (input) => {
      const proposal: VerifierProposal = {
        id: `prop-${proposals.length + 1}`,
        status: autoApprove ? "sent" : "pending",
        ...input,
      };
      proposals.push(proposal);
      // Mirror the real approvals module: on "sent" it delivers the message
      // to the target agent before publishing the change event.
      if (proposal.status === "sent") {
        steers.push({ agentId: proposal.targetAgentId, prompt: proposal.message });
      }
      return proposal;
    },
    onProposalChange: (callback) => {
      proposalListener = callback;
      return () => {
        proposalListener = null;
      };
    },
    subscribeSelfReports: (callback) => {
      selfReportListener = callback;
      return () => {
        selfReportListener = null;
      };
    },
    setReviewState: async (agentId, state, options) => {
      setReviewStateCalls.push({ agentId, state, options });
    },
    publish: (input) => {
      published.push(input);
    },
    dispatchSteer: async (agentId, prompt) => {
      steers.push({ agentId, prompt });
    },
    agentDefinitionPath: join(dir, "verifier-agent.md"),
  });

  return {
    dir,
    store,
    dispatcher,
    published,
    created,
    get createAgentError(): Error | null {
      return createAgentError;
    },
    set createAgentError(value: Error | null) {
      createAgentError = value;
    },
    runs,
    archived,
    steers,
    proposals,
    setReviewStateCalls,
    taggedMessages,
    emitReviewState: (agentId, state) => reviewListener?.(agentId, state),
    emitSelfReport: (event) => selfReportListener?.(event),
    emitProposalChange: (proposal) => {
      // Real approvals delivers on "sent" before notifying listeners.
      if (proposal.status === "sent") {
        steers.push({ agentId: proposal.targetAgentId, prompt: proposal.message });
      }
      proposalListener?.(proposal);
    },
    emitManagerEvent: (event) => managerListener?.(event),
    setWorker: (agent) => {
      liveAgents.set(agent.id, agent);
    },
    setTimeline: (agentId, rows) => {
      timelineByAgent.set(agentId, rows);
    },
    completeVerifierTurn: (verifierAgentId) => {
      pendingTurns.get(verifierAgentId)?.resolve({
        sessionId: `session-${verifierAgentId}`,
        finalText: "",
        timeline: [],
      });
      pendingTurns.delete(verifierAgentId);
    },
    failVerifierTurn: (verifierAgentId, error) => {
      pendingTurns.get(verifierAgentId)?.reject(error);
      pendingTurns.delete(verifierAgentId);
    },
    setCentral: (patch) => {
      central = { ...central, ...patch };
    },
    addSelfReport: (input) =>
      store
        .append({
          ...input,
          agentTitle: liveAgents.get(input.agentId)?.name ?? input.agentId,
        })
        .then(() => undefined),
  };
}

async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as { appendTail: Promise<void>; persistTail: Promise<void> };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

const WAIT = { timeout: 2000 };

describe("resolveVerifierModel", () => {
  test("central override wins over roles", () => {
    expect(resolveVerifierModel({ verifier: "custom-model" }, "central-model")).toBe(
      "central-model",
    );
  });

  test("modelRoles.verifier resolves to @verifier, then @task, then host default", () => {
    expect(resolveVerifierModel({ verifier: "x/y", task: "t" }, null)).toBe("@verifier");
    expect(resolveVerifierModel({ task: "t" }, null)).toBe("@task");
    expect(resolveVerifierModel({}, null)).toBeNull();
  });
});

describe("loadVerifierAgentInstructions", () => {
  test("strips the frontmatter block and returns the instruction body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-verifier-def-"));
    const path = join(dir, "verifier.md");
    await writeFile(path, VERIFIER_MD);
    const instructions = loadVerifierAgentInstructions(path, import.meta.url);
    expect(instructions).toBe(
      "Audit the worker's evidence against the brief.\n\n- Demand missing proofs via contact_worker.\n- Never do the work.\n- Verdict via submit_verdict.",
    );
    await rm(dir, { recursive: true, force: true });
  });
});

describe("MissionControlVerifierDispatcher", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.setWorker(makeCommander());
    harness.dispatcher.start();
  });

  afterEach(async () => {
    harness.dispatcher.stop();
    await awaitStoreWrites(harness.store);
    await rm(harness.dir, { recursive: true, force: true });
  });

  test("spawns a verifier with the injected context and a closed tool surface", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.setTimeline("worker-1", [makeTimelineRow(1, "Fix the flaky test")]);
    harness.taggedMessages.push({
      messageId: "m1",
      agentIds: ["worker-1"],
      ts: "2026-01-02T00:00:00Z",
      text: "Also add a screenshot proof",
    });
    await harness.addSelfReport({
      agentId: "worker-1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Tests green",
      detail: "suite passes",
      proof: [{ kind: "url", url: "https://ci.example/run/1" }],
    });

    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    const config = harness.created[0].config;
    expect(config.provider).toBe("omp");
    expect(config.toolAllowlist).toEqual(["contact_worker", "submit_verdict"]);
    expect(config.systemPromptMode).toBe("replace");
    expect(String(config.systemPrompt)).toContain("Launch brief:");
    expect(String(config.systemPrompt)).toContain("Fix the flaky test");
    expect(String(config.systemPrompt)).toContain("Tests green — suite passes");
    expect(String(config.systemPrompt)).toContain("ci.example/run/1");
    expect(String(config.systemPrompt)).toContain("Also add a screenshot proof");
    expect(String(config.systemPrompt)).toContain("worker-1");
    expect(String(config.systemPrompt)).toContain("test-host");
    expect(String(config.systemPrompt)).toContain("Never do the work");
    expect(
      (harness.created[0].options.labels as Record<string, string>)["paseo.mission-control"],
    ).toBe("verifier");
    expect(harness.created[0].options.workspaceId).toBeUndefined();
    await vi.waitFor(() => expect(harness.runs.length).toBe(1), WAIT);
    expect(harness.runs[0].prompt).toContain("submit_verdict");
  });

  test("commander scope: only workers spawned by the Commander are verified", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    // Root agent (no parent label) is out of scope.
    harness.setWorker(makeWorker("root-1", {}));
    harness.emitReviewState("root-1", "ready");
    expect(harness.created.length).toBe(1);

    // Worker whose parent is a normal agent is out of scope.
    harness.setWorker(makeWorker("other-parent", {}));
    harness.setWorker(makeWorker("worker-2", { "paseo.parent-agent-id": "other-parent" }));
    harness.emitReviewState("worker-2", "ready");
    expect(harness.created.length).toBe(1);

    // Mission-control-labeled agents are never verified.
    harness.setWorker(makeWorker("commander-1", { "paseo.mission-control": "commander" }));
    harness.emitReviewState("commander-1", "ready");
    expect(harness.created.length).toBe(1);
  });

  test("all scope verifies a root agent", async () => {
    const allHarness = await createHarness({ central: { evaluationScope: "all" } });
    allHarness.setWorker(makeWorker("root-1", {}));
    allHarness.dispatcher.start();
    allHarness.emitReviewState("root-1", "ready");
    await vi.waitFor(() => expect(allHarness.created.length).toBe(1), WAIT);
    expect(allHarness.created[0].config.provider).toBe("omp");
    allHarness.dispatcher.stop();
    await rm(allHarness.dir, { recursive: true, force: true });
  });

  test("boot reconciliation re-enqueues persisted ready items", async () => {
    const reconHarness = await createHarness({
      readyForReview: [
        { agentId: "worker-1", title: "Unfinished audit", at: "2026-01-02T00:00:00Z" },
      ],
    });
    reconHarness.setWorker(makeCommander());
    reconHarness.setWorker(makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" }));
    reconHarness.dispatcher.start();
    await vi.waitFor(() => expect(reconHarness.created.length).toBe(1), WAIT);
    reconHarness.dispatcher.stop();
    await rm(reconHarness.dir, { recursive: true, force: true });
  });

  test("concurrency cap: one verifier at a time until the verdict releases the slot", async () => {
    harness.setCentral({ verifierConcurrency: 1 });
    const workerA = makeWorker("worker-a", { "paseo.parent-agent-id": "commander-1" });
    const workerB = makeWorker("worker-b", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(workerA);
    harness.setWorker(workerB);

    harness.emitReviewState("worker-a", "ready");
    harness.emitReviewState("worker-b", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);
    expect(harness.created[0].options.initialTitle).toContain("worker-a");

    // Verdict on worker-a's audit releases the slot; worker-b spawns next.
    await harness.dispatcher.handleSubmitVerdict("verifier-1", {
      result: "done",
      summary: "All proofs present",
    });
    await vi.waitFor(() => expect(harness.created.length).toBe(2), WAIT);
    expect(harness.created[1].options.initialTitle).toContain("worker-b");
  });

  test("verdict done marks the item via the lifecycle API and archives the session", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    const result = await harness.dispatcher.handleSubmitVerdict("verifier-1", {
      result: "done",
      summary: "Proofs match the brief",
    });
    expect(result.isError).toBeUndefined();
    expect(harness.setReviewStateCalls).toEqual([
      {
        agentId: "worker-1",
        state: "done",
        options: {
          verdict: {
            by: "verifier",
            summary: "Proofs match the brief",
            at: expect.any(String),
          },
        },
      },
    ]);
    // The turn completing after the verdict triggers the session archive.
    harness.completeVerifierTurn("verifier-1");
    await vi.waitFor(() => expect(harness.archived).toContain("verifier-1"), WAIT);
    // A second verdict for the same session is rejected (session closed).
    await expect(
      harness.dispatcher.handleSubmitVerdict("verifier-1", { result: "done", summary: "again" }),
    ).resolves.toMatchObject({ isError: true });
  });

  test("retry once then Needs-you when the verifier finishes without a verdict", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    harness.completeVerifierTurn("verifier-1");
    await vi.waitFor(() => expect(harness.created.length).toBe(2), WAIT);
    harness.completeVerifierTurn("verifier-2");
    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0]).toMatchObject({
      agentId: "worker-1",
      kind: "blocked",
      source: "system",
      severity: "blocker",
      headline: "Verification failed — needs your review",
    });
    // The item stays ready for a later retry; no third attempt in this lifetime.
    expect(harness.created.length).toBe(2);
  });

  test("retry once then Needs-you when the verifier run fails", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    harness.failVerifierTurn("verifier-1", new Error("provider died"));
    await vi.waitFor(() => expect(harness.created.length).toBe(2), WAIT);
    harness.failVerifierTurn("verifier-2", new Error("provider died"));
    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0].detail).toContain("provider died");
  });

  test("retry once then Needs-you when the spawn itself fails", async () => {
    harness.createAgentError = new Error("omp unavailable");
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.published.length).toBe(1), WAIT);
    expect(harness.published[0]).toMatchObject({
      kind: "blocked",
      severity: "blocker",
      headline: "Verification failed — needs your review",
    });
    expect(harness.published[0].detail).toContain("omp unavailable");
    expect(harness.runs.length).toBe(0);
  });

  test("contact_worker routes through the approval gate and relays the worker reply back", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    const contactResult = await harness.dispatcher.handleContactWorker(
      "verifier-1",
      "Please attach the screenshot of the passing build.",
    );
    expect(contactResult.isError).toBeUndefined();
    expect(harness.proposals).toHaveLength(1);
    expect(harness.proposals[0]).toMatchObject({
      origin: "verifier",
      targetAgentId: "worker-1",
      deliveryMode: "steer",
      reason: "Verifier clarification request",
      classification: "normal",
    });

    // Ask-mode approval resolves the proposal; the steer goes out with the
    // reply marker and the relay arms.
    harness.emitProposalChange({ ...harness.proposals[0], status: "sent" });
    await vi.waitFor(() => expect(harness.steers.length).toBe(1), WAIT);
    expect(harness.steers[0].agentId).toBe("worker-1");
    expect(harness.steers[0].prompt).toContain("Please attach the screenshot");
    expect(harness.steers[0].prompt).toContain("paseo-verifier-contact");
    expect(harness.steers[0].prompt).toContain("relayed back to the verifier");

    // The worker's next report_status is relayed into the waiting verifier.
    const reply = await harness.store.append({
      agentId: "worker-1",
      agentTitle: "Name-worker-1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Screenshot attached",
      detail: "build.png",
    });
    harness.emitSelfReport(reply);
    await vi.waitFor(() => expect(harness.runs.length).toBe(2), WAIT);
    expect(harness.runs[1].agentId).toBe("verifier-1");
    expect(harness.runs[1].prompt).toContain("Screenshot attached");

    // The verifier re-audits and verdicts done.
    await harness.dispatcher.handleSubmitVerdict("verifier-1", {
      result: "done",
      summary: "Proof now present",
    });
    expect(harness.setReviewStateCalls[0]).toMatchObject({ agentId: "worker-1", state: "done" });
  });

  test("auto mode short-circuits: a sent proposal steers immediately without a change event", async () => {
    const autoHarness = await createHarness({ autoApprove: true });
    autoHarness.setWorker(makeCommander());
    autoHarness.setWorker(makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" }));
    autoHarness.dispatcher.start();
    autoHarness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(autoHarness.created.length).toBe(1), WAIT);

    const result = await autoHarness.dispatcher.handleContactWorker("verifier-1", "send proof now");
    expect(result.isError).toBeUndefined();
    expect(autoHarness.proposals[0].status).toBe("sent");
    await vi.waitFor(() => expect(autoHarness.steers.length).toBe(1), WAIT);
    expect(autoHarness.steers[0].prompt).toContain("send proof now");
    autoHarness.dispatcher.stop();
    await rm(autoHarness.dir, { recursive: true, force: true });
  });

  test("insufficient verdict without contact creates the proof-demand proposal", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    await harness.dispatcher.handleSubmitVerdict("verifier-1", {
      result: "insufficient",
      summary: "No screenshot proof for the UI claim",
    });
    expect(harness.proposals).toHaveLength(1);
    expect(harness.proposals[0]).toMatchObject({
      origin: "verifier",
      targetAgentId: "worker-1",
      reason: "Verifier proof demand",
    });
    expect(harness.proposals[0].message).toContain("No screenshot proof for the UI claim");
    // The item is not marked done and no Needs-you card is posted.
    expect(harness.setReviewStateCalls).toEqual([]);
    expect(harness.published).toEqual([]);
  });

  test("a turn ending while a proposal is pending does not fail the run", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    await harness.dispatcher.handleContactWorker("verifier-1", "more proof please");
    harness.completeVerifierTurn("verifier-1");
    // No retry, no Needs-you: the exchange is still in flight.
    expect(harness.published).toEqual([]);
    expect(harness.created.length).toBe(1);
  });

  test("denied proposal relays the denial back to the verifier", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    await harness.dispatcher.handleContactWorker("verifier-1", "more proof please");
    harness.emitProposalChange({ ...harness.proposals[0], status: "denied" });
    await vi.waitFor(() => expect(harness.runs.length).toBe(2), WAIT);
    expect(harness.runs[1].prompt).toContain("denied by the user");
    expect(harness.steers).toEqual([]);
  });

  test("user marking done while verifying cancels the run without retry or card", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    harness.emitReviewState("worker-1", "done");
    await vi.waitFor(() => expect(harness.archived).toContain("verifier-1"), WAIT);
    expect(harness.published).toEqual([]);
    expect(harness.created.length).toBe(1);
    expect(harness.runs.length).toBe(1);
  });

  test("worker reply via final turn text is relayed and the relay disarms", async () => {
    const worker = makeWorker("worker-1", { "paseo.parent-agent-id": "commander-1" });
    harness.setWorker(worker);
    harness.emitReviewState("worker-1", "ready");
    await vi.waitFor(() => expect(harness.created.length).toBe(1), WAIT);

    await harness.dispatcher.handleContactWorker("verifier-1", "prove it");
    harness.emitProposalChange({ ...harness.proposals[0], status: "sent" });
    await vi.waitFor(() => expect(harness.steers.length).toBe(1), WAIT);

    // The worker's reply turn streams text, then completes.
    harness.emitManagerEvent({
      type: "agent_stream",
      agentId: "worker-1",
      event: {
        type: "timeline",
        item: { type: "assistant_message", text: "proof line one" },
        provider: "omp",
      },
    });
    harness.emitManagerEvent({
      type: "agent_stream",
      agentId: "worker-1",
      event: {
        type: "timeline",
        item: { type: "assistant_message", text: "proof line two" },
        provider: "omp",
      },
    });
    harness.emitManagerEvent({
      type: "agent_stream",
      agentId: "worker-1",
      event: { type: "turn_completed", provider: "omp" },
    });
    await vi.waitFor(() => expect(harness.runs.length).toBe(2), WAIT);
    expect(harness.runs[1].prompt).toContain("proof line one");
    expect(harness.runs[1].prompt).toContain("proof line two");

    // A later self-report no longer relays (relay disarmed).
    const late = await harness.store.append({
      agentId: "worker-1",
      agentTitle: "Name-worker-1",
      kind: "milestone",
      source: "self",
      severity: "info",
      headline: "Late report",
    });
    harness.emitSelfReport(late);
    expect(harness.runs.length).toBe(2);
  });
});

describe("paseo-tools verifier tool registration", () => {
  test("contact_worker and submit_verdict exist only for verifier-labeled callers", async () => {
    const live = new Map<string, ManagedAgent>();
    const agentManager = {
      getAgent: (id: string) => live.get(id) ?? null,
    } as unknown as PaseoToolHostDependencies["agentManager"];
    const handleContactWorker = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const handleSubmitVerdict = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const verifierDispatcher = {
      isVerifierAgent: (id: string) =>
        live.get(id)?.labels?.["paseo.mission-control"] === "verifier",
      handleContactWorker,
      handleSubmitVerdict,
    } as unknown as MissionControlVerifierDispatcher;

    const base = {
      agentManager,
      agentStorage: { get: async () => null },
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      logger: createTestLogger(),
      verifierDispatcher,
    } as unknown as PaseoToolHostDependencies;

    // Non-verifier caller: the tools are not registered.
    live.set("worker-1", makeWorker("worker-1", {}));
    const plainCatalog = createPaseoToolCatalog({ ...base, callerAgentId: "worker-1" });
    expect(plainCatalog.getTool("contact_worker")).toBeUndefined();
    expect(plainCatalog.getTool("submit_verdict")).toBeUndefined();

    // Verifier caller: the tools are registered and delegate to the dispatcher.
    live.set("verifier-1", makeWorker("verifier-1", { "paseo.mission-control": "verifier" }));
    const verifierCatalog = createPaseoToolCatalog({ ...base, callerAgentId: "verifier-1" });
    expect(verifierCatalog.getTool("contact_worker")).toBeDefined();
    expect(verifierCatalog.getTool("submit_verdict")).toBeDefined();

    await verifierCatalog.executeTool("contact_worker", { message: "proof please" });
    expect(handleContactWorker).toHaveBeenCalledWith("verifier-1", "proof please");
    await verifierCatalog.executeTool("submit_verdict", { result: "done", summary: "All good" });
    expect(handleSubmitVerdict).toHaveBeenCalledWith("verifier-1", {
      result: "done",
      summary: "All good",
    });

    // Input validation rejects an unknown verdict result.
    await expect(
      verifierCatalog.executeTool("submit_verdict", { result: "maybe", summary: "x" }),
    ).rejects.toThrow();
  });
});
