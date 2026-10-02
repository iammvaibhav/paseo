// Layer 3 scenario 4 — spawn with no placement (spec 08).
// placement omitted (no workspaceId/cwd), host present; the daemon places.
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

export const name = "spawn-no-placement";
function assertNoPlacementCalls(createCalls, failures) {
  if (createCalls.length === 0) {
    failures.push("no fleet_create_agent call");
    return;
  }
  for (const call of createCalls) {
    if (call.args.workspaceId !== undefined && call.args.workspaceId !== null) {
      failures.push(`placement must be omitted; got workspaceId ${call.args.workspaceId}`);
    }
    if (call.args.cwd !== undefined && call.args.cwd !== null && call.args.cwd !== "") {
      failures.push(`placement must be omitted; got cwd ${call.args.cwd}`);
    }
    if (!call.args.host) failures.push("fleet_create_agent missing host");
  }
}

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];
  const notes = [];
  const TITLE = "Ursula";
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
    await speak(browser.ws, `Spawn a worker called ${TITLE} to work on something new.`);
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "spawn confirmation",
    });
    log(`ANSWER1: ${answer}`);
    evidence.push({ kind: "spoken", turn: 1, text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");

    let proposalId = null;
    try {
      const proposalEvent = await proposalPromise;
      proposalId = proposalEvent.proposal.id;
      evidence.push({ kind: "proposal", id: proposalId, title: TITLE });
      log(`proposal ${proposalId}`);
    } catch (error) {
      failures.push(`no pending proposal for ${TITLE}: ${error.message}`);
    }

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    const calls = toolCallsFromJsonl(rows);
    const createCalls = calls.filter((c) => c.name === "fleet_create_agent");
    assertNoPlacementCalls(createCalls, failures);
    const modelCalls = calls.filter((c) => c.name === "fleet_list_models");
    if (modelCalls.length === 0) {
      notes.push("no fleet_list_models call before the spawn");
    }

    if (proposalId) {
      // Harness-driven approval (placement is the daemon's job once approved);
      // the model may also approve on its own — note either way.
      const from1 = browser.frames.length;
      await speak(browser.ws, "Yes, go ahead and approve that.");
      const approvePoll = await pollJsonl(
        ctx.sessionLogDir,
        (r) => {
          const respond = toolCallsFromJsonl(r).find((c) => c.name === "proposal_respond");
          return respond ? respond : null;
        },
        { timeoutMs: 120_000 },
      );
      const isModelApproved =
        approvePoll.hit &&
        (approvePoll.hit.args?.proposalId === proposalId || approvePoll.hit.ok === true);
      if (isModelApproved) {
        notes.push("model approved the spawn itself");
      } else {
        await approveProposal(client, proposalId).catch(() => undefined);
        notes.push("approval driven by harness");
      }
      await waitForSettledAnswer(browser, { fromIndex: from1, label: "approval reply" }).catch(
        () => {},
      );
    }

    const roster = await waitForRoster(client, (agents) => agentByTitle(agents, TITLE) !== null, {
      timeoutMs: 90_000,
    });
    if (!roster) {
      failures.push(`agent "${TITLE}" never appeared in the roster`);
    } else {
      const agent = agentByTitle(roster, TITLE);
      evidence.push({
        kind: "spawned-agent",
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
      });
      log(`agent ${agent.id} placed in ${agent.workspaceId ?? "no workspace"}`);
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
      createArgs: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_create_agent")
            .map((c) => c.args)
        : [],
      providerMode: ctx.providerMode,
    },
    evidence,
  };
}
