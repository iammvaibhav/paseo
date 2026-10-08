interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Whether `rect` covers any part of an embedded browser pane (`<webview>`, such as VS Code Web)
 * that is actually on screen.
 *
 * A webview's own bounding rect is not enough: a parked webview keeps its full size at the
 * window origin inside a 1×1 `overflow: hidden` wrapper (`resident-webviews.ts`), and an
 * inactive one is clipped to its pane. So the webview's box is cut down by every clipping
 * ancestor, and hidden or transparent webviews never count.
 */
export function overlapsVisibleWebview(rect: Box, ownerDocument: Document): boolean {
  const view = ownerDocument.defaultView;
  if (!view) return false;
  for (const webview of ownerDocument.querySelectorAll("webview")) {
    const visible = visibleBox(webview, view);
    if (visible && intersectionArea(rect, visible) > 0) {
      return true;
    }
  }
  return false;
}

/** Smaller than this in either direction is a parking stub, not something the user can see. */
const MIN_VISIBLE_PX = 2;

function visibleBox(element: Element, view: Window): Box | null {
  let box: Box | null = toBox(element.getBoundingClientRect());
  for (let node: Element | null = element; node && box; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return null;
    }
    if (node !== element && clipsContent(style)) {
      box = intersect(box, toBox(node.getBoundingClientRect()));
    }
  }
  if (!box || box.right - box.left < MIN_VISIBLE_PX || box.bottom - box.top < MIN_VISIBLE_PX) {
    return null;
  }
  return box;
}

const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "scroll", "auto"]);

function clipsContent(style: CSSStyleDeclaration): boolean {
  return (
    CLIPPING_OVERFLOW.has(style.overflow) ||
    CLIPPING_OVERFLOW.has(style.overflowX) ||
    CLIPPING_OVERFLOW.has(style.overflowY) ||
    (style.clipPath !== "" && style.clipPath !== "none")
  );
}

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function intersectionArea(a: Box, b: Box): number {
  const box = intersect(a, b);
  return box ? (box.right - box.left) * (box.bottom - box.top) : 0;
}
