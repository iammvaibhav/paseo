/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchoredList } from "./anchored-list";
import type { StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

interface TestRow {
  id: string;
  label: string;
}

function row(id: string): TestRow {
  return { id, label: id };
}

const ROWS = [row("r1"), row("r2")];

// Module scope (react-perf: no new function literals in JSX prop position).
const ROW_KEY_EXTRACTOR = (item: TestRow) => item.id;

function renderInput(viewportRef: React.RefObject<StreamViewportHandle | null>) {
  return {
    agentId: "agent",
    segments: {
      historyVirtualized: [] as TestRow[],
      historyMounted: ROWS,
      liveHead: [] as TestRow[],
    },
    boundary: {
      hasVirtualizedHistory: false,
      hasMountedHistory: true,
      hasLiveHead: false,
    },
    renderers: {
      renderHistoryVirtualizedRow: (item: TestRow) => <div>{item.id}</div>,
      renderHistoryMountedRow: (item: TestRow) => <div>{item.id}</div>,
      renderLiveHeadRow: (item: TestRow) => <div>{item.id}</div>,
      renderLiveAuxiliary: () => null,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearHistoryStart: vi.fn().mockReturnValue(true),
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: null,
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
  };
}

describe("AnchoredList", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalScrollTo: HTMLElement["scrollTo"] | undefined;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
    });
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    if (originalScrollTo) {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
    vi.restoreAllMocks();
  });

  function renderSurface(props: Partial<React.ComponentProps<typeof AnchoredList<TestRow>>> = {}) {
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: false });
    const viewportRef = React.createRef<StreamViewportHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AnchoredList
          {...renderInput(viewportRef)}
          strategy={strategy}
          viewportRef={viewportRef}
          keyExtractor={ROW_KEY_EXTRACTOR}
          {...props}
        />,
      );
    });
    return { viewportRef, strategy };
  }

  function scrollContainer(): HTMLElement {
    const element = container?.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(element instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    return element;
  }

  it("renders the strategy viewport rows and reports the initial near-bottom state", () => {
    const onNearBottomChange = vi.fn();
    renderSurface({ onNearBottomChange });

    expect(container?.textContent).toContain("r1");
    expect(container?.textContent).toContain("r2");
    expect(onNearBottomChange).toHaveBeenCalledWith(true);
    // Near the tail on entry: no jump-to-bottom affordance yet.
    expect(container?.querySelector('[data-testid="scroll-to-bottom-button"]')).toBeNull();
  });

  it("shows the default affordance when the user scrolls away and hides it at the tail", () => {
    const onNearBottomChange = vi.fn();
    renderSurface({ onNearBottomChange });

    const element = scrollContainer();
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });

    // Scroll away from the tail: the viewport reports not-near-bottom and the
    // shared affordance appears, exactly like the agent chat.
    Object.defineProperty(element, "scrollTop", { configurable: true, value: 400 });
    act(() => {
      element.dispatchEvent(new Event("scroll"));
    });
    expect(onNearBottomChange).toHaveBeenLastCalledWith(false);
    expect(container?.querySelector('[data-testid="scroll-to-bottom-button"]')).not.toBeNull();

    // Back at the tail: affordance disappears.
    Object.defineProperty(element, "scrollTop", { configurable: true, value: 700 });
    act(() => {
      element.dispatchEvent(new Event("scroll"));
    });
    expect(container?.querySelector('[data-testid="scroll-to-bottom-button"]')).toBeNull();
  });

  it("presses the affordance through the viewport handle by default", () => {
    renderSurface();
    const element = scrollContainer();
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element, "scrollTop", { configurable: true, value: 400 });
    act(() => {
      element.dispatchEvent(new Event("scroll"));
    });

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    const button = container?.querySelector('[data-testid="scroll-to-bottom-button"]');
    if (!(button instanceof HTMLElement)) {
      throw new Error("Expected scroll-to-bottom button");
    }
    act(() => {
      button.click();
    });
    // The default press path drives the viewport handle's scroll-to-bottom
    // (web: forceStickToBottom scrolls the container to the tail).
    expect(scrollTo).toHaveBeenCalled();
  });

  it("routes the affordance press through onScrollToBottomPress when provided", () => {
    const onScrollToBottomPress = vi.fn();
    renderSurface({ onScrollToBottomPress, forceShowScrollToBottom: true });

    const button = container?.querySelector('[data-testid="scroll-to-bottom-button"]');
    if (!(button instanceof HTMLElement)) {
      throw new Error("Expected scroll-to-bottom button");
    }
    act(() => {
      button.click();
    });
    expect(onScrollToBottomPress).toHaveBeenCalledTimes(1);
  });

  it("lets a caller replace the affordance (MC 'N new' pill) without forking the surface", () => {
    renderSurface({
      forceShowScrollToBottom: true,
      scrollToBottomAffordance: (
        <button type="button" data-testid="custom-affordance">
          2 new
        </button>
      ),
    });

    expect(container?.querySelector('[data-testid="custom-affordance"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="scroll-to-bottom-button"]')).toBeNull();
  });

  it("force-shows the affordance while near the bottom (agent chat timeline detach)", () => {
    renderSurface({ forceShowScrollToBottom: true });
    expect(container?.querySelector('[data-testid="scroll-to-bottom-button"]')).not.toBeNull();
  });
});
