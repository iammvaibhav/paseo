// Commander Voice — environment config. Secrets come from env or are read
// over ssh at launch; nothing secret is ever committed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeSessionOptions } from "./session-options.js";

const require = createRequire(import.meta.url);

/**
 * Resolve the Gemini API key at launch: GEMINI_API_KEY env wins; otherwise
 * read iammvaibhav:/home/ubuntu/llm-gateway/.env over ssh (dev convenience);
 * finally fall back to that path when running on the commander host itself.
 */
export function resolveGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }
  try {
    const res = spawnSync(
      "ssh",
      ["iammvaibhav", "grep -E '^GEMINI_API_KEY=' /home/ubuntu/llm-gateway/.env | head -1"],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (res.status === 0) {
      const match = res.stdout.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // fall through to the local file
  }
  const envPath = "/home/ubuntu/llm-gateway/.env";
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(/^GEMINI_API_KEY=(.*)$/m);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  throw new Error(
    "GEMINI_API_KEY not found (set the env var, or read it over ssh from iammvaibhav:/home/ubuntu/llm-gateway/.env)",
  );
}

// Advertise a real client version so the daemon does not treat this node as a
// legacy client (which hides non-legacy providers and returns zero agents).
const CLIENT_APP_VERSION = require("../../../packages/client/package.json").version;

export function loadConfig() {
  // Session options (voice name, thinking level, VAD) come from env; the
  // client init frame can override them per session. Invalid values are
  // dropped by normalizeSessionOptions — the node falls back to defaults.
  const envOptions = normalizeSessionOptions({
    voiceName: process.env.VOICE_NAME,
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL,
    vad: {
      startOfSpeechSensitivity: process.env.GEMINI_VAD_START_SENSITIVITY,
      endOfSpeechSensitivity: process.env.GEMINI_VAD_END_SENSITIVITY,
      silenceDurationMs: process.env.GEMINI_VAD_SILENCE_MS,
    },
  });
  return {
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || "0.0.0.0",
    paseoWsUrl: process.env.PASEO_WS_URL || "ws://127.0.0.1:6768/ws",
    paseoPassword: process.env.PASEO_PASSWORD || "",
    paseoClientVersion: process.env.PASEO_CLIENT_VERSION || CLIENT_APP_VERSION,
    geminiApiKey: resolveGeminiApiKey(),
    geminiModel: process.env.GEMINI_MODEL || "models/gemini-3.1-flash-live-preview",
    voiceName: envOptions.voiceName ?? "Puck",
    thinkingLevel: envOptions.thinkingLevel ?? null,
    vad: envOptions.vad ?? null,
    // voiceMode: "relay" (default) routes every mutating intent through
    // commander_dispatch; "direct" declares the full Commander allowlist.
    // Central config (mission_control.config.get) overrides this after
    // connect when it carries voiceMode.
    voiceMode: process.env.VOICE_MODE === "direct" ? "direct" : "relay",
    updateBufferCap: Number(process.env.UPDATE_BUFFER_CAP || 64),
    tlsKeyPath: process.env.TLS_KEY_PATH || null,
    tlsCertPath: process.env.TLS_CERT_PATH || null,
    sessionLogDir: process.env.VOICE_SESSION_LOG_DIR || null,
  };
}
