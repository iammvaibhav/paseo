/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

const { theme, snapshotState, configState, patchConfigMock, refreshMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { xs: 11, sm: 13, base: 15, code: 12 },
    fontFamily: { mono: "monospace" },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { sm: 4, base: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1, 2: 2 },
    opacity: { 50: 0.5 },
    colors: {
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff3b30",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, white: "#fff" },
    },
  },
  snapshotState: {
    entries: undefined as ProviderSnapshotEntry[] | undefined,
    isLoading: false,
    isRefreshing: false,
  },
  configState: {
    config: null as MutableDaemonConfig | null,
  },
  patchConfigMock: vi.fn(async () => undefined),
  refreshMock: vi.fn(async () => undefined),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock("react-native-unistyles", () => ({
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    AlertTriangle: icon("AlertTriangle"),
    Check: icon("Check"),
    Copy: icon("Copy"),
    FileText: icon("FileText"),
    Plus: icon("Plus"),
    RotateCw: icon("RotateCw"),
    Trash2: icon("Trash2"),
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityState,
    disabled,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean };
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-checked": accessibilityState?.checked,
        "data-testid": testID,
        disabled,
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          if (!disabled) onPress?.();
        },
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    ),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    visible,
    header,
    footer,
    testID,
  }: {
    children?: React.ReactNode;
    visible?: boolean;
    header?: { title?: string };
    footer?: React.ReactNode;
    testID?: string;
  }) =>
    visible
      ? React.createElement(
          "div",
          { "data-testid": testID },
          header?.title ? React.createElement("h2", null, header.title) : null,
          children,
          footer,
        )
      : null,
  AdaptiveTextInput: (props: Record<string, unknown>) => React.createElement("input", { ...props }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        disabled,
        "data-testid": testID,
        "aria-label": accessibilityLabel,
      },
      children,
    ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshotState.entries,
    isLoading: snapshotState.isLoading,
    isRefreshing: snapshotState.isRefreshing,
    refresh: refreshMock,
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.name) return `${key}:${opts.name}`;
      if (opts?.id) return `${key}:${opts.id}`;
      return key;
    },
  }),
}));

import { ProviderDiagnosticSheet } from "./provider-diagnostic-sheet";

describe("ProviderDiagnosticSheet model visibility checkboxes and bulk actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const handleClose = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();

    snapshotState.entries = [
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: "Claude Code",
        models: [
          { provider: "claude", id: "claude-opus-5", label: "Claude Opus 5" },
          { provider: "claude", id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
          { provider: "claude", id: "claude-haiku-3.5", label: "Claude Haiku 3.5" },
        ],
      },
    ];

    configState.config = {
      mcp: { injectIntoAgents: true },
      providers: {
        claude: {
          enabled: true,
          hiddenModels: ["claude-haiku-3.5"],
          additionalModels: [{ id: "claude-custom-1", label: "Custom Claude" }],
        },
      },
    } as unknown as MutableDaemonConfig;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders checkboxes for discovered models with correct checked states", () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });
    const opusToggle = container.querySelector('[data-testid="model-toggle-claude-opus-5"]');
    const sonnetToggle = container.querySelector('[data-testid="model-toggle-claude-sonnet-4.5"]');
    const haikuToggle = container.querySelector('[data-testid="model-toggle-claude-haiku-3.5"]');

    expect(opusToggle?.getAttribute("aria-checked")).toBe("true");
    expect(sonnetToggle?.getAttribute("aria-checked")).toBe("true");
    expect(haikuToggle?.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles model from visible to hidden via patchConfig", async () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });

    const opusToggle = container.querySelector(
      '[data-testid="model-toggle-claude-opus-5"]',
    ) as HTMLButtonElement;
    expect(opusToggle).toBeTruthy();

    await act(async () => {
      opusToggle.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          hiddenModels: ["claude-haiku-3.5", "claude-opus-5"],
        },
      },
    });
  });

  it("toggles model from hidden to visible via patchConfig", async () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });

    const haikuToggle = container.querySelector(
      '[data-testid="model-toggle-claude-haiku-3.5"]',
    ) as HTMLButtonElement;
    expect(haikuToggle).toBeTruthy();

    await act(async () => {
      haikuToggle.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          hiddenModels: [],
        },
      },
    });
  });

  it("triggers check all to unhide all discovered models", async () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });

    const checkAllBtn = container.querySelector(
      '[data-testid="models-check-all-discovered"]',
    ) as HTMLButtonElement;
    expect(checkAllBtn).toBeTruthy();

    await act(async () => {
      checkAllBtn.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          hiddenModels: [],
        },
      },
    });
  });

  it("triggers uncheck all to hide all discovered models", async () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });

    const uncheckAllBtn = container.querySelector(
      '[data-testid="models-uncheck-all-discovered"]',
    ) as HTMLButtonElement;
    expect(uncheckAllBtn).toBeTruthy();

    await act(async () => {
      uncheckAllBtn.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          hiddenModels: ["claude-haiku-3.5", "claude-opus-5", "claude-sonnet-4.5"],
        },
      },
    });
  });
  it("toggles custom model visibility and triggers check/uncheck all for custom models", async () => {
    act(() => {
      root.render(
        <ProviderDiagnosticSheet
          provider="claude"
          serverId="local"
          visible={true}
          onClose={handleClose}
        />,
      );
    });

    const customToggle = container.querySelector(
      '[data-testid="custom-model-toggle-claude-custom-1"]',
    ) as HTMLButtonElement;
    expect(customToggle).toBeTruthy();
    expect(customToggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      customToggle.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          hiddenModels: ["claude-haiku-3.5", "claude-custom-1"],
        },
      },
    });
  });
});
