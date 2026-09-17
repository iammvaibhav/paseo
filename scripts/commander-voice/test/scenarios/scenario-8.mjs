// Layer 3 scenario 8 — monitor announce (spec 08).
// Start a fleet monitor; finish an agent while the conversation continues →
// the announce is injected between turns (browser "injected" frame with the
// agent id) and the ongoing conversation is NOT blocked.
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  waitForFrame,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  hasNoSpokenIds,
  pollJsonl,
} from "./harness.mjs";

export const name = "monitor-announce";

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];

  // --- Setup: a fake agent whose run will complete (finished event).
  const created = await client.createAgent({
    provider: "claude",
    model: "haiku",
    cwd: ctx.seed.seedDir,
    title: "Mona Lisa",
    initialPrompt: "I finish quickly.",
    modeId: "full-access",
  });
  const monaId = created.id;

  const browser = await openSession(ctx.voicePort);
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  try {
    // 1) Start the fleet monitor.
    const from0 = browser.frames.length;
    await speak(browser.ws, "Watch the whole fleet and tell me when an agent finishes.");
    await waitForSettledAnswer(browser, { fromIndex: from0, label: "monitor confirmation" });
    await pollJsonl(
      ctx.sessionLogDir,
      (r) =>
        toolCallsFromJsonl(r).some(
          (c) =>
            c.name === "fleet_monitor" && c.args.action === "start" && c.args.scope === "fleet",
        ),
      { timeoutMs: 120_000 },
    );
    const sessionPath1 = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    rows = await readJsonl(sessionPath1);
    const monitorCalls = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_monitor");
    if (!monitorCalls.some((c) => c.args.action === "start" && c.args.scope === "fleet")) {
      failures.push("fleet_monitor start/scope-fleet never called");
    } else {
      log("fleet monitor started");
    }

    // Give the announce engine time to reconcile the subscription.
    await new Promise((r) => setTimeout(r, 1500));

    // 2) Ask a question (conversation in flight), then trigger the finish
    //    while the model is working.
    // The announce engine broadcasts finished events for ANY agent in a
    // fleet watch; match Mona Lisa's finished event specifically so an
    // unrelated finish (e.g. late outcome from an earlier scenario) does
    // not consume this waiter.
    const injectedPromise = waitForFrame(
      browser,
      (m) => m.type === "injected" && m.event?.kind === "finished" && m.event?.agentId === monaId,
      "finished announce injected for Mona Lisa",
      120_000,
    );
    const from1 = browser.frames.length;
    await speak(browser.ws, "What is the fleet status?");
    await new Promise((r) => setTimeout(r, 1500));
    // The fake run completes in ~1s → daemon emits a finished event → the
    // voice node injects the announce into the live session.
    await client.sendMessage(monaId, "hello there");
    const injected = await injectedPromise;
    log(`injected: ${injected.event.kind} agentId=${injected.event.agentId}`);
    evidence.push({ kind: "injected", event: injected.event });
    if (injected.event.agentId !== monaId) {
      failures.push(`announce agentId ${injected.event.agentId} != ${monaId}`);
    }

    // 3) The in-flight conversation continues: the status answer completes
    //    AFTER the injection, and a follow-up question is still answered.
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from1,
      label: "status answer",
    });
    log(`ANSWER (post-announce): ${answer}`);
    evidence.push({ kind: "spoken", text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");
    if (answer.trim().length === 0) failures.push("empty spoken answer after announce");

    const from2 = browser.frames.length;
    await speak(browser.ws, "Thanks. How many agents need me right now?");
    const followUp = await waitForSettledAnswer(browser, {
      fromIndex: from2,
      label: "follow-up answer",
    });
    log(`FOLLOW-UP: ${followUp}`);
    evidence.push({ kind: "spoken", text: followUp });
    if (followUp.trim().length === 0)
      failures.push("empty follow-up answer (conversation blocked)");

    const sessionPath2 = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath2 });
    rows = await readJsonl(sessionPath2);
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
  }

  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      monitorCalls: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_monitor")
            .map((c) => c.args)
        : [],
    },
    evidence,
  };
}
