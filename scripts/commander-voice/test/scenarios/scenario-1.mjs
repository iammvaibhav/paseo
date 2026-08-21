// Layer 3 scenario 1 — needs-me count (spec 08).
// Spoken answer matches data.bucket counts; no invented status filters;
// filtered-empty phrasing correct.
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  waitForBucket,
  agentByTitle,
  digestForAgents,
  parseSpokenNeedsYou,
  hasNoSpokenIds,
  FLEET_STATUSES,
  FLEET_BUCKETS,
} from "./harness.mjs";

export const name = "needs-me-count";

async function createAgent(ctx, { title }) {
  const created = await ctx.client.createAgent({
    provider: "claude",
    model: "haiku",
    cwd: ctx.seed.seedDir,
    title,
    initialPrompt: "Scenario worker.",
    modeId: "full-access",
  });
  return created;
}

async function seedErrorAgent(ctx, failures, log) {
  const errorAgent = await createAgent(ctx, { title: "Needs Me One" });
  await ctx.client.sendMessage(errorAgent.id, "emit a turn failure");
  const roster = await waitForBucket(
    ctx.client,
    (agents) => agentByTitle(agents, "Needs Me One")?.bucket === "needs_you",
  );
  if (!roster) {
    failures.push("error agent never reached bucket needs_you");
  } else {
    log("error agent bucket: needs_you");
  }
}

async function seedProposalAgent(ctx, failures, log) {
  const proposalAgent = await createAgent(ctx, { title: "Needs Me Two" });
  const sendResult = await ctx.client.missionControlToolsExecute({
    name: "fleet_send_prompt",
    args: {
      host: "local",
      agentId: proposalAgent.id,
      prompt: "Stand by for a directive.",
      mode: "steer",
    },
  });
  if (!sendResult.ok) {
    failures.push(`pending proposal failed: ${sendResult.error}`);
  }
  const roster = await waitForBucket(
    ctx.client,
    (agents) => agentByTitle(agents, "Needs Me Two")?.bucket === "needs_you",
  );
  if (!roster) {
    failures.push("proposal-target agent never reached bucket needs_you");
  } else {
    log("proposal agent bucket: needs_you");
  }
}

// NOTE: the filtered-empty question must target a bucket that is guaranteed
// EMPTY in this fleet. "ready" is never empty — the seeded roster agents sit
// idle (bucket ready), and models legitimately map "ready for review" to the
// ready bucket (the run-1 failure: "Two agents are ready for review: Ada
// Lovelace and Keen Heisenberg" was factually correct, just not empty).
// "running" is empty here: every agent is idle/closed at question time, so
// the model's natural statuses:["running"] filter returns zero rows and the
// none/zero phrasing assertion holds.

function assertValidFilters(calls, failures) {
  for (const call of calls) {
    const statuses = Array.isArray(call.args.statuses) ? call.args.statuses : [];
    for (const status of statuses) {
      if (!FLEET_STATUSES.includes(status)) {
        failures.push(`invented status filter "${status}" used`);
      }
    }
    if (call.args.bucket && !FLEET_BUCKETS.includes(call.args.bucket)) {
      failures.push(`invented bucket filter "${call.args.bucket}" used`);
    }
  }
}

/** Ask one question; assert the spoken needs-you count equals the digest
 * the model received (recomputed from the catalog at call time). */
async function askNeedsMe(ctx, browser, failures, log, evidence) {
  const from = browser.frames.length;
  await speak(browser.ws, "What needs my attention right now?");
  const answer = await waitForSettledAnswer(browser, { fromIndex: from, label: "needs-me answer" });
  log(`ANSWER1: ${answer}`);
  evidence.push({ kind: "spoken", turn: 1, text: answer });
  if (!hasNoSpokenIds(answer)) failures.push("answer1 contains a raw fleet id");

  const rows = await readJsonl(await snapshotSessionJsonl(ctx.sessionLogDir, ctx.sessionEvidence));
  const calls = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_list_agents");
  if (calls.length === 0) {
    failures.push("no fleet_list_agents call in session");
    return;
  }
  assertValidFilters(calls, failures);

  // The count basis is the fleet_list_agents call that carried a bucket
  // filter (the needs-you digest the model counted from). A probe call with
  // statuses:["error"] (same-turn validation) returns a different row set —
  // recomputing from the LAST call of any kind made the count flaky.
  const basis =
    [...calls].toReversed().find((c) => typeof c.args?.bucket === "string") ?? calls.at(-1);
  const recomputed = await ctx.client.missionControlToolsExecute({
    name: "fleet_list_agents",
    args: basis.args ?? {},
  });
  const digest = digestForAgents(recomputed.structuredContent?.agents ?? []);
  evidence.push({ kind: "digest", spoken: digest.spoken, data: digest.data });
  const expected = (digest.data.agents ?? []).filter((a) => a.bucket === "needs_you").length;
  const spokenCount = parseSpokenNeedsYou(answer);
  log(`digest: ${digest.spoken}`);
  log(`expected needs_you=${expected}, spoken count=${spokenCount}`);
  if (spokenCount === null) {
    failures.push("spoken answer does not state a needs-you count");
  } else if (spokenCount !== expected) {
    failures.push(`spoken needs-you count ${spokenCount} != data.bucket count ${expected}`);
  }
}

async function askFilteredEmpty(ctx, browser, failures, evidence) {
  // Archive ready-bucket seed agents so the ready bucket is guaranteed empty
  // for the filtered-empty check (the pre-cached "Are any agents ready for review?"
  // audio is streamed directly from disk with zero TTS quota).
  const agents = (await ctx.client.fetchAgents({})).entries.map((e) => e.agent);
  for (const a of agents) {
    if (a.title === "Ada Lovelace" || a.title === "Keen Heisenberg") {
      await ctx.client.archiveAgent(a.id).catch(() => undefined);
    }
  }

  const from = browser.frames.length;
  await speak(browser.ws, "Are any agents ready for review?");
  const answer = await waitForSettledAnswer(browser, {
    fromIndex: from,
    label: "filtered-empty answer",
  });
  evidence.push({ kind: "spoken", turn: 2, text: answer });
  if (!/(no|none|zero|not|don'?t|nothing|nobody)/.test(answer.toLowerCase())) {
    failures.push(`filtered-empty phrasing missing a none/zero answer: "${answer}"`);
  }
  if (!hasNoSpokenIds(answer)) failures.push("answer2 contains a raw fleet id");

  const rows = await readJsonl(await snapshotSessionJsonl(ctx.sessionLogDir, ctx.sessionEvidence));
  assertValidFilters(
    toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_list_agents"),
    failures,
  );
}

export async function run(ctx) {
  const { log } = ctx;
  const evidence = [];
  const failures = [];
  ctx.sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);

  await seedErrorAgent(ctx, failures, log);
  await seedProposalAgent(ctx, failures, log);

  const browser = await openSession(ctx.voicePort);
  try {
    await askNeedsMe(ctx, browser, failures, log, evidence);
    await askFilteredEmpty(ctx, browser, failures, evidence);
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, ctx.sessionEvidence);
    // Ensure seed agent Ada Lovelace is active for subsequent scenarios (S7, S9).
    const existing = (await ctx.client.fetchAgents({})).entries.map((e) => e.agent);
    if (!existing.some((a) => a.title === "Ada Lovelace")) {
      await ctx.client.createAgent({
        provider: "claude",
        model: "haiku",
        cwd: ctx.seed.seedDir,
        title: "Ada Lovelace",
        initialPrompt: "Seed worker two. Stay idle.",
        modeId: "full-access",
      });
    }
  }

  const rows = await readJsonl(ctx.sessionEvidence);
  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      toolCalls: toolCallsFromJsonl(rows)
        .filter((c) => c.name === "fleet_list_agents")
        .map((c) => c.args),
      providerMode: ctx.providerMode,
    },
    evidence,
  };
}
