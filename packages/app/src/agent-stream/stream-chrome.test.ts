import { describe, expect, it } from "vitest";
import { resolveStreamTurnChrome } from "./stream-chrome";

describe("resolveStreamTurnChrome", () => {
  it("keeps the live and completed footers in the full pane", () => {
    expect(resolveStreamTurnChrome({ chrome: "full", readOnly: false })).toEqual({
      includeTurnFooter: true,
      density: "comfortable",
      suppressTurnActions: false,
    });
  });

  it("hides every turn footer in compact grid tiles", () => {
    expect(resolveStreamTurnChrome({ chrome: "compact", readOnly: false })).toEqual({
      includeTurnFooter: false,
      density: "compact",
      suppressTurnActions: true,
    });
  });

  it("still suppresses actions when the full pane is read-only", () => {
    expect(resolveStreamTurnChrome({ chrome: "full", readOnly: true }).suppressTurnActions).toBe(
      true,
    );
    expect(resolveStreamTurnChrome({ chrome: "full", readOnly: true }).includeTurnFooter).toBe(
      true,
    );
  });
});
