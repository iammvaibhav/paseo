// Commander Voice — instruction ledger unit tests (spec 05, voice P0).
// Pure node:test — no daemon, no Gemini. Asserts the open-row injection
// formatting and the session's open/close refresh loop against a stub daemon.
//
// Run:  node --test test/ledger.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { VoiceSession } from "../server.js";
import { formatOpenInstructionsLine } from "../lib/daemon.js";
import { executeTool } from "../lib/tools.js";

const OPEN = WebSocket.OPEN;

/** Minimal session with a stub daemon + capture geminiWs. */
function makeSession(daemon) {
  const clientWs = {
    readyState: OPEN,
    send() {},
  };
  const session = new VoiceSession({
    clientWs,
    daemon,
    config: {
      voiceMode: "relay",
      sessionLogDir: mkdtempSync(path.join(os.tmpdir(), "voice-ledger-test-")),
    },
    model: "models/test",
    sessionId: `ledger-${Math.random().toString(36).slice(2, 8)}`,
  });
  const injected = [];
  session.geminiWs = {
    readyState: OPEN,
    send(raw) {
      injected.push(JSON.parse(raw));
    },
  };
  return { session, injected };
}

/** A stub daemon whose ledger can be mutated by the test. */
function makeStubDaemon() {
  const rows = new Map();
  let next = 0;
  return {
    rows,
    async openInstruction(text) {
      next += 1;
      const row = {
        id: `#${next}`,
        text,
        ts: new Date().toISOString(),
        source: "voice",
        status: "open",
      };
      rows.set(row.id, row);
      return { instructions: [{ id: row.id, text: row.text }] };
    },
    async listInstructions() {
      return { instructions: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    },
  };
}

test("formatOpenInstructionsLine renders ids + one-line texts, em-dash joined", () => {
  const line = formatOpenInstructionsLine([
    { id: "#12", text: "spawn worker in paseo" },
    { id: "#13", text: "status of Keen Heisenberg" },
  ]);
  assert.equal(line, "Open: #12 spawn worker in paseo — #13 status of Keen Heisenberg");
});

test("formatOpenInstructionsLine collapses whitespace and skips empty rows", () => {
  const line = formatOpenInstructionsLine([
    { id: "#7", text: "spawn\n  worker   in paseo" },
    { id: "#8", text: "" },
    { id: "#9", text: "   " },
    { id: null, text: "no id" },
  ]);
  assert.equal(line, "Open: #7 spawn worker in paseo");
});

test("formatOpenInstructionsLine is empty for no rows", () => {
  assert.equal(formatOpenInstructionsLine([]), "");
  assert.equal(formatOpenInstructionsLine(null), "");
  assert.equal(formatOpenInstructionsLine(), "");
});

test("a final utterance opens a row and injects the Open line into the next model turn", async () => {
  const daemon = makeStubDaemon();
  const { session, injected } = makeSession(daemon);

  await session.handleFinalUtterance("spawn worker in paseo");
  assert.equal(daemon.rows.get("#1").text, "spawn worker in paseo");
  assert.deepEqual(injected, [{ realtimeInput: { text: "Open: #1 spawn worker in paseo" } }]);

  // A second utterance resurfaces BOTH still-open rows.
  await session.handleFinalUtterance("status of Keen Heisenberg");
  assert.deepEqual(injected.at(-1), {
    realtimeInput: {
      text: "Open: #1 spawn worker in paseo — #2 status of Keen Heisenberg",
    },
  });
});

test("a row closed on the daemon stops resurfacing; unclosed rows keep riding", async () => {
  const daemon = makeStubDaemon();
  const { session, injected } = makeSession(daemon);

  await session.handleFinalUtterance("spawn worker in paseo");
  await session.handleFinalUtterance("status of Keen Heisenberg");

  // The daemon closes #1 via a citing card (emit-time close) — the session's
  // next injection must drop it while the new utterance's row rides along.
  daemon.rows.get("#1").status = "closed";
  daemon.rows.get("#1").closedBy = "cardId";
  await session.handleFinalUtterance("what is the fleet status");
  assert.deepEqual(injected.at(-1), {
    realtimeInput: {
      text: "Open: #2 status of Keen Heisenberg — #3 what is the fleet status",
    },
  });

  // Close #2 as well — only the still-open #3 and the new row resurface.
  daemon.rows.get("#2").status = "closed";
  daemon.rows.get("#2").closedBy = "cardId";
  await session.handleFinalUtterance("thanks");
  assert.deepEqual(injected.at(-1), {
    realtimeInput: { text: "Open: #3 what is the fleet status — #4 thanks" },
  });
});

test("buildOpenInstructionsLine feeds the pending_updates digest", async () => {
  const daemon = makeStubDaemon();
  const { session } = makeSession(daemon);

  assert.equal(await session.buildOpenInstructionsLine(), "");
  await session.handleFinalUtterance("spawn worker in paseo");
  assert.equal(await session.buildOpenInstructionsLine(), "Open: #1 spawn worker in paseo");
  daemon.rows.get("#1").status = "closed";
  assert.equal(await session.buildOpenInstructionsLine(), "");
});

test("an open RPC failure never breaks the turn", async () => {
  const daemon = makeStubDaemon();
  const { injected } = makeSession(daemon);
  const failing = makeSession({
    openInstruction: async () => {
      throw new Error("daemon unreachable");
    },
    listInstructions: () => daemon.listInstructions(),
  });
  await failing.session.handleFinalUtterance("status of Keen Heisenberg");
  // No rows tracked, no injection — and no throw.
  assert.equal(injected.length, 0);
});

test("pending_updates digests append the still-open instruction rows", async () => {
  const daemon = makeStubDaemon();
  const { session } = makeSession(daemon);
  await session.handleFinalUtterance("spawn worker in paseo");
  await session.handleFinalUtterance("status of Keen Heisenberg");

  const digest = await executeTool(
    "pending_updates",
    {},
    {
      daemon: {
        drainUpdates: () => ({ spoken: "No updates since you last asked.", data: { entries: [] } }),
      },
      voiceMode: "relay",
      getOpenInstructionsLine: () => session.buildOpenInstructionsLine(),
    },
  );
  assert.equal(
    digest.spoken,
    "No updates since you last asked. Open: #1 spawn worker in paseo — #2 status of Keen Heisenberg.",
  );
  assert.equal(
    digest.data.openInstructions,
    "Open: #1 spawn worker in paseo — #2 status of Keen Heisenberg",
  );
  assert.deepEqual(digest.data.entries, []);

  // No open rows → the digest passes through untouched.
  const plain = await executeTool(
    "pending_updates",
    {},
    {
      daemon: {
        drainUpdates: () => ({ spoken: "No updates since you last asked.", data: { entries: [] } }),
      },
      voiceMode: "relay",
      getOpenInstructionsLine: async () => "",
    },
  );
  assert.deepEqual(plain, { spoken: "No updates since you last asked.", data: { entries: [] } });
});
