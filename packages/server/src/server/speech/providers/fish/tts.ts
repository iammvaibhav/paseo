import type pino from "pino";
import { Readable } from "node:stream";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type FishTtsLatency = "low" | "balanced" | "normal";
export type FishTtsFormat = "mp3" | "wav" | "pcm";

export interface FishTtsConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Fish reference_id / voice id. */
  voice?: string;
  latency?: FishTtsLatency;
  speed?: number;
  format?: FishTtsFormat;
  normalize?: boolean;
}

export const DEFAULT_FISH_TTS_MODEL = "s2.1-pro-free";
export const DEFAULT_FISH_TTS_VOICE = "933563129e564b19a115bedd57b7406a";
export const DEFAULT_FISH_TTS_LATENCY: FishTtsLatency = "balanced";
export const DEFAULT_FISH_TTS_SPEED = 1.35;
export const DEFAULT_FISH_TTS_BASE_URL = "https://api.fish.audio";

export class FishTTS implements TextToSpeechProvider {
  private readonly config: Required<
    Pick<
      FishTtsConfig,
      "apiKey" | "baseUrl" | "model" | "voice" | "latency" | "speed" | "format" | "normalize"
    >
  >;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: FishTtsConfig, parentLogger: pino.Logger) {
    this.config = {
      apiKey: ttsConfig.apiKey,
      baseUrl: (ttsConfig.baseUrl ?? DEFAULT_FISH_TTS_BASE_URL).replace(/\/+$/, ""),
      model: ttsConfig.model ?? DEFAULT_FISH_TTS_MODEL,
      voice: ttsConfig.voice ?? DEFAULT_FISH_TTS_VOICE,
      latency: ttsConfig.latency ?? DEFAULT_FISH_TTS_LATENCY,
      speed: ttsConfig.speed ?? DEFAULT_FISH_TTS_SPEED,
      format: ttsConfig.format ?? "mp3",
      normalize: ttsConfig.normalize ?? true,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "fish", component: "tts" });
    this.logger.info(
      {
        model: this.config.model,
        voice: this.config.voice,
        latency: this.config.latency,
        speed: this.config.speed,
        format: this.config.format,
      },
      "TTS (Fish Audio) initialized",
    );
  }

  public getConfig(): typeof this.config {
    return this.config;
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    const startTime = Date.now();
    const endpoint = `${this.config.baseUrl}/v1/tts`;
    const body: Record<string, unknown> = {
      text: trimmed,
      reference_id: this.config.voice,
      format: this.config.format,
      latency: this.config.latency,
      normalize: this.config.normalize,
    };
    if (this.config.speed !== 1) {
      body.prosody = { speed: this.config.speed };
    }

    this.logger.debug(
      { textLength: trimmed.length, preview: trimmed.substring(0, 50) },
      "Synthesizing speech via Fish Audio",
    );

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          model: this.config.model,
          Accept: "*/*",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error({ err: error }, "Fish Audio request failed");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Fish TTS synthesis failed: ${message}`, { cause: error });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      this.logger.error(
        { status: response.status, errorBody: errorBody.slice(0, 500) },
        "Fish Audio returned an error",
      );
      throw new Error(
        `Fish TTS synthesis failed: HTTP ${response.status}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Fish TTS synthesis failed: empty response body");
    }

    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    this.logger.debug({ duration: Date.now() - startTime }, "Fish Audio speech stream ready");

    return {
      stream,
      format: this.config.format,
    };
  }
}
