#!/usr/bin/env node
// Commander Voice — E2E audio proof. Synthesizes a spoken command, streams the
// PCM into the Gemini Live session through the voice proxy, captures the audio
// + transcript reply, and asserts fleet_list_agents was called. Artifacts land in
// /tmp/commander-voice-e2e/.
//
// TTS: fish.audio when FISH_AUDIO_API_KEY is set and has credit; otherwise the
// macOS `say` binary falls back to local synthesis (documented in receipts).
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { WebSocket } from "ws";

import { startVoiceServer } from "../server.js";

const OUT_DIR = process.env.E2E_OUT_DIR || "/tmp/commander-voice-e2e";
const PROXY_PORT = Number(process.env.PROXY_PORT || 8801);
const COMMAND = "what is the fleet status";
// Trailing silence appended after the TTS PCM so the Live API's speech
// detector sees the utterance end. VoiceE2E: ~4s utterances intermittently
// fail ASR at 900ms and reliably pass at 2.5s.
const VAD_TRAILING_SILENCE_MS = 2500;
const E2E_PROMPT =
  "You are a terse voice relay for the Commander. When asked for the fleet status, call fleet_list_agents " +
  "and read its result aloud in one sentence. Keep every reply under 20 words.";

// --- TTS -------------------------------------------------------------------

/** fish.audio TTS. Throws on quota/credit failure (HTTP 402). */
function synthesizeWithFish(text) {
  const key = process.env.FISH_AUDIO_API_KEY;
  if (!key) {
    throw new Error("FISH_AUDIO_API_KEY not set");
  }
  const res = spawnSync(
    "curl",
    [
      "-s",
      "-X",
      "POST",
      "https://api.fish.audio/v1/tts",
      "-H",
      `Authorization: Bearer ${key}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ text, format: "pcm", sample_rate: 16000 }),
      "--max-time",
      "60",
    ],
    { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`fish.audio curl failed (${res.status})`);
  }
  const body = res.stdout;
  const looksJson = body.length < 2048 && body[0] === 0x7b; // '{'
  if (looksJson) {
    const parsed = JSON.parse(body.toString("utf8"));
    throw new Error(
      `fish.audio error: ${parsed.message ?? JSON.stringify(parsed)} (${parsed.status})`,
    );
  }
  return { pcm: body, source: "fish.audio" };
}

/** macOS say -> afconvert -> raw PCM16 @ 16kHz mono. */
async function synthesizeWithSay(text) {
  const aiff = `${OUT_DIR}/tts-command.aiff`;
  const wav = `${OUT_DIR}/tts-command.wav`;
  const say = spawnSync("say", ["-o", aiff, text], { encoding: "utf8" });
  if (say.status !== 0) {
    throw new Error(`say failed: ${say.stderr}`);
  }
  const af = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], {
    encoding: "utf8",
  });
  if (af.status !== 0) {
    throw new Error(`afconvert failed: ${af.stderr}`);
  }
  const wavBuf = await readFile(wav);
  return { pcm: wavToPcm(wavBuf), source: "macos-say" };
}

/**
 * Google's own TTS model (needs GEMINI_API_KEY). Proven recognizable by the
 * Live ASR; output is audio/L16 PCM @ 24000.
 */
async function synthesizeWithGemini(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const res = spawnSync(
    "curl",
    [
      "-s",
      "-X",
      "POST",
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
        },
      }),
      "--max-time",
      "60",
    ],
    { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`gemini TTS curl failed (${res.status})`);
  }
  const parsed = JSON.parse(res.stdout.toString("utf8"));
  const part = parsed?.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error(`gemini TTS returned no audio: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const pcm = Buffer.from(part.inlineData.data, "base64");
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1];
  return { pcm, source: "gemini-2.5-flash-preview-tts", rate: rate ? Number(rate) : 24000 };
}

function wavToPcm(buf) {
  let off = 12; // skip RIFF header
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      return buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in wav");
}

/** Silence (zeros) so the model's VAD sees the utterance end. */
function silenceMs(ms) {
  return Buffer.alloc(Math.round(RATE * (ms / 1000)) * 2);
}

// --- Headless browser client ----------------------------------------------

function parseFrame(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { audio: data };
  }
}

function connectBrowser() {
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const waiters = [];
  const audioChunks = [];
  ws.on("message", (data) => {
    const frame = parseFrame(data);
    frames.push(frame);
    if (frame.audio) {
      audioChunks.push(Buffer.from(frame.audio));
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred(frame)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(frame);
      }
    }
  });
  const waitFor = (pred, label, timeoutMs = 120_000) => {
    const hit = frames.find((f) => f.parsed && pred(f.parsed));
    if (hit) {
      return Promise.resolve(hit.parsed);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        pred: (f) => Boolean(f.parsed && pred(f.parsed)),
        resolve: (f) => resolve(f.parsed),
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  return { ws, frames, audioChunks, waitFor };
}

// --- Main ------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });

const { close } = await startVoiceServer({ port: PROXY_PORT });

let tts;
const ttsNotes = [];
const preMadePcm = process.env.E2E_TTS_PCM;
if (preMadePcm) {
  tts = { pcm: await readFile(preMadePcm), source: "pre-made (gemini-2.5-flash-preview-tts)" };
  ttsNotes.push(`TTS: using pre-synthesized PCM from ${preMadePcm}`);
} else if (process.env.FISH_AUDIO_API_KEY) {
  try {
    tts = synthesizeWithFish(COMMAND);
    ttsNotes.push("fish.audio: success");
  } catch (error) {
    ttsNotes.push(`fish.audio: BLOCKED — ${error.message}`);
    try {
      tts = await synthesizeWithGemini(COMMAND);
      ttsNotes.push("fish.audio: fell back to gemini-2.5-flash-preview-tts");
    } catch (geminiError) {
      ttsNotes.push(`gemini TTS: BLOCKED — ${geminiError.message}`);
      tts = await synthesizeWithSay(COMMAND);
      ttsNotes.push("fish.audio/gemini TTS: fell back to macOS say");
    }
  }
} else {
  try {
    tts = await synthesizeWithGemini(COMMAND);
    ttsNotes.push("fish.audio: FISH_AUDIO_API_KEY not set; using gemini-2.5-flash-preview-tts");
  } catch (error) {
    ttsNotes.push(`gemini TTS: BLOCKED — ${error.message}; using macOS say`);
    tts = await synthesizeWithSay(COMMAND);
  }
}
const RATE = Number(process.env.E2E_PCM_RATE || tts.rate || 16000);
await writeFile(`${OUT_DIR}/tts-command.pcm`, tts.pcm);
await writeFile(`${OUT_DIR}/tts-command.txt`, COMMAND);

console.log(`TTS: ${tts.source} (${tts.pcm.length} bytes)`);

const browser = connectBrowser();
await new Promise((resolve, reject) => {
  browser.ws.once("open", resolve);
  browser.ws.once("error", reject);
});
browser.ws.send(JSON.stringify({ type: "init", systemInstruction: E2E_PROMPT }));
await browser.waitFor((m) => m.type === "setupAck", "setupAck");

// Stream the utterance as audio + trailing silence for VAD. The Live API's
// speech detector needs mic-like cadence (small paced chunks), not one blob.
const stream = Buffer.concat([silenceMs(400), tts.pcm, silenceMs(VAD_TRAILING_SILENCE_MS)]);
const chunkBytes = Math.round(RATE * 0.16) * 2; // 160ms per chunk
for (let off = 0; off < stream.length; off += chunkBytes) {
  browser.ws.send(stream.subarray(off, off + chunkBytes));
  await new Promise((r) => setTimeout(r, 30));
}
console.log(`streamed ${stream.length} bytes of PCM audio (mic cadence, ${RATE}Hz)`);

const toolLog = await browser.waitFor(
  (m) => m.type === "toolLog" && m.name === "fleet_list_agents",
  "fleet_list_agents toolLog",
  180_000,
);
console.log("TOOL CALLED:", toolLog.name);

// Wait for the spoken reply: audio bytes + the output transcription.
await new Promise((resolve) => {
  const deadline = Date.now() + 120_000;
  const tick = () => {
    const totalAudio = browser.audioChunks.reduce((a, b) => a + b.length, 0);
    const hasText = browser.frames.some(
      (f) => f.parsed?.type === "text" && f.parsed.text.length > 20,
    );
    if ((totalAudio > 2000 && hasText) || Date.now() > deadline) {
      return resolve();
    }
    setTimeout(tick, 500);
  };
  tick();
});

const transcript = browser.frames
  .filter((f) => f.parsed?.type === "text")
  .map((f) => f.parsed.text)
  .join("");
const replyPcm = Buffer.concat(browser.audioChunks);

await writeFile(`${OUT_DIR}/reply.pcm`, replyPcm);
await writeFile(`${OUT_DIR}/reply-transcript.txt`, transcript);
await writeFile(
  `${OUT_DIR}/receipts.json`,
  JSON.stringify(
    {
      command: COMMAND,
      tts: { source: tts.source, pcmBytes: tts.pcm.length, notes: ttsNotes },
      toolCalled: toolLog.name,
      transcript,
      replyPcmBytes: replyPcm.length,
      audioChunkCount: browser.audioChunks.length,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);

// WAV-wrapped reply for playback.
const wavHeader = Buffer.alloc(44);
wavHeader.write("RIFF", 0);
wavHeader.writeUInt32LE(36 + replyPcm.length, 4);
wavHeader.write("WAVE", 8);
wavHeader.write("fmt ", 12);
wavHeader.writeUInt32LE(16, 16);
wavHeader.writeUInt16LE(1, 20);
wavHeader.writeUInt16LE(1, 22);
wavHeader.writeUInt32LE(RATE, 24);
wavHeader.writeUInt32LE(RATE * 2, 28);
wavHeader.writeUInt16LE(2, 32);
wavHeader.writeUInt16LE(16, 34);
wavHeader.write("data", 36);
wavHeader.writeUInt32LE(replyPcm.length, 40);
await writeFile(`${OUT_DIR}/reply.wav`, Buffer.concat([wavHeader, replyPcm]));

console.log("TRANSCRIPT:", transcript.slice(0, 300));
console.log(`ARTIFACTS: ${OUT_DIR}/`);
console.log(ttsNotes.join("\n"));

browser.ws.close();
await close();
