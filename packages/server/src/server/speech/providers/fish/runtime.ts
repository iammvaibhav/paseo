import type { Logger } from "pino";

import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import type { FishSpeechProviderConfig } from "./config.js";
import {
  DEFAULT_FISH_TTS_LATENCY,
  DEFAULT_FISH_TTS_MODEL,
  DEFAULT_FISH_TTS_SPEED,
  DEFAULT_FISH_TTS_VOICE,
  FishTTS,
} from "./tts.js";

export function getFishSpeechAvailability(fishConfig: FishSpeechProviderConfig | undefined): {
  tts: boolean;
} {
  return { tts: Boolean(fishConfig?.tts?.apiKey) };
}

export function validateFishCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  fishConfig: FishSpeechProviderConfig | undefined;
  logger: Logger;
}): void {
  const { providers, fishConfig, logger } = params;
  if (
    providers.voiceTts.enabled !== false &&
    providers.voiceTts.provider === "fish" &&
    !fishConfig?.tts?.apiKey
  ) {
    logger.warn(
      {
        requestedProviders: {
          voiceTts: providers.voiceTts.provider,
        },
        missingFishCredentialsFor: ["voice.tts"],
      },
      "Invalid speech configuration: Fish provider selected but FISH_AUDIO_API_KEY is missing — voice TTS will be unavailable",
    );
  }
}

export function initializeFishSpeechServices(params: {
  providers: RequestedSpeechProviders;
  fishConfig: FishSpeechProviderConfig | undefined;
  existing: SpeechServices;
  logger: Logger;
}): SpeechServices {
  const { providers, fishConfig, existing, logger } = params;
  let ttsService = existing.ttsService;

  const needsFishTts =
    !ttsService && providers.voiceTts.enabled !== false && providers.voiceTts.provider === "fish";

  if (needsFishTts && fishConfig?.tts?.apiKey) {
    logger.info("Fish Audio speech provider initialized");
    const { apiKey, ...ttsConfig } = fishConfig.tts;
    ttsService = new FishTTS(
      {
        apiKey,
        model: DEFAULT_FISH_TTS_MODEL,
        voice: DEFAULT_FISH_TTS_VOICE,
        latency: DEFAULT_FISH_TTS_LATENCY,
        speed: DEFAULT_FISH_TTS_SPEED,
        format: "mp3",
        ...ttsConfig,
      },
      logger,
    );
  }

  return {
    turnDetectionService: existing.turnDetectionService,
    sttService: existing.sttService,
    ttsService,
    dictationSttService: existing.dictationSttService,
  };
}
