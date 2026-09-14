// Layer 3 scenario 2 — status by name (spec 08).
// resolve → fleet_agent_status → answer carries title + last report; no ids
// spoken. The last-report half rides a REAL agent's self-report (deepseek v4
// flash) when the provider snapshot has one; with fake providers the
// sub-assertion is noted and skipped (report machinery is real-agent
// behavior).
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  hasNoSpokenIds,
  waitForEvent,
} from "./harness.mjs";

export const name = "status-by-name";

const REPORT_HEADLINE = "Deployed the fix";

/** The answer must carry the agent's last report as RETURNED by the
 * fleet_agent_status tool in this session (the report the model actually
 * saw). When the model asks fresh:true the status-ask steer supersedes the
 * stored headline — the fresh report is the new last report, so demanding the
 * stored "Deployed the fix" verbatim is wrong on that path (run-1: the model
 * faithfully relayed the fresh "Standing by; awaiting next instruction" and
 * failed). Match is on distinctive headline words (models paraphrase). */
function assertLastReportCarried(answer, statusCalls, evidence, failures, notes, log) {
  const statusResult = [...statusCalls].toReversed().find((c) => c.summary) ?? statusCalls.at(-1);
  const lastReport = statusResult?.summary
    ? /last report:\s*([^.]+)/i.exec(statusResult.summary)?.[1]?.trim()
    : null;
  if (!lastReport) {
    failures.push("fleet_agent_status result carried no last report headline");
    return;
  }
  const distinctive = lastReport
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 4);
  const carried = distinctive.some((word) => answer.toLowerCase().includes(word));
  evidence.push({
    kind: "last-report-carried",
    headline: lastReport,
    storedHeadline: REPORT_HEADLINE,
  });
  if (carried) {
    log(`last report carried: "${lastReport}"`);
  } else {
    failures.push(
      `spoken answer does not carry the last report headline: "${answer}" (tool returned "${lastReport}")`,
    );
  }
  if (!new RegExp(REPORT_HEADLINE, "i").test(lastReport)) {
    notes.push(
      `fresh status-ask superseded the stored report; tool surfaced "${lastReport}" instead`,
    );
  }
}

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];
  const notes = [];

  // --- Setup: an agent with a self-report on record.
  let zoeId = null;
  let zoeTitle = "Zoe Report";
  if (ctx.providerMode === "real" && ctx.deepseekModelId) {
    try {
      const created = await client.createAgent({
        provider: "omp",
        model: ctx.deepseekModelId,
        cwd: ctx.seed.seedDir,
        title: zoeTitle,
        initialPrompt: "You are a status-reporting worker.",
        modeId: "full",
      });
      zoeId = created.id;
      log(`real agent created: ${zoeId}`);
      // Trigger a real report_status via a steer-style prompt.
      const reportEventPromise = waitForEvent(
        client,
        (event) => event.source === "self" && event.agentId === zoeId,
        { timeoutMs: 180_000 },
      );
      await client.sendMessage(
        zoeId,
        `Post a one-line report_status now with headline "${REPORT_HEADLINE}" and a short description, then stop.`,
      );
      try {
        const reportEvent = await reportEventPromise;
        evidence.push({
          kind: "self-report-event",
          headline: reportEvent.headline,
          ts: reportEvent.ts,
        });
        log(`self-report landed: ${reportEvent.headline}`);
      } catch (error) {
        notes.push(`self-report did not land: ${error.message}`);
        log(`self-report missing: ${error.message}`);
      }
    } catch (error) {
      notes.push(`real agent setup failed (${error.message}) — status still checked`);
      log(`real agent setup failed: ${error.message}`);
    }
  } else {
    const created = await client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: ctx.seed.seedDir,
      title: zoeTitle,
      initialPrompt: "You are a status-reporting worker.",
      modeId: "full-access",
    });
    zoeId = created.id;
    notes.push("fake provider: no self-report machinery — last-report sub-assertion skipped");
    log("fake provider mode — no self-report sub-assertion");
  }

  // --- Session: ask about the agent by spoken name.
  const browser = await openSession(ctx.voicePort);
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  try {
    const from0 = browser.frames.length;
    await speak(browser.ws, `How is ${zoeTitle} doing?`);
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "status answer",
    });
    log(`ANSWER: ${answer}`);
    evidence.push({ kind: "spoken", text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");
    if (!new RegExp(`zoe`, "i").test(answer)) {
      failures.push(`spoken answer does not carry the agent title: "${answer}"`);
    }

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    const calls = toolCallsFromJsonl(rows);

    const statusCalls = calls.filter((c) => c.name === "fleet_agent_status");
    if (statusCalls.length === 0) {
      failures.push("no fleet_agent_status call");
    } else {
      for (const call of statusCalls) {
        if (call.args.agentId !== zoeId) {
          failures.push(
            `fleet_agent_status called with wrong id ${call.args.agentId} (expected ${zoeId})`,
          );
        }
        if (call.ok === false) failures.push(`fleet_agent_status failed: ${call.error}`);
      }
    }
    if (ctx.providerMode === "real" && statusCalls.length > 0) {
      assertLastReportCarried(answer, statusCalls, evidence, failures, notes, log);
    }

    // Resolve-first: the model must have resolved the spoken name to the id
    // via a fleet tool BEFORE calling fleet_agent_status.
    const resolveCalls = calls.filter(
      (c) =>
        c.name === "fleet_list_agents" ||
        c.name === "fleet_list_inventory" ||
        c.name === "fleet_search",
    );
    const firstStatusTs = statusCalls[0]?.ts;
    const resolveBefore = resolveCalls.some((c) => !firstStatusTs || c.ts <= firstStatusTs);
    if (resolveCalls.length === 0) {
      failures.push(
        "no resolve call (fleet_list_agents/inventory/search) before fleet_agent_status",
      );
    } else if (!resolveBefore) {
      failures.push("fleet_agent_status called without a prior resolve call");
    }
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
  }

  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      notes,
      statusArgs: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_agent_status")
            .map((c) => c.args)
        : [],
      providerMode: ctx.providerMode,
    },
    evidence,
  };
}
