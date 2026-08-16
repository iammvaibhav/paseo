// Commander Voice — per-session Live options: voice name, thinking level, VAD.
// Pure validation + setup-payload building so the node's session wiring stays
// thin and the shapes are unit-testable (test/logic.test.mjs).
//
// Verified against the Live API (2026-08): gemini-3.1-flash-live-preview
// accepts thinkingConfig.thinkingLevel (minimal|low|medium|high), the nine
// voice names below (Asteria is rejected with close 1007 "No matching speaker
// voice found"), and realtimeInputConfig.automaticActivityDetection VAD knobs.

export const VOICE_NAMES = [
  "Puck",
  "Charon",
  "Kore",
  "Zephyr",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Nova",
];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// Wire enum constants (proto3 JSON): the Live API rejects shorthand ("LOW")
// with close 1007; only the full constant name is accepted.
const START_SENSITIVITIES = new Set(["START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"]);
const END_SENSITIVITIES = new Set(["END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"]);

/**
 * Normalize untrusted session options (env, central config, or the client
 * init frame) to the shape the Live setup accepts. Invalid fields are
 * dropped; unknown keys are ignored. Returns {} when nothing valid is set.
 */
export function normalizeSessionOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.voiceName === "string" && VOICE_NAMES.includes(raw.voiceName)) {
    out.voiceName = raw.voiceName;
  }
  if (typeof raw.thinkingLevel === "string" && THINKING_LEVELS.includes(raw.thinkingLevel)) {
    out.thinkingLevel = raw.thinkingLevel;
  }
  const vad = {};
  if (raw.vad && typeof raw.vad === "object") {
    if (START_SENSITIVITIES.has(raw.vad.startOfSpeechSensitivity)) {
      vad.startOfSpeechSensitivity = raw.vad.startOfSpeechSensitivity;
    }
    if (END_SENSITIVITIES.has(raw.vad.endOfSpeechSensitivity)) {
      vad.endOfSpeechSensitivity = raw.vad.endOfSpeechSensitivity;
    }
    const silence = Number(raw.vad.silenceDurationMs);
    if (Number.isFinite(silence) && silence > 0 && silence <= 5000) {
      vad.silenceDurationMs = silence;
    }
  }
  if (Object.keys(vad).length > 0) out.vad = vad;
  return out;
}

/**
 * Build the BidiGenerateContentSetup message for a Live session. `options` is
 * the normalized session options; everything else is the node's always-on
 * session fields.
 */
export function buildLiveSetupPayload({ model, options, systemInstruction, tools, resumeHandle }) {
  const generationConfig = { responseModalities: ["AUDIO"] };
  if (options?.voiceName) {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } },
    };
  }
  if (options?.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: options.thinkingLevel };
  }
  const setup = {
    model,
    generationConfig,
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  if (options?.vad && Object.keys(options.vad).length > 0) {
    setup.realtimeInputConfig = { automaticActivityDetection: { ...options.vad } };
  }
  if (systemInstruction) {
    setup.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools) {
    setup.tools = tools;
  }
  return setup;
}
