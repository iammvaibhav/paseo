import { SPACING } from "@/styles/theme";

export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];
export const TURN_FOOTER_COMPACT_BOTTOM_SPACING = SPACING[2];

export type TurnFooterDensity = "comfortable" | "compact";

/** Compact grid tiles keep a small gap; the full pane keeps the action-row inset. */
export function resolveTurnFooterBottomSpacing(density: TurnFooterDensity): number {
  return density === "compact" ? TURN_FOOTER_COMPACT_BOTTOM_SPACING : TURN_FOOTER_BOTTOM_SPACING;
}
