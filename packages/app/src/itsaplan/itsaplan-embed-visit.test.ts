import { describe, expect, it } from "vitest";
import { planItsaplanEmbedVisit } from "./itsaplan-embed-visit";

describe("planItsaplanEmbedVisit", () => {
  it("does not navigate a guest that was just created with the wanted url", () => {
    const visit = planItsaplanEmbedVisit({
      current: null,
      wanted: "0:http://127.0.0.1:3001",
      domReady: false,
    });

    expect(visit.navigate).toBe(false);
    expect(visit.reportLoaded).toBe(false);
    expect(visit.nextTarget).toBe("0:http://127.0.0.1:3001");
  });

  it("reports loaded when revisiting a guest that already shows the wanted page", () => {
    // The regression this guards: the pane unmounts on every navigation away,
    // so a revisit finds a live, loaded guest and no load event will ever fire
    // again. Reporting nothing left the screen on its spinner over a working
    // pane, which looked exactly like the embed had stopped working.
    const visit = planItsaplanEmbedVisit({
      current: "0:http://127.0.0.1:3001",
      wanted: "0:http://127.0.0.1:3001",
      domReady: true,
    });

    expect(visit.navigate).toBe(false);
    expect(visit.reportLoaded).toBe(true);
  });

  it("stays quiet when revisiting a guest that is still loading", () => {
    // Its own did-finish-load is still coming, so claiming ready here would
    // clear the spinner over a blank page.
    const visit = planItsaplanEmbedVisit({
      current: "0:http://127.0.0.1:3001",
      wanted: "0:http://127.0.0.1:3001",
      domReady: false,
    });

    expect(visit.navigate).toBe(false);
    expect(visit.reportLoaded).toBe(false);
  });

  it("navigates when the origin changes", () => {
    const visit = planItsaplanEmbedVisit({
      current: "0:http://127.0.0.1:3001",
      wanted: "0:http://10.7.0.1:3001",
      domReady: true,
    });

    expect(visit.navigate).toBe(true);
    expect(visit.reportLoaded).toBe(false);
    expect(visit.nextTarget).toBe("0:http://10.7.0.1:3001");
  });

  it("navigates on Retry even though the origin is unchanged", () => {
    // Retry bumps the attempt, which is the only thing distinguishing it from a
    // plain revisit of a page that failed to load.
    const visit = planItsaplanEmbedVisit({
      current: "0:http://127.0.0.1:3001",
      wanted: "1:http://127.0.0.1:3001",
      domReady: true,
    });

    expect(visit.navigate).toBe(true);
    expect(visit.reportLoaded).toBe(false);
  });
});
