/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Radar } from "lucide-react-native";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
    borderRadius: { lg: 8, full: 9999 },
    fontSize: { xs: 12, sm: 14 },
    fontWeight: { normal: "400" },
    colors: {
      border: "#444444",
      foreground: "#ffffff",
      foregroundMuted: "#aaaaaa",
      palette: { white: "#ffffff" },
      statusDanger: "#9d433b",
      statusSuccess: "#3e704a",
      surfaceSidebarHover: "#222222",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (value: typeof theme) => unknown)(theme)
        : factory,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => Component,
}));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("lucide-react-native", () => ({
  Radar: React.forwardRef<HTMLSpanElement, Record<string, unknown>>(function MockRadar(
    { uniProps: _uniProps, ...props },
    ref,
  ) {
    return React.createElement("span", { ...props, ref });
  }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const { SidebarHeaderRow } = await import("./sidebar-header-row");

const handlePress = vi.fn();

describe("SidebarHeaderRow mission-control badges", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
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

  it("renders non-zero attention and success counts as colored circles", () => {
    act(() => {
      root?.render(
        <SidebarHeaderRow
          icon={Radar}
          label="Mission Control"
          onPress={handlePress}
          variant="compact"
          badgeSegments={[
            {
              count: 1,
              label: "needs you",
              testID: "needs-you",
              tone: "attention",
            },
            {
              count: 9,
              label: "ready for review",
              testID: "ready",
              tone: "success",
            },
          ]}
        />,
      );
    });

    const attention = container?.querySelector('[data-testid="needs-you"]') as HTMLElement | null;
    const success = container?.querySelector('[data-testid="ready"]') as HTMLElement | null;

    expect(attention?.style.width).toBe("16px");
    expect(attention?.style.height).toBe("16px");
    expect(attention?.style.borderTopLeftRadius).toBe("9999px");
    expect(attention?.style.backgroundColor).toBe("rgb(157, 67, 59)");
    expect(attention?.getAttribute("aria-label")).toBe("1 needs you");
    expect((attention?.firstElementChild as HTMLElement | null)?.style.color).toBe(
      "rgb(255, 255, 255)",
    );
    expect(success?.style.backgroundColor).toBe("rgb(62, 112, 74)");
  });

  it("omits zero-count segments", () => {
    act(() => {
      root?.render(
        <SidebarHeaderRow
          icon={Radar}
          label="Mission Control"
          onPress={handlePress}
          badgeSegments={[
            { count: 0, label: "needs you", testID: "needs-you", tone: "attention" },
            { count: 2, label: "ready for review", testID: "ready", tone: "success" },
          ]}
        />,
      );
    });

    expect(container?.querySelector('[data-testid="needs-you"]')).toBeNull();
    expect(container?.querySelector('[data-testid="ready"]')?.textContent).toBe("2");
  });
});
