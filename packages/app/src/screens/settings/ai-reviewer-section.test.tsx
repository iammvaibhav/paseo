/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { AiReviewerSection } from "./ai-reviewer-section";

const state = vi.hoisted(() => ({
  connected: true,
  aiReviewerSupported: true,
  config: {
    aiReviewer: {
      enabled: false,
      provider: "codex",
      model: "gpt-5.4",
      policy: "Escalate write commands.",
    },
  } as MutableDaemonConfig | null,
  patchConfig: vi.fn(async () => undefined),
  snapshot: {
    entries: [
      {
        provider: "codex",
        status: "ready",
        models: [
          { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" },
          { provider: "codex", id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        ],
      },
    ] as ProviderSnapshotEntry[],
    isLoading: false,
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => state.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => {
    if (feature === "aiReviewer") return state.aiReviewerSupported;
    return false;
  },
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: state.config,
    patchConfig: state.patchConfig,
  }),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    testID,
  }: {
    value: boolean;
    onValueChange: (val: boolean) => void;
    testID?: string;
  }) =>
    React.createElement("input", {
      type: "checkbox",
      "data-testid": testID,
      checked: value,
      onChange: (event: { target: { checked: boolean } }) => onValueChange(event.target.checked),
    }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, onClick: onPress, disabled },
      children,
    ),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => state.snapshot,
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: ({
    selectedProvider,
    selectedModel,
    onSelect,
  }: {
    selectedProvider?: string;
    selectedModel?: string;
    onSelect?: (provider: string, model: string) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "combined-model-selector" },
      React.createElement("span", null, `${selectedProvider}/${selectedModel}`),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "mock-select-model",
          onClick: () => onSelect?.("codex", "gpt-5.4-mini"),
        },
        "Select Mini",
      ),
    ),
}));

describe("AiReviewerSection", () => {
  beforeEach(() => {
    state.connected = true;
    state.aiReviewerSupported = true;
    state.config = {
      aiReviewer: {
        enabled: false,
        provider: "codex",
        model: "gpt-5.4",
        policy: "Escalate write commands.",
      },
    } as MutableDaemonConfig;
    state.patchConfig.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders null when host is not connected", () => {
    state.connected = false;
    render(<AiReviewerSection serverId="host-1" />);
    expect(screen.queryByTestId("host-page-ai-reviewer-card")).toBeNull();
  });

  it("renders null when aiReviewer feature is not supported", () => {
    state.aiReviewerSupported = false;
    render(<AiReviewerSection serverId="host-1" />);
    expect(screen.queryByTestId("host-page-ai-reviewer-card")).toBeNull();
  });

  it("renders card and controls when connected and supported", () => {
    render(<AiReviewerSection serverId="host-1" />);
    expect(screen.getByTestId("host-page-ai-reviewer-card")).toBeDefined();
    expect(screen.getByTestId("host-page-ai-reviewer-enabled")).toBeDefined();
    expect(screen.getByTestId("host-page-ai-reviewer-policy")).toBeDefined();
    expect(screen.getByText("codex/gpt-5.4")).toBeDefined();
  });

  it("toggles enabled switch and patches config", () => {
    render(<AiReviewerSection serverId="host-1" />);
    const switchEl = screen.getByTestId("host-page-ai-reviewer-enabled");
    fireEvent.click(switchEl);
    expect(state.patchConfig).toHaveBeenCalledWith({
      aiReviewer: expect.objectContaining({ enabled: true }),
    });
  });

  it("updates reviewer model on select", () => {
    render(<AiReviewerSection serverId="host-1" />);
    const selectBtn = screen.getByTestId("mock-select-model");
    fireEvent.click(selectBtn);
    expect(state.patchConfig).toHaveBeenCalledWith({
      aiReviewer: expect.objectContaining({
        provider: "codex",
        model: "codex/gpt-5.4-mini",
      }),
    });
  });

  it("clears model when clear button is clicked", () => {
    render(<AiReviewerSection serverId="host-1" />);
    const clearBtn = screen.getByTestId("host-page-ai-reviewer-model-clear");
    fireEvent.click(clearBtn);
    expect(state.patchConfig).toHaveBeenCalledWith({
      aiReviewer: expect.objectContaining({
        provider: "",
        model: "",
      }),
    });
  });

  it("patches policy on blur", () => {
    render(<AiReviewerSection serverId="host-1" />);
    const textarea = screen.getByTestId("host-page-ai-reviewer-policy");
    fireEvent.change(textarea, { target: { value: "New updated policy." } });
    fireEvent.blur(textarea);
    expect(state.patchConfig).toHaveBeenCalledWith({
      aiReviewer: expect.objectContaining({
        policy: "New updated policy.",
      }),
    });
  });

  it("clears policy when Clear policy button is pressed", () => {
    render(<AiReviewerSection serverId="host-1" />);
    const clearBtn = screen.getByTestId("host-page-ai-reviewer-policy-clear");
    fireEvent.click(clearBtn);
    expect(state.patchConfig).toHaveBeenCalledWith({
      aiReviewer: expect.objectContaining({
        policy: "",
      }),
    });
  });
});
