/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineryMessageRow } from "./machinery-message-row";

vi.mock("@/utils/time", () => ({
  formatTimeAgo: () => "just now",
}));

describe("MachineryMessageRow", () => {
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
  });

  it("renders the muted placeholder copy, never the raw machinery prompt", () => {
    act(() => {
      root?.render(<MachineryMessageRow timestamp={1_752_000_000_000} />);
    });
    const text = container?.textContent ?? "";
    expect(text).toContain("Mission Control asked for a status");
    // The placeholder receives no prompt text at all — the raw nudge body can
    // never leak into the agent's chat.
    expect(text).not.toContain("quiet for a while");
    expect(text).not.toContain("report_status");
  });
});
