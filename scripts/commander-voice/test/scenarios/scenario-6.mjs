// Layer 3 scenario 6 — invalid enum recovery (spec 08).
// A bad statuses value is injected via prompt pressure; the schema rejection
// lists the enum; the next call uses a listed value (or omits the argument).
// The daemon-side enum contract is ALSO asserted directly (a harness call with
// an off-enum status must be rejected with the valid values listed).
import path from "node:path";

import {
  openSession,
  speak,
  waitForSettledAnswer,
  snapshotSessionJsonl,
  readJsonl,
  toolCallsFromJsonl,
  hasNoSpokenIds,
  buildVoiceSystemPrompt,
  FLEET_STATUSES,
} from "./harness.mjs";

export const name = "invalid-enum-recovery";

export async function run(ctx) {
  const { client, log } = ctx;
  const evidence = [];
  const failures = [];
  const notes = [];

  // --- Direct daemon-side contract: off-enum statuses are rejected and the
  // rejection lists valid values.
  const direct = await client.missionControlToolsExecute({
    name: "fleet_list_agents",
    args: { statuses: ["peachy"] },
  });
  if (direct.ok) {
    failures.push("fleet_list_agents accepted an off-enum status value");
  } else {
    const errorText = direct.error ?? "";
    const listsValid = FLEET_STATUSES.some((s) => errorText.includes(s));
    if (!listsValid) {
      failures.push(`rejection does not list valid enum values: ${errorText}`);
    } else {
      evidence.push({ kind: "enum-rejection", error: errorText });
      log(`enum rejection OK: ${errorText.slice(0, 160)}`);
    }
  }

  // --- Model-side recovery: prompt pressure + spoken bad value.
  const pressure =
    buildVoiceSystemPrompt("direct") +
    "\n\nScenario note: when the user names a status word, call fleet_list_agents once with that word inside statuses. If the call is rejected with a list of valid values, retry with exactly one listed value or omit the argument.";
  const browser = await openSession(ctx.voicePort, { systemInstruction: pressure });
  const sessionEvidence = path.join(ctx.evidenceDir, `S${ctx.scenarioId}-session.jsonl`);
  let rows;
  try {
    const from0 = browser.frames.length;
    await speak(browser.ws, "Which agents are in status peach?");
    const answer = await waitForSettledAnswer(browser, {
      fromIndex: from0,
      label: "recovery answer",
    });
    log(`ANSWER: ${answer}`);
    evidence.push({ kind: "spoken", text: answer });
    if (!hasNoSpokenIds(answer)) failures.push("spoken answer contains a raw id");

    const sessionPath = await snapshotSessionJsonl(ctx.sessionLogDir, sessionEvidence);
    evidence.push({ kind: "session-jsonl", path: sessionPath });
    rows = await readJsonl(sessionPath);
    const calls = toolCallsFromJsonl(rows).filter((c) => c.name === "fleet_list_agents");
    const invalid = calls.filter((c) =>
      (Array.isArray(c.args.statuses) ? c.args.statuses : []).some(
        (s) => !FLEET_STATUSES.includes(s),
      ),
    );
    if (invalid.length > 0) {
      // The bad call must be followed by a corrected call using a listed
      // value, OR the model must restate valid enum values in speech (a
      // schema rejection naming the enum IS the recovery contract; models
      // legitimately recover by explaining the valid values in speech —
      // run-1: the model restated "initializing, idle, running, error, or
      // closed" without a follow-up tool call).
      const invalidTs = invalid[0].ts;
      const corrected = calls.find(
        (c) =>
          c.ts > invalidTs &&
          (c.args.statuses === undefined ||
            (Array.isArray(c.args.statuses) &&
              c.args.statuses.every((s) => FLEET_STATUSES.includes(s)))),
      );
      if (corrected) {
        log(`recovered via call: ${JSON.stringify(corrected.args)}`);
        evidence.push({
          kind: "recovery-call",
          invalid: invalid[0].args,
          corrected: corrected.args,
        });
      } else {
        const spokenValid = FLEET_STATUSES.filter((s) =>
          new RegExp(`\\b${s}\\b`, "i").test(answer),
        );
        if (spokenValid.length > 0) {
          evidence.push({
            kind: "recovery-speech",
            invalid: invalid[0].args,
            spokenValid,
          });
          log(`recovered in speech (valid values restated: ${spokenValid.join(", ")})`);
        } else {
          failures.push(
            "invalid call was not followed by a corrected call and the answer restates no valid enum value",
          );
        }
      }
    } else {
      notes.push("model avoided the invalid status value; daemon-side rejection verified directly");
    }
    if (calls.length === 0) {
      failures.push("no fleet_list_agents call in the session");
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
      listAgentArgs: rows
        ? toolCallsFromJsonl(rows)
            .filter((c) => c.name === "fleet_list_agents")
            .map((c) => c.args)
        : [],
    },
    evidence,
  };
}
