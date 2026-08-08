import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { MissionControlStore } from "./store.js";

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

function proposal(overrides: Partial<MissionControlProposal> = {}): MissionControlProposal {
  return {
    id: "mcp_test",
    createdAt: new Date().toISOString(),
    origin: "stall",
    serverId: "server-1",
    targetAgentId: "agent-1",
    message: "Post a one-line report_status, then continue.",
    deliveryMode: "steer",
    reason: "silent",
    classification: "normal",
    status: "pending",
    ...overrides,
  };
}

describe("MissionControlStore v3 review lifecycle", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-store-v3-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  test("defaults to reviewState none with empty verdict", () => {
    expect(store.getReviewState("agent-1")).toEqual({
      reviewState: "none",
      doneAt: null,
      clearedAt: null,
      verdict: null,
    });
  });

  test("done persists doneAt + verdict; clear keeps doneAt and sets clearedAt", async () => {
    const verdict = { by: "verifier" as const, summary: "Proofs match the brief", at: "t1" };
    await store.setReviewState("agent-1", "done", { verdict });
    const done = store.getReviewState("agent-1");
    expect(done.reviewState).toBe("done");
    expect(done.doneAt).not.toBeNull();
    expect(done.verdict).toEqual(verdict);

    await store.setReviewState("agent-1", "cleared");
    const cleared = store.getReviewState("agent-1");
    expect(cleared.reviewState).toBe("cleared");
    expect(cleared.clearedAt).not.toBeNull();
    expect(cleared.verdict).toEqual(verdict);
  });

  test("reopen resets to none so the next run re-enters the lifecycle", async () => {
    await store.setReviewState("agent-1", "done", {
      verdict: { by: "user", summary: "Marked done", at: "t1" },
    });
    await store.setReviewState("agent-1", "none");
    expect(store.getReviewState("agent-1")).toEqual({
      reviewState: "none",
      doneAt: null,
      clearedAt: null,
      verdict: null,
    });
  });

  test("review state round-trips across a store reload (persisted snapshot)", async () => {
    await store.setReviewState("agent-1", "done", {
      verdict: { by: "verifier", summary: "Approved", at: "t1" },
    });
    await store.setReviewState("agent-2", "ready");
    await awaitStoreWrites(store);

    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getReviewState("agent-1")).toEqual({
      reviewState: "done",
      doneAt: expect.any(String),
      clearedAt: null,
      verdict: { by: "verifier", summary: "Approved", at: "t1" },
    });
    expect(reloaded.getReviewState("agent-2").reviewState).toBe("ready");
    expect(reloaded.getReadyForReview()).toEqual(["agent-2"]);
  });

  test("ready accrues only from rollout onward; pre-rollout agents derive dormant", async () => {
    // Seed an event older than the store's rollout marker by writing the
    // events file directly before first initialize: the first boot sets the
    // rollout timestamp to now, so the backdated event is pre-rollout.
    const preRollout = {
      id: "mce_old",
      ts: new Date(Date.now() - 60_000).toISOString(),
      agentId: "old-agent",
      agentTitle: "Old",
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    };
    await mkdir(join(dir, "mission-control"), { recursive: true });
    await writeFile(
      join(dir, "mission-control", "events.jsonl"),
      `${JSON.stringify(preRollout)}\n`,
      "utf8",
    );
    const seeded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await seeded.initialize();
    await seeded.append({
      agentId: "new-agent",
      agentTitle: "New",
      kind: "started",
      source: "system",
      severity: "info",
      headline: "Started",
    });
    // Drain the seeded store's write tail; the outer afterEach only drains
    // the shared `store` instance, and a pending appendFile would make the
    // temp dir removal fail with ENOTEMPTY.
    await awaitStoreWrites(seeded);
    expect(seeded.isDormant("old-agent")).toBe(true);
    expect(seeded.isDormant("new-agent")).toBe(false);
    await awaitStoreWrites(seeded);
  });
});

describe("MissionControlStore v3 proposals", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-store-proposals-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  test("putProposal + getProposal round-trip", async () => {
    await store.putProposal(proposal());
    expect(store.getProposal("mcp_test")).toMatchObject({
      id: "mcp_test",
      targetAgentId: "agent-1",
      status: "pending",
    });
  });

  test("proposal status updates persist across a store reload (JSONL last-wins)", async () => {
    await store.putProposal(proposal({ id: "mcp_1", status: "pending" }));
    await store.putProposal(proposal({ id: "mcp_1", status: "sent" }));
    await awaitStoreWrites(store);

    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getProposal("mcp_1")?.status).toBe("sent");
    expect(reloaded.listProposals()).toHaveLength(1);
  });

  test("expireProposals flips pending older than the TTL to expired", async () => {
    const old = proposal({
      id: "mcp_old",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = proposal({
      id: "mcp_fresh",
      createdAt: new Date().toISOString(),
    });
    await store.putProposal(old);
    await store.putProposal(fresh);
    const expired = await store.expireProposals(Date.now(), 24 * 60 * 60 * 1000);
    expect(expired.map((p) => p.id)).toEqual(["mcp_old"]);
    expect(store.getProposal("mcp_old")?.status).toBe("expired");
    expect(store.getProposal("mcp_fresh")?.status).toBe("pending");
  });

  test("proposal events supersede in place per proposal id", async () => {
    const first = await store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "proposal",
      source: "system",
      severity: "blocker",
      headline: "Proposal (stall): silent",
      detail: "message",
      proposal: proposal({ id: "mcp_sup", status: "pending" }),
    });
    const second = await store.append({
      agentId: "agent-1",
      agentTitle: "Agent 1",
      kind: "proposal",
      source: "system",
      severity: "info",
      headline: "Proposal sent",
      detail: "message",
      proposal: proposal({ id: "mcp_sup", status: "sent" }),
    });
    expect(second.supersedesId).toBe(first.id);
    // Default fetch hides the superseded card.
    const events = store.fetchEvents();
    expect(events.find((event) => event.id === first.id)).toBeUndefined();
    expect(events.find((event) => event.id === second.id)).toBeDefined();
  });
});

describe("MissionControlStore v3 cursor paging + message tags", () => {
  let dir: string;
  let store: MissionControlStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-store-seq-"));
    store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
  });

  afterEach(async () => {
    await awaitStoreWrites(store);
    await rm(dir, { recursive: true, force: true });
  });

  test("events carry monotonic seq and beforeSeq pages strictly older events", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const event = await store.append({
        agentId: `agent-${index}`,
        agentTitle: `Agent ${index}`,
        kind: "milestone",
        source: "self",
        severity: "info",
        headline: `Report ${index}`,
      });
      ids.push(event.id);
    }
    const page = store.fetchEvents({ limit: 2, beforeSeq: 10_000 });
    expect(page).toHaveLength(2);
    // Strictly older: the cursor excludes the event at/after the boundary.
    const boundary = store.fetchEvents({ limit: 1, beforeSeq: page[1].seq! + 1 });
    expect(boundary[0].id).toBe(page[1].id);
    expect(store.fetchEvents({ beforeSeq: page[1].seq! })).toHaveLength(3);
  });

  test("message tags round-trip and reload from JSONL", async () => {
    store.recordMessageTags({
      messageId: "msg-1",
      agentIds: ["agent-1", "agent-2"],
      ts: "t1",
      text: "Tag both workers",
    });
    await awaitStoreWrites(store);

    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getMessageTags("msg-1")).toEqual({
      messageId: "msg-1",
      agentIds: ["agent-1", "agent-2"],
      ts: "t1",
      text: "Tag both workers",
    });
  });

  test("stop origins round-trip across reload", async () => {
    store.recordStopOrigin("agent-1", "user");
    store.recordStopOrigin("agent-3", "system");
    await awaitStoreWrites(store);
    const reloaded = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.getStopOrigin("agent-1")).toBe("user");
    expect(reloaded.getStopOrigin("agent-3")).toBe("system");
    expect(reloaded.getStopOrigin("agent-2")).toBeNull();
  });

  test("review-state.json is written atomically", async () => {
    await store.setReviewState("agent-1", "done");
    await awaitStoreWrites(store);
    const raw = await readFile(join(dir, "mission-control", "review-state.json"), "utf-8");
    expect(JSON.parse(raw)).toMatchObject({ "agent-1": { reviewState: "done" } });
  });
});
