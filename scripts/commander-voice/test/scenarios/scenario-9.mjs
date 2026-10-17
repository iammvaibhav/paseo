// Layer 3 scenario 9 — meta by voice (spec 08).
// Rename an agent by spoken name: resolve → fleet_rename_agent_title with the
// resolved agentId + new title → proposal → approve → title on record.
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  pollJsonl,
  waitForRoster,
  agentByTitle,
  hasNoSpokenIds,
  sameTitle,
  waitForEvent,
} from "./harness.mjs";
async function assertProposalResponse(
  client,
  respondedId,
  proposalId,
  adaId,
  failures,
  evidence,
  log,
) {
  if (respondedId === proposalId) {
    log(`model approved tracked ${respondedId}`);
    return;
  }
  const eventsPayload = await client.missionControlEventsFetch({ limit: 500 });
  const matchingProposal = (eventsPayload.events ?? []).find(
    (e) =>
      e.kind === "proposal" &&
      e.proposal?.id === respondedId &&
      e.proposal?.metaPlan?.action === "rename_agent_title" &&
      e.proposal?.metaPlan?.targetId === adaId,
  );
  if (!matchingProposal) {
    failures.push(
      `proposal_respond id ${respondedId} != tracked ${proposalId} and matches no Ada rename proposal`,
    );
  } else {
    log(`model approved parallel proposal ${respondedId} (matches Ada rename)`);
    evidence.push({ kind: "parallel-proposal-approved", id: respondedId });
  }
}

export const name = "meta-rename-by-voice";

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];
  const OLD_TITLE = "Ada Lovelace";
  const NEW_TITLE = "Ada The Great";
  const ada = agentByTitle(
    (await client.fetchAgents({})).entries.map((e) => e.agent),
    OLD_TITLE,
  );
  if (!ada) {
    return {
      verdict: "fail",
      details: { failures: [`seed agent ${OLD_TITLE} missing`] },
      evidence: [],
    };
  }

  const browser = await openSession(ctx.voicePort);
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  try {
    // Meta proposals carry the action inside metaPlan; match the rename.
    const proposalPromise = waitForEvent(
      client,
      (event) =>
        event.kind === "proposal" &&
        event.proposal?.status === "pending" &&
        event.proposal?.metaPlan?.action === "rename_agent_title",
      { timeoutMs: 180_000 },
    );

    const from0 = browser.frames.length;
    await speak(browser.ws, `Rename ${OLD_TITLE} to ${NEW_TITLE}.`);
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "rename confirmation",
    });
    log(`ANSWER1: ${answer}`);
    evidence.push({ kind: "spoken", turn: 1, text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");

    let proposalId = null;
    try {
      const proposalEvent = await proposalPromise;
      proposalId = proposalEvent.proposal.id;
      evidence.push({ kind: "proposal", id: proposalId, action: "rename_agent_title" });
      log(`proposal ${proposalId}`);
    } catch (error) {
      failures.push(`no pending rename proposal: ${error.message}`);
    }

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    const calls = toolCallsFromJsonl(rows);
    const renameCalls = calls.filter((c) => c.name === "fleet_rename_agent_title");
    if (renameCalls.length === 0) {
      failures.push("no fleet_rename_agent_title call");
    } else {
      for (const call of renameCalls) {
        if (call.args.agentId !== ada.id) {
          failures.push(`rename agentId ${call.args.agentId} != ${ada.id}`);
        }
        if (!sameTitle(call.args.title, NEW_TITLE)) {
          failures.push(`rename title "${call.args.title}" != "${NEW_TITLE}"`);
        }
        if (call.ok === false) failures.push(`fleet_rename_agent_title failed: ${call.error}`);
      }
    }
    const resolveCalls = calls.filter(
      (c) =>
        c.name === "fleet_list_agents" ||
        c.name === "fleet_list_inventory" ||
        c.name === "fleet_search",
    );
    const firstRenameTs = renameCalls[0]?.ts;
    if (resolveCalls.length === 0) {
      failures.push("no resolve call before the rename");
    } else if (!resolveCalls.some((c) => !firstRenameTs || c.ts <= firstRenameTs)) {
      failures.push("fleet_rename_agent_title called without a prior resolve call");
    }

    // Approval: model calls proposal_respond with the buffered id.
    if (proposalId) {
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
      if (approvePoll.hit) {
        await assertProposalResponse(
          client,
          approvePoll.hit.args.proposalId,
          proposalId,
          ada.id,
          failures,
          evidence,
          log,
        );
      } else {
        failures.push("model did not call proposal_respond for the rename approval");
      }
      await waitForSettledAnswer(browser, { fromIndex: from1, label: "approval reply" }).catch(
        () => {},
      );
    }

    // The title lands on the record.
    const roster = await waitForRoster(
      client,
      (agents) => agents.some((a) => sameTitle(a.title, NEW_TITLE)),
      { timeoutMs: 90_000 },
    );
    if (!roster) {
      failures.push(`agent title never became "${NEW_TITLE}"`);
    } else {
      const renamed = roster.find((a) => sameTitle(a.title, NEW_TITLE));
      evidence.push({ kind: "renamed-agent", id: renamed.id, title: NEW_TITLE });
      log(`title now: ${NEW_TITLE}`);
    }
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
  }

  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      renameArgs: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_rename_agent_title")
            .map((c) => c.args)
        : [],
    },
    evidence,
  };
}
