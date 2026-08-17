// Commander Voice scenario bench — shared harness (spec 08 Layer 3).
// Reuses the proven bench pattern: Gemini TTS -> PCM -> mic-cadence streaming
// -> trailing silence for VAD (see ../nonblocking-test.mjs and ../e2e-audio.mjs).
// Browser-side frames + the voice node's session JSONL are the assertion
// surface; daemon state is read through the runner's DaemonClient.
import { readFile, readdir, copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { resolveGeminiApiKey } from "../../lib/config.js";
import { buildFleetRosterDigest } from "../../lib/daemon.js";
import { buildVoiceSystemPrompt } from "../../lib/voice-prompt.js";

export { resolveGeminiApiKey, buildVoiceSystemPrompt, buildFleetRosterDigest };

export const VAD_TRAILING_SILENCE_MS = 2500;
export const CHUNK_MS = 160;
export const TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const MCP_ID_RE = /\bmcp_[A-Za-z0-9]+\b/;
export const WKS_ID_RE = /\bwks_[0-9a-f]{16}\b/;
export const PRJ_ID_RE = /\bprj_[0-9a-f]{16}\b/;
export const FLEET_STATUSES = ["initializing", "idle", "running", "error", "closed"];
export const FLEET_BUCKETS = ["needs_you", "running", "ready", "done", "idle"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry wait for a quota/5xx TTS response (the body carries the retry hint).
 * The free-tier metric is 10 req/min on a key shared with other fleet agents,
 * so 429s clear over a ~60s sliding window — wait long enough to ride it out
 * before giving up. */
function retryWaitMs(body, status, attempt) {
  if (attempt >= 15) return null;
  if (status !== 429 && status < 500) return null;
  if (status === 429) {
    const retryMs = /Please retry in (\d+(?:\.\d+)?)ms/.exec(body)?.[1];
    return retryMs ? Math.max(Number(retryMs) + 4000, 8000) : 6000 * (attempt + 1);
  }
  return 4000 * (attempt + 1);
}

// --- TTS cache ---------------------------------------------------------------
//
// Utterances are pregenerated once into audio-cache/<sha1(text)>.wav and
// streamed from disk on every run, so the bench needs no Gemini TTS quota for
// INPUT audio (Gemini Live stays real — it only does ASR + generation). The
// voice node relays client audio to the Live API as audio/pcm;rate=16000
// (server.js sendAudio), so cached WAVs are resampled to 16kHz mono PCM16 —
// the same format the in-browser mic produces.

/** Live API input sample rate (matches server.js `audio/pcm;rate=16000`). */
export const TTS_TARGET_RATE = 16000;
export const TTS_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "audio-cache");

export function ttsCachePath(text) {
  const hash = createHash("sha1").update(text, "utf8").digest("hex");
  return path.join(TTS_CACHE_DIR, `${hash}.wav`);
}

/** Read the fmt/data chunks of a RIFF/WAVE buffer. */
function readWavChunks(buf) {
  if (
    buf.length < 44 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }
  const wav = {
    audioFormat: null,
    channels: null,
    sampleRate: null,
    bitsPerSample: null,
    data: null,
  };
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      wav.audioFormat = buf.readUInt16LE(off + 8);
      wav.channels = buf.readUInt16LE(off + 10);
      wav.sampleRate = buf.readUInt32LE(off + 12);
      wav.bitsPerSample = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      wav.data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size & 1);
  }
  if (wav.data === null) throw new Error("WAV has no data chunk");
  if (wav.sampleRate === null || wav.channels === null || wav.bitsPerSample === null) {
    throw new Error("WAV has no fmt chunk");
  }
  return wav;
}

/** Decode a fmt/data pair to 16-bit PCM samples (interleaved). */
function decodeWavPcm16(wav) {
  if (wav.audioFormat === 1 && wav.bitsPerSample === 16) {
    return Buffer.from(wav.data);
  }
  if (wav.audioFormat === 3 && wav.bitsPerSample === 32) {
    const pcm = Buffer.alloc((wav.data.length / 4) * 2);
    for (let i = 0; i < wav.data.length / 4; i += 1) {
      const f = Math.max(-1, Math.min(1, wav.data.readFloatLE(i * 4)));
      pcm.writeInt16LE(Math.round(f * 32767), i * 2);
    }
    return pcm;
  }
  if (wav.audioFormat !== 1 && wav.audioFormat !== 3) {
    throw new Error(`WAV uses unsupported format ${wav.audioFormat}`);
  }
  throw new Error(`WAV uses unsupported bit depth ${wav.bitsPerSample}`);
}

/** Downmix interleaved stereo PCM16 to mono; mono passes through. */
function downmixPcm16(pcm, channels) {
  if (channels === 1) return pcm;
  if (channels !== 2) throw new Error(`WAV has ${channels} channels`);
  const mono = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < pcm.length / 4; i += 1) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}

/** Parse a RIFF/WAVE file into mono 16-bit PCM + its native sample rate. */
export function wavToPcm16Mono(buf) {
  const wav = readWavChunks(buf);
  const pcm = downmixPcm16(decodeWavPcm16(wav), wav.channels);
  return { pcm, rate: wav.sampleRate };
}

/** Tiny linear resampler for 16-bit mono PCM. */
export function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length >> 1;
  const outLen = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outLen << 1);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = idx < inSamples ? pcm.readInt16LE(idx << 1) : 0;
    const s1 = idx + 1 < inSamples ? pcm.readInt16LE((idx + 1) << 1) : s0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))), i << 1);
  }
  return out;
}

/** Cache hit: the pregenerated WAV resampled to the Live input rate; null on miss. */
export function cachedTts(text) {
  const cachePath = ttsCachePath(text);
  if (!existsSync(cachePath)) return null;
  try {
    const { pcm, rate } = wavToPcm16Mono(readFileSync(cachePath));
    return {
      pcm: resamplePcm16(pcm, rate, TTS_TARGET_RATE),
      rate: TTS_TARGET_RATE,
      source: `cache:${cachePath}`,
    };
  } catch (error) {
    console.warn(`[tts-cache] ignoring ${cachePath}: ${error.message}`);
    return null;
  }
}

function wavHeader(dataLen, sampleRate) {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Best-effort populate: cache the synthesized PCM as a WAV for later runs. */
export async function writeTtsCache(text, pcm, rate) {
  try {
    await mkdir(TTS_CACHE_DIR, { recursive: true });
    await writeFile(ttsCachePath(text), Buffer.concat([wavHeader(pcm.length, rate), pcm]));
  } catch (error) {
    console.warn(`[tts-cache] failed to write ${ttsCachePath(text)}: ${error.message}`);
  }
}

/** gemini-3.1-flash-tts-preview -> raw PCM (24kHz). Retries transient
 * failures and quota 429s (free-tier limit: 10 req/min — the error body
 * carries "Please retry in Nms"; the bench honors it and backs off).
 * Cache hits short-circuit to the pregenerated WAV entirely. */
export async function tts(text, attempt = 0) {
  const cached = cachedTts(text);
  if (cached) return cached;
  const apiKey = resolveGeminiApiKey();
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
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
    const waitMs = retryWaitMs(body, res.status, attempt);
    if (waitMs !== null) {
      await sleep(waitMs);
      return tts(text, attempt + 1);
    }
    throw new Error(`TTS failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const parsed = await res.json();
  const part = parsed?.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error(`TTS returned no audio: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1];
  const result = {
    pcm: Buffer.from(part.inlineData.data, "base64"),
    rate: rate ? Number(rate) : 24000,
  };
  await writeTtsCache(text, result.pcm, result.rate);
  return result;
}

export function silenceMs(ms, rate) {
  return Buffer.alloc(Math.round(rate * (ms / 1000)) * 2);
}

/** Stream PCM with mic-like cadence so the Live speech detector hears it. */
export async function streamAudio(ws, pcm, rate) {
  const chunkBytes = Math.round(rate * (CHUNK_MS / 1000)) * 2;
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm.subarray(off, off + chunkBytes));
    await sleep(30);
  }
}

/** Speak one utterance: leading silence, TTS PCM, trailing silence for VAD. */
export async function speak(ws, text, { rate = undefined } = {}) {
  const { pcm, rate: ttsRate } = await tts(text);
  const useRate = rate ?? ttsRate;
  await streamAudio(
    ws,
    Buffer.concat([silenceMs(400, useRate), pcm, silenceMs(VAD_TRAILING_SILENCE_MS, useRate)]),
    useRate,
  );
}

/** Pre-synthesize an utterance so the session can speak it without TTS latency. */
export async function preSpeak(text) {
  const { pcm, rate } = await tts(text);
  return { text, pcm, rate };
}

/** Speak a pre-synthesized utterance. */
export async function playPrepared(ws, prepared) {
  await streamAudio(
    ws,
    Buffer.concat([
      silenceMs(400, prepared.rate),
      prepared.pcm,
      silenceMs(VAD_TRAILING_SILENCE_MS, prepared.rate),
    ]),
    prepared.rate,
  );
}

function parseFrame(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { audio: data };
  }
}

/**
 * A browser-side client to the voice node. Records JSON frames (text,
 * inputText, toolLog, injected, setupAck, ...) and binary audio; waitFor
 * resolves once a recorded or future frame satisfies the predicate.
 */
export function connectBrowser(port, { host = "127.0.0.1" } = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const audioChunks = [];
  const waiters = [];
  let closed = false;

  ws.on("message", (data) => {
    const frame = parseFrame(data);
    frames.push(frame);
    if (frame.audio) {
      audioChunks.push(Buffer.from(frame.audio));
    }
    if (frame.parsed?.type === "text") {
      // Keep the transcript handy for assertions.
      frames.lastText = (frames.lastText ?? "") + frame.parsed.text;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.pred(frame)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(frame);
      }
    }
  });
  ws.on("close", () => {
    closed = true;
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("browser ws closed while waiting"));
    }
    waiters.length = 0;
  });
  ws.on("error", (err) => {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(`browser ws error: ${err.message}`));
    }
    waiters.length = 0;
  });

  const waitFor = (pred, label, timeoutMs = 120_000) => {
    const hit = frames.find((f) => f.parsed && pred(f.parsed));
    if (hit) return Promise.resolve(hit.parsed);
    const { promise, resolve, reject } = Promise.withResolvers();
    const waiter = {
      pred: (f) => Boolean(f.parsed && pred(f.parsed)),
      resolve: (f) => resolve(f.parsed),
      reject,
      timer: setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs),
    };
    waiters.push(waiter);
    return promise;
  };

  return {
    ws,
    frames,
    audioChunks,
    waitFor,
    get closed() {
      return closed;
    },
    text() {
      return frames
        .filter((f) => f.parsed?.type === "text")
        .map((f) => f.parsed.text)
        .join("");
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

export async function openSession(port, { systemInstruction } = {}) {
  const browser = connectBrowser(port);
  const { promise, resolve, reject } = Promise.withResolvers();
  browser.ws.once("open", resolve);
  browser.ws.once("error", reject);
  await promise;
  browser.ws.send(
    JSON.stringify({
      type: "init",
      ...(systemInstruction ? { systemInstruction } : {}),
    }),
  );
  await browser.waitFor((m) => m.type === "setupAck", "setupAck", 90_000);
  return browser;
}

/** Text frames from `fromIndex` on, joined. */
export function turnText(browser, fromIndex = 0) {
  return browser.frames
    .slice(fromIndex)
    .filter((f) => f.parsed?.type === "text")
    .map((f) => f.parsed.text)
    .join("");
}

export function frameIndex(browser) {
  return browser.frames.length;
}

/**
 * Wait for the model to settle on an answer after a spoken utterance: at
 * least one text frame, then a turnComplete with no further text for
 * `quietMs`. Resolves with the new text. Rejects on timeout.
 */
export async function waitForSettledAnswer(
  browser,
  { fromIndex = 0, timeoutMs = 150_000, quietMs = 6000, label = "model answer" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const firstTextAt = await waitForFrame(
    browser,
    (m) => m.type === "text" && m.text?.trim(),
    `${label} (first text)`,
    timeoutMs,
  );
  void firstTextAt;
  let lastActivity = Date.now();
  while (Date.now() < deadline) {
    const newText = turnText(browser, fromIndex).length > 0;
    const hasTurnComplete = browser.frames
      .slice(fromIndex)
      .some((f) => f.parsed?.type === "turnComplete");
    if (newText && hasTurnComplete && Date.now() - lastActivity > quietMs) {
      return turnText(browser, fromIndex).trim();
    }
    const newest = browser.frames.slice(fromIndex).at(-1);
    if (newest && (newest.parsed?.type === "text" || newest.parsed?.type === "turnComplete")) {
      lastActivity = Date.now();
    }
    await sleep(500);
  }
  const got = turnText(browser, fromIndex);
  if (got.trim()) return got.trim();
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait for ANY frame matching the predicate (recorded or future). */
export async function waitForFrame(browser, pred, label, timeoutMs = 120_000) {
  return browser.waitFor(pred, label, timeoutMs);
}

// --- Session JSONL -----------------------------------------------------------

export async function findLatestSessionFile(logDir) {
  if (!existsSync(logDir)) return null;
  const entries = await readdir(logDir);
  const sessions = entries
    .filter((name) => name.endsWith(".jsonl") && name !== "latest.jsonl")
    .map((name) => path.join(logDir, name))
    .sort((a, b) => (a < b ? -1 : 1));
  return sessions[sessions.length - 1] ?? null;
}

/** Snapshot the current session JSONL for evidence. */
export async function snapshotSessionJsonl(logDir, evidencePath) {
  const latest = await findLatestSessionFile(logDir);
  if (!latest) return null;
  await copyFile(latest, evidencePath);
  return evidencePath;
}

export async function readJsonl(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  const rows = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed rows
    }
  }
  return rows;
}

/** Tool calls observed in a session JSONL: {name, args, callId, ok, summary, error, ts}. */
export function toolCallsFromJsonl(rows) {
  return rows
    .filter((r) => r.event === "tool.call")
    .map((r) => ({
      ts: r.ts,
      name: r.name,
      args: r.args ?? {},
      callId: r.callId,
      ok: null,
      summary: null,
      error: null,
    }))
    .map((call) => {
      const result = rows.find(
        (r) => r.event === "tool.result" && r.callId === call.callId && r.ts >= call.ts,
      );
      if (result) {
        call.ok = result.ok;
        call.summary = result.summary ?? null;
        call.error = result.error ?? null;
      }
      return call;
    });
}

export function callsNamed(rows, name) {
  return toolCallsFromJsonl(rows).filter((c) => c.name === name);
}

// --- Daemon-side helpers ------------------------------------------------------

/** Poll the roster until `pred` holds; returns the payload or null on timeout. */
export async function waitForRoster(client, pred, { timeoutMs = 30_000, tickMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await client.fetchAgents({});
    const entries = payload.entries ?? [];
    const snapshot = entries.map((e) => e.agent);
    if (pred(snapshot)) return snapshot;
    await sleep(tickMs);
  }
  return null;
}

/** Case-insensitive title compare: the user's SPOKEN name is what matters —
 * models may normalize capitalization ("victor" for "Victor") without
 * changing the intent. Exact-case equality would flake on that. */
export function sameTitle(a, b) {
  return (
    String(a ?? "")
      .trim()
      .toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase()
  );
}

export function agentByTitle(agents, title) {
  return agents.find((a) => sameTitle(a.title, title) || sameTitle(a.name, title)) ?? null;
}

export function countBuckets(agents) {
  const counts = { needs_you: 0, running: 0, ready: 0, done: 0, idle: 0 };
  for (const a of agents) {
    const bucket = a.bucket;
    if (bucket in counts) counts[bucket] += 1;
  }
  return counts;
}

/** Recompute the voice digest for a roster payload (same code the voice node uses). */
export function digestForAgents(agents) {
  return buildFleetRosterDigest(agents);
}

/** Extract the needs-you count from a spoken answer ("2 need you",
 * "one needs you", "both need you", "Pip and Faye need you"). */
export function parseSpokenNeedsYou(text) {
  const lower = text.toLowerCase();
  if (/\bboth\s+(?:agents?|workers?|of them)?\s+(need|are waiting|require)/.test(lower)) return 2;
  if (lower.includes("needs me one") && lower.includes("needs me two")) return 2;
  const named =
    /(?:^|[\s,.])([a-z][a-z0-9' -]{1,24}) and ([a-z][a-z0-9' -]{1,24})\s+(?:both\s+)?(?:need|are waiting|require|want)/.exec(
      lower,
    );
  if (named) return 2;
  const match =
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|no|zero|none)\s+(?:agents?|workers?|of them)?/i.exec(
      lower,
    );
  if (
    match &&
    (lower.includes("need") ||
      lower.includes("attention") ||
      lower.includes("waiting") ||
      lower.includes("require"))
  ) {
    const word = match[1].toLowerCase();
    if (word === "no" || word === "zero" || word === "none") return 0;
    const words = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    if (word in words) return words[word];
    return Number(word);
  }
  return null;
}

/** True when a spoken answer contains no raw fleet ids. */
export function hasNoSpokenIds(text) {
  return (
    !UUID_RE.test(text) && !MCP_ID_RE.test(text) && !WKS_ID_RE.test(text) && !PRJ_ID_RE.test(text)
  );
}

/** Find the first event of a kind from the live mission-control feed. */
export function waitForEvent(client, pred, { timeoutMs = 60_000 } = {}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`timed out waiting for mission-control event (${timeoutMs}ms)`));
  }, timeoutMs);
  const handler = (msg) => {
    const event = msg?.event;
    if (event && pred(event)) {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    }
  };
  const unsubscribe = client.on("mission_control_event", handler);
  // A no-op catch keeps a caller that abandons the promise (scenario setup
  // threw) from crashing the process on the timeout rejection.
  promise.catch(() => undefined);
  return promise;
}

export async function listProposalIds(client) {
  const payload = await client.missionControlEventsFetch({ limit: 500 });
  const ids = new Set();
  for (const event of payload.events ?? []) {
    if (event.kind === "proposal" && event.proposal?.id) {
      ids.add(event.proposal.id);
    }
  }
  return [...ids];
}

/** Poll the latest session JSONL until `pred(rows)` matches. */
export async function pollJsonl(logDir, pred, { timeoutMs = 120_000, tickMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let lastFile = null;
  while (Date.now() < deadline) {
    const file = await findLatestSessionFile(logDir);
    if (file) {
      const rows = await readJsonl(file);
      const hit = pred(rows);
      if (hit) return { rows, file, hit };
      last = rows;
      lastFile = file;
    }
    await sleep(tickMs);
  }
  return { rows: last, file: lastFile, hit: null };
}

export async function rosterOf(client) {
  const payload = await client.fetchAgents({});
  return (payload.entries ?? []).map((e) => e.agent);
}

/** The catalog roster (fleet_list_agents) — rows carry the server-computed
 * `bucket` and `serverId`; the raw fetchAgents payload has neither. */
export async function fleetRoster(client, args = {}) {
  const result = await client.missionControlToolsExecute({ name: "fleet_list_agents", args });
  if (!result.ok) {
    throw new Error(`fleet_list_agents failed: ${result.error}`);
  }
  return result.structuredContent?.agents ?? [];
}

/** Poll the catalog roster until `pred` holds; returns the snapshot or null. */
export async function waitForBucket(
  client,
  pred,
  { timeoutMs = 30_000, tickMs = 750, args = {} } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agents = await fleetRoster(client, args);
    if (pred(agents)) return agents;
    await sleep(tickMs);
  }
  return null;
}

export async function approveProposal(client, proposalId) {
  return client.missionControlProposalsRespond({ proposalId, action: "approve" });
}
