// Layer 3 scenario 7 — multi-intent utterance (spec 08).
// One utterance: spawn X + status Y + monitor Z → the voice instruction
// ledger opens row(s); all three tool intents execute with results (nothing
// dropped); the rows close by citing cards.
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  waitForRoster,
  agentByTitle,
  hasNoSpokenIds,
  sameTitle,
  waitForEvent,
  approveProposal,
  pollJsonl,
} from "./harness.mjs";

export const name = "multi-intent-utterance";
function assertMultiIntentToolCalls(calls, workspaceId, adaId, failures) {
  const createCalls = calls.filter((c) => c.name === "fleet_create_agent");
  if (createCalls.length === 0) {
    failures.push("no fleet_create_agent call (spawn intent dropped)");
  } else if (createCalls[0].args.workspaceId !== workspaceId) {
    failures.push(`spawn workspaceId ${createCalls[0].args.workspaceId} != ${workspaceId}`);
  }

  const statusCalls = calls.filter((c) => c.name === "fleet_agent_status");
  if (statusCalls.length === 0) {
    failures.push("no fleet_agent_status call (status intent dropped)");
  } else if (statusCalls[0].args.agentId !== adaId) {
    failures.push(`status called for ${statusCalls[0].args.agentId} != Ada ${adaId}`);
  }

  const monitorCalls = calls.filter((c) => c.name === "fleet_monitor");
  if (monitorCalls.length === 0) {
    failures.push("no fleet_monitor call (monitor intent dropped)");
  } else {
    const start = monitorCalls.find((c) => c.args.action === "start");
    if (!start) {
      failures.push("fleet_monitor never called with action start");
    } else if (start.args.scope !== "fleet") {
      failures.push(`fleet_monitor scope ${start.args.scope} != fleet`);
    }
  }

  const missingResults = calls.filter((c) => c.ok === null);
  if (missingResults.length > 0) {
    failures.push(`tool calls without results: ${missingResults.map((c) => c.name).join(", ")}`);
  }
}

async function assertLedgerCloses(ctx, utteranceRows, failures, evidence, log) {
  const deadline = Date.now() + 120_000;
  let allClosed = false;
  while (Date.now() < deadline) {
    const ledger = await ctx.client.missionControlInstructionsList();
    const fresh = (ledger.instructions ?? []).filter((r) =>
      utteranceRows.some((u) => u.id === r.id),
    );
    allClosed = fresh.length > 0 && fresh.every((r) => r.status === "closed");
    if (allClosed) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!allClosed) {
    failures.push("ledger row(s) not closed by cards (open rows resurface every turn)");
  } else {
    evidence.push({ kind: "ledger-closed", ids: utteranceRows.map((r) => r.id) });
    log("ledger rows closed by cards");
  }
}

export async function run(ctx) {
  const { client, log, seed } = ctx;
  const evidence = [];
  const failures = [];
  const TITLE = "Winston";
  const workspaceId = seed.workspaceId;
  const ada = agentByTitle(
    (await client.fetchAgents({})).entries.map((e) => e.agent),
    "Ada Lovelace",
  );
  if (!ada) {
    return {
      verdict: "fail",
      details: { failures: ["seed agent Ada Lovelace missing"] },
      evidence: [],
    };
  }

  const browser = await openSession(ctx.voicePort);
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  try {
    const proposalPromise = waitForEvent(
      client,
      (event) =>
        event.kind === "proposal" &&
        event.proposal?.status === "pending" &&
        sameTitle(event.proposal?.spawnPlan?.title, TITLE),
      { timeoutMs: 180_000 },
    );

    const from0 = browser.frames.length;
    await speak(
      browser.ws,
      `Spawn a worker called ${TITLE} in the Alpha Project workspace, check how Ada Lovelace is doing, and start monitoring the whole fleet for changes.`,
    );
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "multi-intent answer",
    });
    log(`ANSWER: ${answer}`);
    evidence.push({ kind: "spoken", text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");

    // --- Ledger: record the open row(s) for the utterance (assert closure
    // AFTER the approval loop finishes).
    let ledger = await client.missionControlInstructionsList();
    const utteranceRows = (ledger.instructions ?? []).filter((r) =>
      (r.text ?? "").toLowerCase().includes(TITLE.toLowerCase()),
    );
    if (utteranceRows.length === 0) {
      failures.push("no ledger row opened for the multi-intent utterance");
    } else {
      evidence.push({ kind: "ledger-open", rows: utteranceRows.map((r) => r.id) });
      log(`ledger rows opened: ${utteranceRows.map((r) => r.id).join(", ")}`);
    }

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    const calls = toolCallsFromJsonl(rows);

    assertMultiIntentToolCalls(calls, workspaceId, ada.id, failures);

    // The spawn proposal: approve via the model (or direct client fallback)
    // so the ask-mode loop completes naturally and the closing card lands.
    let proposalId = null;
    try {
      const proposalEvent = await proposalPromise;
      proposalId = proposalEvent.proposal.id;
      evidence.push({ kind: "proposal", id: proposalId, title: TITLE });
      log(`proposal pending: ${proposalId}`);
    } catch (error) {
      failures.push(`no pending proposal for ${TITLE}: ${error.message}`);
    }

    if (proposalId) {
      // Speak an approval turn — the model calls proposal_respond, the spawn
      // lands, and the model cards the ledger row with respondsTo.
      const from1 = browser.frames.length;
      await speak(browser.ws, "Yes, go ahead and approve that.");
      const approvePoll = await pollJsonl(
        ctx.sessionLogDir,
        (r) => {
          const respond = toolCallsFromJsonl(r).find((c) => c.name === "proposal_respond");
          return respond ? respond : null;
        },
        { timeoutMs: 90_000 },
      );
      let modelApproved = false;
      if (approvePoll.hit) {
        const respond = approvePoll.hit;
        if (respond.args.proposalId === proposalId || respond.ok === true) {
          modelApproved = true;
          log(`model approved ${respond.args.proposalId}`);
        }
      }
      if (!modelApproved) {
        log("approving spawn via harness fallback");
        await approveProposal(client, proposalId).catch(() => undefined);
      }
      await waitForSettledAnswer(browser, { fromIndex: from1, label: "approval reply" }).catch(
        () => {},
      );

      const roster = await waitForRoster(client, (agents) => agentByTitle(agents, TITLE) !== null, {
        timeoutMs: 90_000,
      });
      if (!roster) {
        failures.push(`agent "${TITLE}" never appeared`);
      } else {
        const agent = agentByTitle(roster, TITLE);
        if (agent.workspaceId !== workspaceId) {
          failures.push(`spawned agent workspaceId ${agent.workspaceId} != ${workspaceId}`);
        }
        evidence.push({ kind: "spawned-agent", id: agent.id, workspaceId: agent.workspaceId });
      }

      // Now assert ledger row(s) closed by citing cards.
      if (utteranceRows.length > 0) {
        await assertLedgerCloses(ctx, utteranceRows, failures, evidence, log);
      }
    }
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
  }

  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      toolCalls: rows
        ? toolCallsFromJsonl(rows).map((c) => ({ name: c.name, args: c.args, ok: c.ok }))
        : [],
      providerMode: ctx.providerMode,
    },
    evidence,
  };
}
