/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderEntry } from "./provider-config";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const { configState, daemonClient, connectionState } = vi.hoisted(() => ({
  configState: {
    config: null as MutableDaemonConfig | null,
  },
  daemonClient: {
    getDaemonConfig: vi.fn(async () => ({ requestId: "r", config: configState.config })),
    patchDaemonConfig: vi.fn(async (patch: Partial<MutableDaemonConfig>) => ({
      requestId: "r",
      config: { ...configState.config, ...patch },
    })),
  },
  connectionState: {
    isConnected: false,
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: unknown) => unknown)(
            new Proxy({}, { get: () => new Proxy({}, { get: () => 0 }) }),
          )
        : factory,
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return { Check: icon("Check"), Plus: icon("Plus"), Trash2: icon("Trash2") };
});

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  ScrollView: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityState,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
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
        onClick: () => {
          if (!disabled) onPress?.();
        },
      },
      children,
    ),
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/styles/settings", () => ({
  settingsStyles: new Proxy({}, { get: () => ({}) }),
}));

vi.mock("@/components/settings", () => ({
  SettingsSection: ({
    title,
    trailing,
    children,
  }: {
    title: string;
    trailing?: React.ReactNode;
    children?: React.ReactNode;
  }) => React.createElement("section", { "aria-label": title }, trailing, children),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? React.createElement("div", null, children) : null,
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

vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
    React.createElement("button", { type: "button", onClick: onPress }, children),
  paneContentToolbarIconSize: () => 16,
}));

vi.mock("@/components/ui/search-field", () => ({
  SearchField: () => React.createElement("input", { type: "search" }),
}));

vi.mock("./provider-refresh", () => ({
  ProviderRefreshButton: () => null,
  useCheckedLabel: () => undefined,
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => daemonClient,
  useHostRuntimeIsConnected: () => connectionState.isConnected,
  getHostRuntimeStore: () => ({ getHosts: () => [] }),
  isHostRuntimeConnected: () => false,
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

import { useHiddenModelsStore } from "@/provider-selection/hidden-models";
import { ProviderModels } from "./provider-models";

function hiddenKeys(): string[] {
  return [...useHiddenModelsStore.getState().hiddenKeys].sort();
}

const CLAUDE_ENTRY = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude Code",
  models: [
    { provider: "claude", id: "claude-opus-5", label: "Claude Opus 5" },
    { provider: "claude", id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { provider: "claude", id: "claude-haiku-3.5", label: "Claude Haiku 3.5" },
  ],
} as unknown as ProviderEntry;
const REFRESH = { checkedAt: undefined, busy: false, run: vi.fn() };

describe("ProviderModels model visibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderModels() {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ProviderModels serverId="local" entry={CLAUDE_ENTRY} refresh={REFRESH} />
        </QueryClientProvider>,
      );
    });
  }

  function press(testId: string) {
    const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    act(() => {
      button?.click();
    });
  }

  function checked(testId: string): string | null | undefined {
    return container.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-checked");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    connectionState.isConnected = false;
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["claude:claude-haiku-3.5"]) });
    configState.config = {
      mcp: { injectIntoAgents: true },
      providers: {
        claude: {
          enabled: true,
          additionalModels: [{ id: "claude-custom-1", label: "Custom Claude" }],
        },
      },
    } as unknown as MutableDaemonConfig;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("checks every model except the ones already hidden", () => {
    renderModels();

    expect(checked("model-toggle-claude-opus-5")).toBe("true");
    expect(checked("model-toggle-claude-haiku-3.5")).toBe("false");
    expect(checked("custom-model-toggle-claude-custom-1")).toBe("true");
  });

  it("hides a model instantly, without touching the daemon or the provider", () => {
    renderModels();

    press("model-toggle-claude-opus-5");

    expect(hiddenKeys()).toEqual(["claude:claude-haiku-3.5", "claude:claude-opus-5"]);
    expect(checked("model-toggle-claude-opus-5")).toBe("false");
    expect(daemonClient.patchDaemonConfig).not.toHaveBeenCalled();
    expect(REFRESH.run).not.toHaveBeenCalled();
  });

  it("unhides a model instantly", () => {
    renderModels();

    press("model-toggle-claude-haiku-3.5");

    expect(hiddenKeys()).toEqual([]);
    expect(daemonClient.patchDaemonConfig).not.toHaveBeenCalled();
  });

  it("checks and unchecks every discovered model at once", () => {
    renderModels();

    press("models-check-all-discovered");
    expect(hiddenKeys()).toEqual([]);

    press("models-uncheck-all-discovered");
    expect(hiddenKeys()).toEqual([
      "claude:claude-haiku-3.5",
      "claude:claude-opus-5",
      "claude:claude-sonnet-4.5",
    ]);
  });

  it("toggles a custom model independently of discovered ones", () => {
    renderModels();

    press("custom-model-toggle-claude-custom-1");

    expect(hiddenKeys()).toEqual(["claude:claude-custom-1", "claude:claude-haiku-3.5"]);
  });

  it("scopes hidden keys to the provider so another provider's same-named model stays visible", () => {
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["codex:claude-opus-5"]) });
    renderModels();

    expect(checked("model-toggle-claude-opus-5")).toBe("true");
  });

  it("writes visibleModels to the host when connected", async () => {
    connectionState.isConnected = true;
    configState.config = {
      ...configState.config,
      visibleModels: [
        "claude:claude-custom-1",
        "claude:claude-haiku-3.5",
        "claude:claude-opus-5",
        "claude:claude-sonnet-4.5",
      ],
    } as unknown as MutableDaemonConfig;

    renderModels();

    press("model-toggle-claude-opus-5");

    await vi.waitFor(() =>
      expect(daemonClient.patchDaemonConfig).toHaveBeenCalledWith({
        visibleModels: [
          "claude:claude-custom-1",
          "claude:claude-haiku-3.5",
          "claude:claude-sonnet-4.5",
        ],
      }),
    );
  });
});
