import type { TurnFooterDensity } from "./turn-footer-spacing";

export type StreamChrome = "full" | "compact";

export interface StreamTurnChrome {
  /** Completed per-item footers and the live running footer. Compact tiles hide both. */
  includeTurnFooter: boolean;
  density: TurnFooterDensity;
  suppressTurnActions: boolean;
}

/**
 * Grid tiles use `compact`: stream only, no fork/copy/jump, no elapsed footer.
 * The inspector and agent window keep `full`.
 */
export function resolveStreamTurnChrome(input: {
  chrome: StreamChrome;
  readOnly: boolean;
}): StreamTurnChrome {
  const compact = input.chrome === "compact";
  return {
    includeTurnFooter: !compact,
    density: compact ? "compact" : "comfortable",
    suppressTurnActions: input.readOnly || compact,
  };
}
