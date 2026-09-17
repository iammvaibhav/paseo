// Layer 3 scenario 5 — duplicate emission (spec 08).
// The model emits a spawn; a re-emission while pending (model re-call and/or
// an identical harness replay) returns the SAME proposal id — one proposal.
// After resolution a new identical call is allowed (new proposal).
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
  sameTitle,
  waitForEvent,
  approveProposal,
} from "./harness.mjs";

export const name = "duplicate-emission";

async function replaySameArgs(client, args, failures, log, label) {
  const replay = await client.missionControlToolsExecute({ name: "fleet_create_agent", args });
  if (!replay.ok) {
    failures.push(`${label} replay failed: ${replay.error}`);
    return null;
  }
  return replay.structuredContent?.proposalId ?? null;
}

function assertModelReemission(createCalls2, firstArgs, failures, notes, log) {
  if (createCalls2.length <= 1) {
    notes.push("model did not re-emit; harness replay covers the dedupe path");
    return;
  }
  const sameArgs = createCalls2.every((c) => JSON.stringify(c.args) === JSON.stringify(firstArgs));
  if (!sameArgs) {
    notes.push(
      `model re-emitted with different args (${createCalls2[1].summary}) — identical-args dedupe covered by harness replay`,
    );
  } else if (createCalls2[1].ok === false) {
    failures.push(`re-emission failed: ${createCalls2[1].error}`);
  } else if (!/already pending/i.test(createCalls2[1].summary ?? "")) {
    failures.push(`re-emission did not report dedupe: "${createCalls2[1].summary}"`);
  } else {
    log(`model re-emitted while pending: ${createCalls2[1].summary}`);
  }
}

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];
  const notes = [];
  const TITLE = "Dupe";

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
    await speak(browser.ws, `Spawn a worker called ${TITLE} in the Alpha Project workspace.`);
    await waitForSettledAnswer(browser, { fromIndex: from0, label: "spawn confirmation" });

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
    const createCalls = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_create_agent");
    if (createCalls.length === 0) {
      failures.push("no fleet_create_agent call");
      return { verdict: "fail", details: { failures, notes }, evidence };
    }
    const firstArgs = createCalls[0].args;

    // 1) Invite a model re-emission while pending.
    const from1 = browser.frames.length;
    await speak(browser.ws, `Yes, spawn that same agent again.`);
    await waitForSettledAnswer(browser, { fromIndex: from1, label: "re-emission reply" }).catch(
      () => {},
    );
    const sessionPath2 = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    rows = await readJsonl(sessionPath2);
    const createCalls2 = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_create_agent");
    assertModelReemission(createCalls2, firstArgs, failures, notes, log);

    // 2) Harness replay with the EXACT first args → same proposal id.
    const proposalEvents = await client.missionControlEventsFetch({ limit: 100 });
    const isPending = (proposalEvents.events ?? []).some(
      (e) =>
        e.kind === "proposal" && e.proposal?.id === proposalId && e.proposal?.status === "pending",
    );
    if (isPending) {
      const replayedId = await replaySameArgs(client, firstArgs, failures, log, "harness");
      if (replayedId !== null && replayedId !== proposalId) {
        failures.push(`replay returned ${replayedId} != original ${proposalId} (dedupe broken)`);
      } else if (replayedId !== null) {
        log(`harness replay deduped onto ${replayedId}`);
        evidence.push({ kind: "dedupe", original: proposalId, replayed: replayedId });
      }
    } else {
      notes.push("proposal was approved during re-emission; skipping pending-state harness replay");
    }

    // 3) Approve → exactly ONE agent with the title.
    if (proposalId) {
      await approveProposal(client, proposalId).catch(() => undefined);
      const roster = await waitForRoster(client, (agents) => agentByTitle(agents, TITLE) !== null, {
        timeoutMs: 90_000,
      });
      const matches = (roster ?? []).filter((a) => sameTitle(a.title, TITLE));
      if (matches.length === 0) {
        failures.push(`agent "${TITLE}" never appeared`);
      } else if (matches.length > 1) {
        failures.push(`duplicate agents created: ${matches.length} with title ${TITLE}`);
      } else {
        evidence.push({ kind: "spawned-agent", id: matches[0].id, count: matches.length });
        log(`exactly one ${TITLE} agent: ${matches[0].id}`);
      }
    }

    // 4) After resolve, an identical call is allowed again (new proposal).
    const newId = await replaySameArgs(client, firstArgs, failures, log, "post-resolve");
    if (newId === proposalId) {
      failures.push("post-resolve identical call was deduped onto the resolved proposal");
    } else if (newId) {
      notes.push("post-resolve identical call created a new proposal (allowed)");
      evidence.push({ kind: "post-resolve-new-proposal", id: newId });
    } else {
      notes.push("post-resolve replay did not return a proposal id (not a dedupe violation)");
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
      createCalls: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_create_agent")
            .map((c) => ({ args: c.args, summary: c.summary }))
        : [],
      providerMode: ctx.providerMode,
    },
    evidence,
  };
}
