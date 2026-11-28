import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import { resolveFishSpeechConfig } from "./config.js";

const FISH_TTS: RequestedSpeechProviders = {
  dictationStt: { provider: "local", explicit: false },
  voiceTurnDetection: { provider: "local", explicit: false },
  voiceStt: { provider: "local", explicit: false },
  voiceTts: { provider: "fish", explicit: true },
};

describe("resolveFishSpeechConfig", () => {
  test("returns undefined when voice TTS is not fish", () => {
    const resolved = resolveFishSpeechConfig({
      env: { FISH_AUDIO_API_KEY: "fish-key" } as NodeJS.ProcessEnv,
      persisted: PersistedConfigSchema.parse({}),
      providers: {
        ...FISH_TTS,
        voiceTts: { provider: "local", explicit: false },
      },
    });
    expect(resolved).toBeUndefined();
  });

  test("resolves env key and defaults for model/voice/latency/speed", () => {
    const resolved = resolveFishSpeechConfig({
      env: {
        FISH_AUDIO_API_KEY: "  fish-env-key  ",
      } as NodeJS.ProcessEnv,
      persisted: PersistedConfigSchema.parse({}),
      providers: FISH_TTS,
    });

    expect(resolved?.tts).toMatchObject({
      apiKey: "fish-env-key",
      model: "s2.1-pro-free",
      voice: "933563129e564b19a115bedd57b7406a",
      latency: "balanced",
      speed: 1.35,
      format: "mp3",
    });
  });

  test("prefers persisted fish provider config over env", () => {
    const resolved = resolveFishSpeechConfig({
      env: {
        FISH_AUDIO_API_KEY: "env-key",
        FISH_AUDIO_TTS_MODEL: "env-model",
        FISH_AUDIO_TTS_VOICE: "env-voice",
        FISH_AUDIO_TTS_LATENCY: "low",
        FISH_AUDIO_TTS_SPEED: "1.1",
      } as NodeJS.ProcessEnv,
      persisted: PersistedConfigSchema.parse({
        providers: {
          fish: {
            apiKey: "config-key",
            baseUrl: " https://fish.example.com ",
            model: "config-model",
            voice: "config-voice",
            latency: "normal",
            speed: 1.2,
          },
        },
        features: {
          voiceMode: {
            tts: {
              provider: "fish",
              model: "feature-model",
              voice: "feature-voice",
              speed: 1.5,
            },
          },
        },
      }),
      providers: FISH_TTS,
    });

    expect(resolved?.tts).toMatchObject({
      apiKey: "config-key",
      baseUrl: "https://fish.example.com",
      // env model/voice override feature + provider defaults intentionally for ops knobs
      model: "env-model",
      voice: "env-voice",
      latency: "low",
      speed: 1.1,
      format: "mp3",
    });
  });
});
