/**
 * M9 Commander Voice — native no-op. Mic capture + PCM playback need DOM APIs
 * (getUserMedia, AudioContext), so the feature is web/Electron-only; native
 * keeps the stock Paseo voice mode. The web implementation
 * (voice-audio.web.ts) is the real one.
 */

export interface VoiceAudioSession {
  startMic(onAudioChunk: (pcm16: ArrayBuffer) => void): Promise<void>;
  /** Stop capture only; playback keeps working (the Live session stays live). */
  stopMic(): void;
  playPcm(pcm16: ArrayBuffer): void;
  flushPlayback(): void;
  stop(): void;
}

export function createVoiceAudioSession(): VoiceAudioSession {
  return {
    async startMic() {
      throw new Error("Commander Voice is not available on native");
    },
    stopMic() {},
    playPcm() {},
    flushPlayback() {},
    stop() {},
  };
}
