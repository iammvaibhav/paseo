import type { ReactElement } from "react";

/**
 * M9 Commander Voice — native no-op. The panel needs getUserMedia + Web Audio
 * (DOM APIs), so it exists only on web/Electron; native keeps the stock Paseo
 * voice mode (the composer swap is gated on isWeb). The web implementation
 * (voice-session-panel.web.tsx) is the real one.
 */
export interface CommanderVoicePanelProps {
  /** Normalized voice node URL (ws://host:port/ws). */
  url: string;
  onClose: () => void;
}

export function CommanderVoicePanel(_props: CommanderVoicePanelProps): ReactElement | null {
  return null;
}
