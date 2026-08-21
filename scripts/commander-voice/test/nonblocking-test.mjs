#!/usr/bin/env node
// Commander Voice — Live API async-function-calling test bench.
// Directly exercises BidiGenerateContent (no proxy) to answer:
//   1. Does the model keep responding to new input while a tool call is
//      pending (no toolResponse sent)? = async/non-blocking behavior.
//   2. Is `behavior: "NON_BLOCKING"` honored, and is the `scheduling` policy
//      on the toolResponse accepted?
// Spoken prompts are synthesized with gemini-2.5-flash-preview-tts and
// streamed with mic cadence + trailing silence (the e2e-audio pattern).
//
// Usage: node test/nonblocking-test.mjs   (needs GEMINI_API_KEY; see lib/config.js)
import { WebSocket } from "ws";
import { resolveGeminiApiKey } from "../lib/config.js";

const API_KEY = resolveGeminiApiKey();
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
const MODEL_31 = "models/gemini-3.1-flash-live-preview";
const MODEL_25 = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const VAD_TRAILING_SILENCE_MS = 2500;
const CHUNK_MS = 160;

const TOOL = {
  name: "search_flights",
  description: "Searches airlines for current flight prices. Can take up to 10 seconds.",
  parameters: { type: "OBJECT", properties: {} },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** gemini-3.1-flash-tts-preview → raw PCM (24kHz). One retry on failure. */
async function tts(text, attempt = 0) {
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
          },
        }),
      },
    );
  } catch (e) {
    if (attempt < 2) {
      await sleep(3000);
      return tts(text, attempt + 1);
    }
    throw new Error(`TTS fetch failed: ${e.message}`, { cause: e });
  }
  if (!res.ok) {
    const body = await res.text();
    if (attempt < 2) {
      await sleep(3000);
      return tts(text, attempt + 1);
    }
    throw new Error(`TTS failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const parsed = await res.json();
  const part = parsed?.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data)
    throw new Error(`TTS returned no audio: ${JSON.stringify(parsed).slice(0, 200)}`);
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1];
  return { pcm: Buffer.from(part.inlineData.data, "base64"), rate: rate ? Number(rate) : 24000 };
}

function silenceMs(ms, rate) {
  return Buffer.alloc(Math.round(rate * (ms / 1000)) * 2);
}

/** Stream PCM with mic-like cadence so the Live speech detector hears it. */
async function streamAudio(ws, pcm, rate) {
  const chunkBytes = Math.round(rate * (CHUNK_MS / 1000)) * 2;
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: pcm.subarray(off, off + chunkBytes).toString("base64"),
            mimeType: `audio/pcm;rate=${rate}`,
          },
        },
      }),
    );
    await sleep(30);
  }
}

async function speak(ws, text) {
  const { pcm, rate } = await tts(text);
  await streamAudio(
    ws,
    Buffer.concat([silenceMs(400, rate), pcm, silenceMs(VAD_TRAILING_SILENCE_MS, rate)]),
    rate,
  );
}

function sendSetup(ws, { model, behavior, voiceName }) {
  ws.send(
    JSON.stringify({
      setup: {
        model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          ...(voiceName
            ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } }
            : {}),
        },
        systemInstruction: {
          parts: [
            {
              text: "When the user asks you to call the search flights tool, call it immediately with empty arguments. Do not ask for details. Keep all replies under 15 words.",
            },
          ],
        },
        tools: [{ functionDeclarations: [{ ...TOOL, ...(behavior ? { behavior } : {}) }] }],
      },
    }),
  );
}

function recordServerContent(state, sc) {
  if (sc.inputTranscription?.text) {
    state.events.push({ t: Date.now(), kind: "asr", text: sc.inputTranscription.text });
  }
  const hasContent =
    (sc.modelTurn?.parts?.length ?? 0) > 0 || Boolean(sc.outputTranscription?.text);
  if (!hasContent) return;
  const text = sc.outputTranscription?.text ?? "";
  if (state.toolCallAt && !state.toolResponseSent) {
    state.responseWhilePendingAt = Date.now();
    state.events.push({ t: state.responseWhilePendingAt, kind: "response-while-pending", text });
    return;
  }
  if (state.toolResponseSent) {
    state.events.push({ t: Date.now(), kind: "response-after-release", text });
    return;
  }
  state.events.push({ t: Date.now(), kind: "early-response", text });
}

function recordToolCall(state, msg) {
  const fc = msg.toolCall.functionCalls?.[0];
  if (!fc) return;
  state.toolCallAt = Date.now();
  state.events.push({
    t: state.toolCallAt,
    kind: "toolCall",
    name: fc.name,
    callId: fc.id,
  });
}

async function waitUntil(predicate, ms, tickMs = 250) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await sleep(tickMs);
  }
  return predicate();
}

function eventTime(events, kind) {
  return events.find((e) => e.kind === kind)?.t ?? null;
}

async function runConversationAfterSetup(ws, state, { label, model, behavior }) {
  try {
    await speak(ws, "Call the search flights tool.");
  } catch (e) {
    return { label, error: `speak-1 failed: ${e.message}` };
  }
  console.error(`[${label}] uttered-1`);
  state.events.push({ t: Date.now(), kind: "uttered-1" });

  const gotToolCall = await waitUntil(() => state.toolCallAt !== null, 25_000);
  if (!gotToolCall) {
    return { label, error: "no toolCall within 25s", events: state.events };
  }
  console.error(`[${label}] toolCall received`);

  try {
    await speak(ws, "While that is running, answer with exactly the word OK.");
  } catch (e) {
    return { label, error: `speak-2 failed: ${e.message}`, events: state.events };
  }
  console.error(`[${label}] uttered-2`);
  state.events.push({ t: Date.now(), kind: "uttered-2" });
  await sleep(12_000);
  const responded = state.responseWhilePendingAt !== null;

  const scheduling = behavior === "NON_BLOCKING" ? "WHEN_IDLE" : undefined;
  const callId = state.events.find((e) => e.kind === "toolCall")?.callId ?? "0";
  ws.send(
    JSON.stringify({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: "search_flights",
            ...(scheduling ? { scheduling } : {}),
            response: { status: "ok", flights: ["AC758: $350"] },
          },
        ],
      },
    }),
  );
  state.toolResponseSent = true;
  state.events.push({ t: Date.now(), kind: "toolResponse-sent", scheduling });

  try {
    await speak(ws, "Tell me the weather in London now.");
  } catch (e) {
    return { label, error: `speak-3 failed: ${e.message}`, events: state.events };
  }
  console.error(`[${label}] uttered-3`);
  state.events.push({ t: Date.now(), kind: "uttered-3" });
  await sleep(15_000);

  const toolCallT = eventTime(state.events, "toolCall");
  const uttered1T = eventTime(state.events, "uttered-1");
  const uttered2T = eventTime(state.events, "uttered-2");
  return {
    label,
    model,
    behavior: behavior ?? "none",
    toolCallLatencyMs: toolCallT && uttered1T ? toolCallT - uttered1T : null,
    respondedWhileToolPending: responded,
    responseWhilePendingLatencyMs:
      state.responseWhilePendingAt && uttered2T ? state.responseWhilePendingAt - uttered2T : null,
    respondedAfterToolResponse: state.events.some((e) => e.kind === "response-after-release"),
    events: state.events.map((e) => ({ ...e, t: undefined })),
  };
}

function runSession({ label, model, behavior, voiceName }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const state = {
      events: [],
      toolCallAt: null,
      responseWhilePendingAt: null,
      toolResponseSent: false,
    };
    let finished = false;
    let conversationStarted = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      try {
        ws.close();
      } catch {
        // ignore close races
      }
      resolve(result);
    };

    ws.on("open", () => sendSetup(ws, { model, behavior, voiceName }));

    ws.on("message", (raw) => {
      if (finished) return;
      const msg = JSON.parse(raw.toString());
      if (msg.setupComplete && !conversationStarted) {
        conversationStarted = true;
        state.events.push({ t: Date.now(), kind: "setupComplete" });
        void runConversationAfterSetup(ws, state, { label, model, behavior }).then(finish);
        return;
      }
      if (msg.toolCall) recordToolCall(state, msg);
      if (msg.serverContent) recordServerContent(state, msg.serverContent);
    });

    ws.on("close", (code, reason) => {
      if (code !== 1000 && !finished) {
        finish({ label, error: `closed ${code} ${reason}`, events: state.events });
      }
    });
    ws.on("error", (e) => finish({ label, error: `ws error: ${e.message}`, events: state.events }));
  });
}

const results = [];
const only = process.env.TEST_ONLY;
if (!only || only === "T1")
  results.push(
    await runSession({
      label: "T1 3.1 NON_BLOCKING",
      model: MODEL_31,
      behavior: "NON_BLOCKING",
      voiceName: "Puck",
    }),
  );
if (!only || only === "T2")
  results.push(
    await runSession({ label: "T2 2.5 NON_BLOCKING", model: MODEL_25, behavior: "NON_BLOCKING" }),
  );
if (!only || only === "T3")
  results.push(
    await runSession({ label: "T3 3.1 sync (no behavior)", model: MODEL_31, voiceName: "Puck" }),
  );

for (const r of results) {
  console.log(`\n=== ${r.label} ===`);
  if (r.error) {
    console.log("ERROR:", r.error);
    console.log("events:", JSON.stringify(r.events ?? []));
    continue;
  }
  console.log(`toolCall latency: ${r.toolCallLatencyMs}ms`);
  console.log(
    `responded while tool pending: ${r.respondedWhileToolPending}${r.responseWhilePendingLatencyMs ? ` (${r.responseWhilePendingLatencyMs}ms after utterance 2)` : ""}`,
  );
  console.log(`responded after tool release: ${r.respondedAfterToolResponse}`);
  console.log("events:", JSON.stringify(r.events));
}
process.exit(0);
