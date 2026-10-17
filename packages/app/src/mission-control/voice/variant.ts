/**
 * M9 Commander Voice — composer swap gating.
 *
 * The Mission Control composer (the Commander thread's composer) shows the
 * "Commander Voice" button instead of the stock Paseo voice-mode button only
 * when ALL of:
 *   - the composer is the Commander thread composer (call-site fact: this
 *     resolver is only consulted there — every other agent chat keeps stock
 *     voice mode untouched), and
 *   - the runtime is web/Electron (native keeps stock voice mode; getUserMedia
 *     + Web Audio are DOM APIs), and
 *   - the central-config knob voiceNodeUrl is set (the voice node must exist;
 *     empty = feature hidden, stock voice button remains).
 */
export type ComposerVoiceVariant = "stock" | "commander";

export function resolveComposerVoiceVariant(input: {
  isWeb: boolean;
  voiceNodeUrl: string | null | undefined;
}): ComposerVoiceVariant {
  if (input.isWeb && input.voiceNodeUrl?.trim()) {
    return "commander";
  }
  return "stock";
}
