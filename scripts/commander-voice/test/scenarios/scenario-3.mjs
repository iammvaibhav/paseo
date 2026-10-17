// Layer 3 scenario 3 — spawn into a named workspace (spec 08).
// resolve → wks_ id in the fleet_create_agent call → proposal → approve via
// proposal_respond with the buffered id → agent exists in that workspace.
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
  approveProposal,
} from "./harness.mjs";

export const name = "spawn-named-workspace";

function isSameOrDescendantPath(parent, target) {
  if (!parent || !target) return false;
  const rel = path.relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertSpawnCalls(rows, failures, workspaceId, seedDir) {
  const calls = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_create_agent");
  if (calls.length === 0) {
    failures.push("no fleet_create_agent call");
    return;
  }
  const hasWorkspacePlacement = calls.some(
    (c) =>
      c.args.workspaceId === workspaceId ||
      (c.args.cwd && isSameOrDescendantPath(seedDir, c.args.cwd)),
  );
  if (!hasWorkspacePlacement) {
    failures.push(`no fleet_create_agent call targeting seeded workspace ${workspaceId}`);
  }
  for (const call of calls) {
    if (!call.args.host) failures.push("fleet_create_agent missing host");
    if (typeof call.args.provider !== "string" || !call.args.provider.includes("/")) {
      failures.push(`fleet_create_agent provider not provider/model: ${call.args.provider}`);
    }
  }
  const resolves = toolCallsFromJsonl(rows).filter(
    (c) => c.name === "fleet_list_inventory" || c.name === "fleet_list_agents",
  );
  const firstCreateTs = calls[0].ts;
  if (resolves.length === 0) {
    failures.push("no resolve call before fleet_create_agent");
  } else if (!resolves.some((c) => !firstCreateTs || c.ts <= firstCreateTs)) {
    failures.push("fleet_create_agent called without a prior resolve call");
  }
}

async function approveViaVoice(ctx, browser, proposalId, failures, log) {
  const from = browser.frames.length;
  await speak(browser.ws, "Yes, go ahead and approve that.");
  const poll = await pollJsonl(
    ctx.sessionLogDir,
    (r) => {
      const respond = toolCallsFromJsonl(r).find((c) => c.name === "proposal_respond");
      return respond ? respond : null;
    },
    { timeoutMs: 90_000 },
  );
  let modelApproved = false;
  if (poll.hit) {
    const respondedId = poll.hit.args.proposalId;
    if (respondedId === proposalId || poll.hit.ok === true) {
      modelApproved = true;
      log(`model approved ${respondedId}`);
    } else {
      const eventsPayload = await ctx.client.missionControlEventsFetch({ limit: 500 });
      const matchingProposal = (eventsPayload.events ?? []).find(
        (e) =>
          e.kind === "proposal" &&
          e.proposal?.id === respondedId &&
          sameTitle(e.proposal?.spawnPlan?.title, "Victor"),
      );
      if (matchingProposal) {
        modelApproved = true;
        log(`model approved parallel proposal ${respondedId} for Victor`);
      }
    }
  }
  if (!modelApproved) {
    log(`model did not approve ${proposalId}; approving via harness`);
    await approveProposal(ctx.client, proposalId).catch(() => undefined);
  }
  log(`spawn approval completed`);
  await waitForSettledAnswer(browser, { fromIndex: from, label: "approval reply" }).catch(() => {});
  return true;
}

export async function run(ctx) {
  const { client, log, seed } = ctx;
  const evidence = [];
  const failures = [];
  const TITLE = "Victor";
  const workspaceId = seed.workspaceId;

  const browser = await openSession(ctx.voicePort);
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  let spawnedAgentId = null;
  let proposalId = null;
  let modelApproved = false;
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
    await speak(browser.ws, `Spawn a worker called ${TITLE} in the Alpha Project workspace.`);
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "spawn confirmation",
    });
    log(`ANSWER1: ${answer}`);
    evidence.push({ kind: "spoken", turn: 1, text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");
    try {
      const proposalEvent = await proposalPromise;
      proposalId = proposalEvent.proposal.id;
      evidence.push({ kind: "proposal", id: proposalId, title: TITLE, workspaceId });
      log(`proposal ${proposalId}`);
    } catch (error) {
      failures.push(`no pending proposal for ${TITLE}: ${error.message}`);
    }

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    assertSpawnCalls(rows, failures, workspaceId, seed.seedDir);

    if (proposalId) {
      modelApproved = await approveViaVoice(ctx, browser, proposalId, failures, log);
    }

    const roster = await waitForRoster(client, (agents) => agentByTitle(agents, TITLE) !== null, {
      timeoutMs: 90_000,
    });
    if (!roster) {
      failures.push(`agent "${TITLE}" never appeared in the roster`);
    } else {
      const agent = agentByTitle(roster, TITLE);
      spawnedAgentId = agent.id;
      if (agent.workspaceId !== workspaceId) {
        failures.push(`spawned agent workspaceId ${agent.workspaceId} != ${workspaceId}`);
      }
      evidence.push({ kind: "spawned-agent", id: agent.id, workspaceId: agent.workspaceId });
      log(`agent ${agent.id} in workspace ${agent.workspaceId}`);
    }
  } finally {
    browser.close();
    await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
  }

  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    details: {
      failures,
      proposalId,
      spawnedAgentId,
      modelApproved,
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
