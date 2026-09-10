import { describe, expect, it } from "vitest";
import { SPACING } from "@/styles/theme";
import {
  resolveTurnFooterBottomSpacing,
  TURN_FOOTER_BOTTOM_SPACING,
  TURN_FOOTER_COMPACT_BOTTOM_SPACING,
} from "./turn-footer-spacing";

describe("resolveTurnFooterBottomSpacing", () => {
  it("keeps the full action-row inset in the comfortable pane", () => {
    expect(resolveTurnFooterBottomSpacing("comfortable")).toBe(TURN_FOOTER_BOTTOM_SPACING);
    expect(TURN_FOOTER_BOTTOM_SPACING).toBe(SPACING[8]);
  });

  it("collapses the inset in compact tiles so stream text can use the height", () => {
    expect(resolveTurnFooterBottomSpacing("compact")).toBe(TURN_FOOTER_COMPACT_BOTTOM_SPACING);
    expect(TURN_FOOTER_COMPACT_BOTTOM_SPACING).toBe(SPACING[2]);
    expect(TURN_FOOTER_COMPACT_BOTTOM_SPACING).toBeLessThan(TURN_FOOTER_BOTTOM_SPACING);
  });
});
