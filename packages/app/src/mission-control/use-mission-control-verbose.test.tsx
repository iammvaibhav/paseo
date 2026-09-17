/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MISSION_CONTROL_VERBOSE_STORAGE_KEY,
  useMissionControlVerbose,
} from "./use-mission-control-verbose";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorage,
}));

describe("useMissionControlVerbose", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.clearAllMocks();
  });

  it("notifies every subscriber the moment the toggle flips (live, no remount)", async () => {
    const rendered: boolean[] = [];
    let toggle: (() => void) | null = null;
    function Probe() {
      const [verbose, toggleVerbose] = useMissionControlVerbose();
      toggle = toggleVerbose;
      rendered.push(verbose);
      return null;
    }

    await act(async () => {
      root?.render(<Probe />);
    });
    // Hydration resolved with null during the same act: verbose stays false.
    expect(rendered).toEqual([false]);

    act(() => {
      toggle?.();
    });
    expect(rendered).toEqual([false, true]);

    act(() => {
      toggle?.();
    });
    expect(rendered).toEqual([false, true, false]);
  });

  it("persists the flipped value to AsyncStorage", async () => {
    function Probe() {
      const [, toggleVerbose] = useMissionControlVerbose();
      return <button type="button" onClick={toggleVerbose} />;
    }

    await act(async () => {
      root?.render(<Probe />);
    });
    act(() => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(asyncStorage.setItem).toHaveBeenCalledWith(MISSION_CONTROL_VERBOSE_STORAGE_KEY, "1");
  });
});
