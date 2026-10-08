/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { overlapsVisibleWebview } from "./webview-overlap";

function place(
  element: HTMLElement,
  box: { left: number; top: number; width: number; height: number },
) {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }) as DOMRect;
}

function mountWebview(
  wrapperStyle: Partial<CSSStyleDeclaration>,
  wrapperBox: Parameters<typeof place>[1],
) {
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, wrapperStyle);
  place(wrapper, wrapperBox);
  const webview = document.createElement("webview");
  place(webview, { left: 0, top: 0, width: 1280, height: 800 });
  wrapper.appendChild(webview);
  document.body.appendChild(wrapper);
  return { wrapper, webview };
}

const MENU = { left: 300, top: 200, right: 520, bottom: 420 };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("overlapsVisibleWebview", () => {
  it("ignores a parked webview: full size, but inside a 1x1 clipped wrapper", () => {
    mountWebview({ overflow: "hidden" }, { left: 0, top: 0, width: 1, height: 1 });
    expect(overlapsVisibleWebview(MENU, document)).toBe(false);
  });

  it("counts a webview shown in its pane", () => {
    mountWebview({ overflow: "hidden" }, { left: 0, top: 0, width: 1280, height: 800 });
    expect(overlapsVisibleWebview(MENU, document)).toBe(true);
  });

  it("ignores the part of a webview clipped away by its pane", () => {
    mountWebview({ overflow: "hidden" }, { left: 600, top: 0, width: 680, height: 800 });
    expect(overlapsVisibleWebview(MENU, document)).toBe(false);
    expect(overlapsVisibleWebview({ ...MENU, left: 500, right: 700 }, document)).toBe(true);
  });

  it("ignores a hidden webview", () => {
    mountWebview({ visibility: "hidden" }, { left: 0, top: 0, width: 1280, height: 800 });
    expect(overlapsVisibleWebview(MENU, document)).toBe(false);
  });
});
