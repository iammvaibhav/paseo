/**
 * M9 Commander Voice — web/Electron mic capture + PCM playback, ported from
 * scripts/commander-voice/public/index.html (the proven standalone page):
 *   - capture: getUserMedia mono 16 kHz, ScriptProcessor downsample to PCM16
 *     Int16Array chunks; the voice node expects audio/pcm;rate=16000.
 *   - playback: PCM16 at 24 kHz (the Live API's audio rate) queued through an
 *     AudioContext with gap-free scheduling.
 * Only used on web/Electron (voice-session-panel.web.tsx gates the feature).
 */

const CAPTURE_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;

export interface VoiceAudioSession {
  startMic(onAudioChunk: (pcm16: ArrayBuffer) => void): Promise<void>;
  /** Stop capture only; playback keeps working (the Live session stays live). */
  stopMic(): void;
  playPcm(pcm16: ArrayBuffer): void;
  stop(): void;
}

export function createVoiceAudioSession(): VoiceAudioSession {
  let audioCtx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let scriptProcessor: ScriptProcessorNode | null = null;
  let nextStartTime = 0;
  let micStarting = false;

  async function startMic(onAudioChunk: (pcm16: ArrayBuffer) => void): Promise<void> {
    if (micStream || micStarting) {
      return;
    }
    micStarting = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone unavailable — open this page from a secure context.");
      }
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: CAPTURE_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      audioCtx = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )({
        sampleRate: PLAYBACK_SAMPLE_RATE,
      });
      const source = audioCtx.createMediaStreamSource(micStream);
      const ratio = audioCtx.sampleRate / CAPTURE_SAMPLE_RATE;
      scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const newLength = Math.floor(inputData.length / ratio);
        const pcm16 = new Int16Array(newLength);
        for (let i = 0; i < newLength; i++) {
          const originIndex = Math.floor(i * ratio);
          const sample = Math.max(-1, Math.min(1, inputData[originIndex]));
          pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        onAudioChunk(pcm16.buffer);
      };
      source.connect(scriptProcessor);
      // Keep the processor alive on browsers that require a destination path.
      scriptProcessor.connect(audioCtx.destination);
    } finally {
      micStarting = false;
    }
  }

  function playPcm(pcm16: ArrayBuffer): void {
    if (!audioCtx) {
      return;
    }
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    const int16Array = new Int16Array(pcm16);
    if (int16Array.length === 0) {
      return;
    }
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    const audioBuffer = audioCtx.createBuffer(1, float32Array.length, PLAYBACK_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Array);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (nextStartTime < now) {
      nextStartTime = now;
    }
    source.start(nextStartTime);
    nextStartTime += audioBuffer.duration;
  }

  function stopMic(): void {
    scriptProcessor?.disconnect();
    scriptProcessor = null;
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  function stop(): void {
    stopMic();
    if (audioCtx) {
      void audioCtx.close();
      audioCtx = null;
    }
    nextStartTime = 0;
  }

  return { startMic, stopMic, playPcm, stop };
}
