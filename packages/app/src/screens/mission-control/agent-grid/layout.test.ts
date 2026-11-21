import { describe, expect, it } from "vitest";
import { resolveAgentGridLayout, resolveAgentGridWindow } from "./layout";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

describe("resolveAgentGridLayout shape", () => {
  it.each([
    [4, 2, 2],
    [6, 3, 2],
    [8, 4, 2],
    [9, 3, 3],
    [12, 4, 3],
    [16, 4, 4],
  ])("packs %i tiles into %i x %i at 1280x720", (visibleCount, expectedColumns, expectedRows) => {
    const layout = resolveAgentGridLayout({
      itemCount: visibleCount,
      visibleCount,
      direction: "vertical",
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      gap: 0,
    });
    expect(layout.columns).toBe(expectedColumns);
    expect(layout.rows).toBe(expectedRows);
  });

  it("collapses to a zero-size, single-cell layout when the viewport has no area", () => {
    const layout = resolveAgentGridLayout({
      itemCount: 5,
      visibleCount: 6,
      direction: "vertical",
      width: 0,
      height: 0,
      gap: 8,
    });
    expect(layout.columns).toBe(1);
    expect(layout.rows).toBe(1);
    expect(layout.tileWidth).toBe(0);
    expect(layout.tileHeight).toBe(0);
    expect(layout.contentWidth).toBe(0);
    expect(layout.contentHeight).toBe(0);
    expect(layout.placeTile(4)).toEqual({ x: 0, y: 0 });
  });
});

describe("resolveAgentGridLayout placement", () => {
  it("places tiles row-major for vertical scroll and grows contentHeight for the overflow row", () => {
    const layout = resolveAgentGridLayout({
      itemCount: 7,
      visibleCount: 6,
      direction: "vertical",
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      gap: 0,
    });
    expect([layout.columns, layout.rows]).toEqual([3, 2]);
    expect(layout.placeTile(0)).toEqual({ x: 0, y: 0 });
    expect(layout.placeTile(2)).toEqual({ x: layout.tileWidth * 2, y: 0 });
    expect(layout.placeTile(3)).toEqual({ x: 0, y: layout.tileHeight });
    expect(layout.placeTile(6)).toEqual({ x: 0, y: layout.tileHeight * 2 });
    expect(layout.contentWidth).toBe(VIEWPORT_WIDTH);
    expect(layout.contentHeight).toBeCloseTo(layout.tileHeight * 3);
    expect(layout.contentHeight).toBeGreaterThanOrEqual(VIEWPORT_HEIGHT);
  });

  it("places tiles column-major for horizontal scroll and grows contentWidth for the overflow column", () => {
    const layout = resolveAgentGridLayout({
      itemCount: 7,
      visibleCount: 6,
      direction: "horizontal",
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      gap: 0,
    });
    expect([layout.columns, layout.rows]).toEqual([3, 2]);
    expect(layout.placeTile(0)).toEqual({ x: 0, y: 0 });
    expect(layout.placeTile(1)).toEqual({ x: 0, y: layout.tileHeight });
    expect(layout.placeTile(2)).toEqual({ x: layout.tileWidth, y: 0 });
    expect(layout.placeTile(6)).toEqual({ x: layout.tileWidth * 3, y: 0 });
    expect(layout.contentHeight).toBe(VIEWPORT_HEIGHT);
    expect(layout.contentWidth).toBeCloseTo(layout.tileWidth * 4);
    expect(layout.contentWidth).toBeGreaterThanOrEqual(VIEWPORT_WIDTH);
  });
});

describe("resolveAgentGridWindow", () => {
  const layout = resolveAgentGridLayout({
    itemCount: 7,
    visibleCount: 6,
    direction: "vertical",
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    gap: 0,
  });

  it("windows to the first two rows at offset 0", () => {
    expect(resolveAgentGridWindow(layout, 7, 0)).toEqual({ start: 0, end: 6 });
  });

  it("windows to the trailing overflow row after scrolling one full page, clamped to itemCount", () => {
    const onePage = layout.tileHeight * layout.rows;
    expect(resolveAgentGridWindow(layout, 7, onePage)).toEqual({
      start: 6,
      end: 7,
    });
  });

  it("pads the window by overscanTiles on each side, clamped to [0, itemCount]", () => {
    expect(resolveAgentGridWindow(layout, 7, 0, 3)).toEqual({
      start: 0,
      end: 7,
    });
  });

  it("stays finite and in range for a zero-size viewport", () => {
    const zeroLayout = resolveAgentGridLayout({
      itemCount: 5,
      visibleCount: 6,
      direction: "vertical",
      width: 0,
      height: 0,
      gap: 8,
    });
    const window = resolveAgentGridWindow(zeroLayout, 5, 0);
    expect(Number.isFinite(window.start)).toBe(true);
    expect(Number.isFinite(window.end)).toBe(true);
    expect(window.start).toBeGreaterThanOrEqual(0);
    expect(window.end).toBeLessThanOrEqual(5);
    expect(window.start).toBeLessThanOrEqual(window.end);
  });
});
