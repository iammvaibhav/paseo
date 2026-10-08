/**
 * @vitest-environment jsdom
 */
import React, { act, type ComponentType, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarViewToggle } from "./sidebar-view-toggle";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

const { theme } = vi.hoisted(() => ({
  theme: {
    borderWidth: { 1: 1 },
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderRadius: { md: 6, lg: 8, xl: 12, full: 9999 },
    fontSize: { xs: 12, sm: 12, base: 14 },
    fontWeight: { normal: "400" },
    opacity: { 50: 0.5 },
    colors: {
      border: "#444444",
      borderAccent: "#555555",
      accent: "#007acc",
      foreground: "#ffffff",
      foregroundMuted: "#aaaaaa",
      surface2: "#222222",
      surface3: "#333333",
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
  withUnistyles: (
    Component: ComponentType<Record<string, unknown>>,
    mapping?: (value: typeof theme) => Record<string, unknown>,
  ) => {
    return function WrappedWithUnistyles(props: Record<string, unknown>): ReactElement {
      const staticProps = mapping ? mapping(theme) : undefined;
      const dynamicProps =
        typeof props.uniProps === "function"
          ? (props.uniProps as (t: typeof theme) => Record<string, unknown>)(theme)
          : (props.uniProps as Record<string, unknown> | undefined);
      return <Component {...staticProps} {...props} {...dynamicProps} />;
    };
  },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    React.forwardRef<HTMLSpanElement, Record<string, unknown>>(function MockIcon(
      { uniProps: _uniProps, ...props },
      ref,
    ) {
      return React.createElement("span", { ...props, "data-icon": name, ref });
    });
  return {
    Bot: createIcon("Bot"),
    FolderKanban: createIcon("FolderKanban"),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe("SidebarViewToggle", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    useSidebarViewStore.setState({ viewMode: "workspaces" });
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
  it("switches view mode on click and updates selection", () => {
    act(() => {
      root?.render(<SidebarViewToggle />);
    });

    const workspacesButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-view-toggle-workspaces"]',
    );
    const agentsButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-view-toggle-agents"]',
    );

    expect(workspacesButton?.getAttribute("aria-selected")).toBe("true");
    expect(agentsButton?.getAttribute("aria-selected")).toBe("false");
    expect(useSidebarViewStore.getState().viewMode).toBe("workspaces");

    act(() => {
      agentsButton?.click();
    });

    expect(useSidebarViewStore.getState().viewMode).toBe("agents");
    expect(agentsButton?.getAttribute("aria-selected")).toBe("true");
    expect(workspacesButton?.getAttribute("aria-selected")).toBe("false");

    act(() => {
      workspacesButton?.click();
    });

    expect(useSidebarViewStore.getState().viewMode).toBe("workspaces");
    expect(workspacesButton?.getAttribute("aria-selected")).toBe("true");
    expect(agentsButton?.getAttribute("aria-selected")).toBe("false");
  });

  it("renders with agents selected when initialized with persisted mode", () => {
    useSidebarViewStore.setState({ viewMode: "agents" });

    act(() => {
      root?.render(<SidebarViewToggle />);
    });

    const workspacesButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-view-toggle-workspaces"]',
    );
    const agentsButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-view-toggle-agents"]',
    );

    expect(agentsButton?.getAttribute("aria-selected")).toBe("true");
    expect(workspacesButton?.getAttribute("aria-selected")).toBe("false");
    expect(useSidebarViewStore.getState().viewMode).toBe("agents");
  });
});
