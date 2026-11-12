/**
 * Pure geometry for the Agent Grid: no React, no store, no I/O. The grid
 * shows `visibleCount` tiles per screen in a fixed shape; scrolling along
 * one axis reveals the rest of `itemCount` tiles at that same tile size.
 */

export type AgentGridDirection = "horizontal" | "vertical";

export interface AgentGridLayoutInput {
  itemCount: number;
  visibleCount: number;
  direction: AgentGridDirection;
  /** Viewport size in px. */
  width: number;
  height: number;
  /** Gap in px between tiles, both axes. */
  gap: number;
}

export interface AgentGridLayout {
  direction: AgentGridDirection;
  /** Visible shape: tiles per viewport row/column. */
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Total scrollable content size (>= viewport). */
  contentWidth: number;
  contentHeight: number;
  /**
   * Top-left offset of tile `index`. vertical: row-major (fills a row, then
   * the next row). horizontal: column-major (fills a column top→bottom,
   * then the next column).
   */
  placeTile(index: number): { x: number; y: number };
}

/**
 * Among divisor pairs (columns, rows) of `visibleCount`, pick the one whose
 * tile aspect ratio is closest to square — minimising the log-aspect
 * distance treats "2x too wide" and "2x too tall" as equally bad. Ties (a
 * viewport as wide as it is tall) favour more columns, since the loop keeps
 * the last equally-good candidate as `columns` increases.
 */
function resolveAgentGridShape(
  visibleCount: number,
  width: number,
  height: number,
): { columns: number; rows: number } {
  let bestColumns = 1;
  let bestRows = visibleCount;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= visibleCount; columns += 1) {
    if (visibleCount % columns !== 0) {
      continue;
    }
    const rows = visibleCount / columns;
    const tileAspect = width / columns / (height / rows);
    const score = Math.abs(Math.log(tileAspect));
    if (score <= bestScore) {
      bestScore = score;
      bestColumns = columns;
      bestRows = rows;
    }
  }
  return { columns: bestColumns, rows: bestRows };
}

export function resolveAgentGridLayout(input: AgentGridLayoutInput): AgentGridLayout {
  const { itemCount, visibleCount, direction, width, height, gap } = input;

  if (width <= 0 || height <= 0) {
    return {
      direction,
      columns: 1,
      rows: 1,
      tileWidth: 0,
      tileHeight: 0,
      contentWidth: Math.max(0, width),
      contentHeight: Math.max(0, height),
      placeTile: () => ({ x: 0, y: 0 }),
    };
  }

  const { columns, rows } = resolveAgentGridShape(visibleCount, width, height);
  const tileWidth = (width - gap * (columns - 1)) / columns;
  const tileHeight = (height - gap * (rows - 1)) / rows;

  const placeTile =
    direction === "vertical"
      ? (index: number) => ({
          x: (index % columns) * (tileWidth + gap),
          y: Math.floor(index / columns) * (tileHeight + gap),
        })
      : (index: number) => ({
          x: Math.floor(index / rows) * (tileWidth + gap),
          y: (index % rows) * (tileHeight + gap),
        });

  let contentWidth = width;
  let contentHeight = height;
  if (direction === "vertical") {
    const totalRows = itemCount > 0 ? Math.ceil(itemCount / columns) : 0;
    contentHeight = Math.max(height, totalRows * tileHeight + Math.max(0, totalRows - 1) * gap);
  } else {
    const totalColumns = itemCount > 0 ? Math.ceil(itemCount / rows) : 0;
    contentWidth = Math.max(width, totalColumns * tileWidth + Math.max(0, totalColumns - 1) * gap);
  }

  return {
    direction,
    columns,
    rows,
    tileWidth,
    tileHeight,
    contentWidth,
    contentHeight,
    placeTile,
  };
}

/**
 * Index range [start, end) of tiles that should mount their full stream:
 * those intersecting the viewport at `scrollOffset` (along the scroll axis)
 * plus `overscanTiles` extra tiles on each side. Clamped to [0, itemCount].
 */
export function resolveAgentGridWindow(
  layout: AgentGridLayout,
  itemCount: number,
  scrollOffset: number,
  overscanTiles = 0,
): { start: number; end: number } {
  if (itemCount <= 0) {
    return { start: 0, end: 0 };
  }

  // Tiles sharing a "line" along the scroll axis (a row for vertical
  // scroll, a column for horizontal scroll); the shape's other dimension is
  // how many lines fit the viewport at once.
  const crossCount = layout.direction === "vertical" ? layout.columns : layout.rows;
  const linesPerViewport = layout.direction === "vertical" ? layout.rows : layout.columns;
  const tileSize = layout.direction === "vertical" ? layout.tileHeight : layout.tileWidth;
  const origin = layout.placeTile(0);
  const nextLine = layout.placeTile(crossCount);
  const step = layout.direction === "vertical" ? nextLine.y - origin.y : nextLine.x - origin.x;

  if (tileSize <= 0 || step <= 0) {
    // Degenerate (zero-size) viewport: no geometry to window against, so
    // mounting everything is the only safe answer.
    return { start: 0, end: itemCount };
  }

  const viewportExtent = tileSize + Math.max(0, linesPerViewport - 1) * step;
  const clampedOffset = Math.max(0, scrollOffset);
  const firstLine = Math.floor(clampedOffset / step);
  // Subtract an epsilon so a viewport edge landing exactly on a tile
  // boundary does not pull in the next, invisible line.
  const lastLine = Math.floor((clampedOffset + viewportExtent - 1e-6) / step);

  const start = Math.min(itemCount, Math.max(0, firstLine * crossCount - overscanTiles));
  const end = Math.min(itemCount, Math.max(0, (lastLine + 1) * crossCount + overscanTiles));
  return { start, end: Math.max(start, end) };
}
