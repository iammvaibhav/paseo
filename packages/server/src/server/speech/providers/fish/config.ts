import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import {
  DEFAULT_FISH_TTS_BASE_URL,
  DEFAULT_FISH_TTS_LATENCY,
  DEFAULT_FISH_TTS_MODEL,
  DEFAULT_FISH_TTS_SPEED,
  DEFAULT_FISH_TTS_VOICE,
  type FishTtsConfig,
  type FishTtsLatency,
} from "./tts.js";

export interface FishSpeechProviderConfig {
  tts?: FishTtsConfig;
}

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const NumberLikeSchema = z.union([z.number(), z.string().trim().min(1)]);

const OptionalFiniteNumberSchema = NumberLikeSchema.pipe(
  z.coerce.number<string | number>().finite(),
).optional();

const FishLatencySchema = z.enum(["low", "balanced", "normal"]);

function isFishProviderActive(provider: { enabled?: boolean; provider: string }): boolean {
  return provider.enabled !== false && provider.provider === "fish";
}

function pickIfFish<T>(
  provider: { enabled?: boolean; provider: string },
  value: T | undefined,
): T | undefined {
  return isFishProviderActive(provider) ? value : undefined;
}

function firstDefined<T>(values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      continue;
    }
    return value;
  }
  return undefined;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  return OptionalTrimmedStringSchema.parse(value);
}

function resolveFishLatency(raw: string | undefined): FishTtsLatency {
  if (!raw) {
    return DEFAULT_FISH_TTS_LATENCY;
  }
  const parsed = FishLatencySchema.safeParse(raw.trim().toLowerCase());
  return parsed.success ? parsed.data : DEFAULT_FISH_TTS_LATENCY;
}

function buildFishTtsConfig(params: {
  apiKey: string;
  baseUrl: string | undefined;
  model: string | undefined;
  voice: string | undefined;
  latency: FishTtsLatency;
  speed: number | undefined;
}): FishTtsConfig {
  return {
    apiKey: params.apiKey,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    latency: params.latency,
    ...(params.speed !== undefined ? { speed: params.speed } : {}),
    format: "mp3",
    normalize: true,
  };
}

export function resolveFishSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): FishSpeechProviderConfig | undefined {
  if (!isFishProviderActive(params.providers.voiceTts)) {
    return undefined;
  }

  const fish = params.persisted.providers?.fish;
  const voiceModeTts = params.persisted.features?.voiceMode?.tts;
  const voiceTts = params.providers.voiceTts;

  const apiKey = optionalTrimmed(
    firstDefined<string>([fish?.apiKey, params.env.FISH_AUDIO_API_KEY, params.env.FISH_API_KEY]),
  );
  if (!apiKey) {
    return undefined;
  }

  const baseUrl = optionalTrimmed(
    firstDefined<string>([
      fish?.baseUrl,
      params.env.FISH_AUDIO_BASE_URL,
      params.env.FISH_API_BASE_URL,
      DEFAULT_FISH_TTS_BASE_URL,
    ]),
  );
  const model = optionalTrimmed(
    firstDefined<string>([
      params.env.FISH_AUDIO_TTS_MODEL,
      params.env.PASEO_VOICE_FISH_TTS_MODEL,
      pickIfFish(voiceTts, voiceModeTts?.model),
      fish?.model,
      DEFAULT_FISH_TTS_MODEL,
    ]),
  );
  const voice = optionalTrimmed(
    firstDefined<string>([
      params.env.FISH_AUDIO_TTS_VOICE,
      params.env.PASEO_VOICE_FISH_TTS_VOICE,
      pickIfFish(voiceTts, voiceModeTts?.voice),
      fish?.voice,
      DEFAULT_FISH_TTS_VOICE,
    ]),
  );
  const latency = resolveFishLatency(
    firstDefined<string>([
      params.env.FISH_AUDIO_TTS_LATENCY,
      params.env.PASEO_VOICE_FISH_TTS_LATENCY,
      fish?.latency,
    ]),
  );
  const speed = OptionalFiniteNumberSchema.parse(
    firstDefined<string | number>([
      params.env.FISH_AUDIO_TTS_SPEED,
      params.env.PASEO_VOICE_FISH_TTS_SPEED,
      pickIfFish(voiceTts, voiceModeTts?.speed),
      fish?.speed,
      DEFAULT_FISH_TTS_SPEED,
    ]),
  );

  return {
    tts: buildFishTtsConfig({ apiKey, baseUrl, model, voice, latency, speed }),
  };
}
