// Commander Voice — pure unit tests for per-session Live options
// (lib/session-options.js). Standalone: no daemon, no network.
// Run: node --test test/session-options.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveSetupPayload,
  normalizeSessionOptions,
  VOICE_NAMES,
} from "../lib/session-options.js";

test("normalizeSessionOptions drops invalid voice/thinking/VAD fields", () => {
  assert.deepEqual(normalizeSessionOptions(null), {});
  assert.deepEqual(
    normalizeSessionOptions({ voiceName: "Asteria" }),
    {},
    "unverified voice dropped",
  );
  assert.deepEqual(normalizeSessionOptions({ voiceName: "Nova" }), { voiceName: "Nova" });
  assert.deepEqual(
    normalizeSessionOptions({ thinkingLevel: "turbo" }),
    {},
    "unknown thinking level dropped",
  );
  assert.deepEqual(normalizeSessionOptions({ thinkingLevel: "high" }), { thinkingLevel: "high" });
  assert.deepEqual(
    normalizeSessionOptions({
      vad: {
        startOfSpeechSensitivity: "MEDIUM",
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        silenceDurationMs: 99999,
      },
    }),
    { vad: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW" } },
    "invalid VAD fields dropped individually, silence clamped out",
  );
  assert.deepEqual(normalizeSessionOptions({ voiceName: "Kore", thinkingLevel: "low" }), {
    voiceName: "Kore",
    thinkingLevel: "low",
  });
});

test("buildLiveSetupPayload carries session options into the Live setup", () => {
  const base = {
    model: "models/gemini-3.1-flash-live-preview",
    systemInstruction: "hi",
    tools: [{ functionDeclarations: [{ name: "x" }] }],
    resumeHandle: "h1",
  };
  const plain = buildLiveSetupPayload({ ...base, options: {} });
  assert.deepEqual(plain, {
    model: base.model,
    generationConfig: { responseModalities: ["AUDIO"] },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: { handle: "h1" },
    systemInstruction: { parts: [{ text: "hi" }] },
    tools: base.tools,
  });
  assert.equal(plain.generationConfig.thinkingConfig, undefined);
  assert.equal(plain.realtimeInputConfig, undefined);

  const full = buildLiveSetupPayload({
    ...base,
    options: {
      voiceName: "Nova",
      thinkingLevel: "high",
      vad: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", silenceDurationMs: 1200 },
    },
  });
  assert.deepEqual(full.generationConfig.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Nova" } },
  });
  assert.deepEqual(full.generationConfig.thinkingConfig, { thinkingLevel: "high" });
  assert.deepEqual(full.realtimeInputConfig, {
    automaticActivityDetection: {
      startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
      silenceDurationMs: 1200,
    },
  });
});

test("the nine verified Live voices are all selectable", () => {
  assert.equal(VOICE_NAMES.length, 9);
  for (const voice of VOICE_NAMES) {
    assert.deepEqual(normalizeSessionOptions({ voiceName: voice }), { voiceName: voice });
  }
});
