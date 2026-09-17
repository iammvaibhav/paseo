/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import type { FeedCardEvent } from "./feed-card";

const { toastErrorMock, respondMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  respondMock: vi.fn(),
}));

const theme = {
  colors: {
    foregroundMuted: "#888888",
    foregroundExtraMuted: "#777777",
    foreground: "#eeeeee",
    surface: "#202020",
    surface0: "#111111",
    surface1: "#222222",
    surface2: "#333333",
    border: "#444444",
    statusDanger: "#d8847b",
  },
  spacing: [0, 4, 8, 12, 16],
  borderRadius: { none: 0, sm: 4, md: 8 },
  fontSize: { xs: 12, sm: 14 },
  fontWeight: { medium: "500" },
  fontFamily: { mono: "monospace" },
};

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (value: typeof theme) => unknown)(theme)
        : factory,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => Component,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return React.createElement("span", { ...props, "data-icon": name });
    };
  return {
    Bot: icon("Bot"),
    ChevronDown: icon("ChevronDown"),
    Clock: icon("Clock"),
    ShieldCheck: icon("ShieldCheck"),
  };
});

vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: () => null,
}));
vi.mock("@/mission-control/central-config", () => ({
  useMissionControlCentralConfig: () => ({ config: { hideAgentNames: false } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ missionControlProposalsRespond: respondMock }),
  }),
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: toastErrorMock }),
}));
vi.mock("@/hooks/use-compact-time-ago", () => ({
  useLiveTimeAgo: () => "just now",
}));
vi.mock("@/components/host-glyph", () => ({
  HostGlyph: ({ label, size, testID }: { label: string; size: string; testID: string }) => (
    <span data-testid={testID} data-host-label={label} data-size={size} />
  ),
}));
vi.mock("@/components/settings-textarea", () => ({
  SettingsTextArea: function SettingsTextArea({
    value,
    onChangeText,
    testID,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    testID?: string;
    placeholder?: string;
  }) {
    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText?.(event.currentTarget.value),
      [onChangeText],
    );
    return (
      <textarea
        data-testid={testID}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
      />
    );
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => <input type="checkbox" /> }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const { ProposalCard } = await import("./proposal-card");

const proposal: MissionControlProposal = {
  id: "mcp_approve_fail",
  createdAt: "2026-08-09T00:00:00.000Z",
  origin: "commander",
  serverId: "srv_commander",
  targetAgentId: "",
  message: "Spawn learning-llm smoke test",
  deliveryMode: "interrupt",
  reason: "Commander spawn",
  classification: "normal",
  kind: "spawn",
  status: "pending",
  spawnPlan: {
    host: "macbook",
    provider: "omp",
    model: "opencode-zen/deepseek-v4-flash-free",
    summary: "Spawn learning-llm smoke test",
  },
};

const event: FeedCardEvent = {
  id: "mce_1",
  ts: new Date().toISOString(),
  agentId: "",
  agentTitle: "Commander",
  kind: "proposal",
  source: "system",
  severity: "blocker",
  headline: "Proposal (commander): Commander spawn",
  serverId: "srv_commander",
  serverLabel: "iammvaibhav",
  proposal,
};

describe("ProposalCard respond failure surfacing", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    toastErrorMock.mockReset();
    respondMock.mockReset();
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

  it("surfaces a failed spawn approve as a toast (never silent)", async () => {
    // Regression: the respond RPC used to return ok:true while the spawn
    // failed, so Approve showed nothing. The RPC now returns ok:false with
    // the executor error; the card must surface it via the app toast.
    respondMock.mockResolvedValue({
      requestId: "req-1",
      ok: false,
      error: "spawn failed: Error: Provider nope is not configured",
    });

    act(() => {
      root?.render(<ProposalCard proposal={proposal} event={event} />);
    });

    const approveButton = container?.querySelector(
      '[data-testid="mission-control-proposal-approve"]',
    );
    expect(approveButton).toBeTruthy();

    await act(async () => {
      (approveButton as HTMLButtonElement).click();
    });

    expect(respondMock).toHaveBeenCalledWith({
      proposalId: "mcp_approve_fail",
      action: "approve",
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "spawn failed: Error: Provider nope is not configured",
    );
    // The inline card error mirrors the toast so the failure is visible even
    // if the feed re-renders the card from its aggregated event.
    expect(container?.textContent).toContain(
      "spawn failed: Error: Provider nope is not configured",
    );
  });

  it("deny reveals an optional reason input and sends the reason through", async () => {
    respondMock.mockResolvedValue({ requestId: "req-deny-reason", ok: true });

    act(() => {
      root?.render(<ProposalCard proposal={proposal} event={event} />);
    });

    const denyButton = () =>
      container?.querySelector(
        '[data-testid="mission-control-proposal-deny"]',
      ) as HTMLButtonElement;
    expect(denyButton()).toBeTruthy();

    // First press reveals the optional reason field; no RPC yet.
    await act(async () => {
      denyButton().click();
    });
    const reasonInput = container?.querySelector(
      '[data-testid="mission-control-proposal-deny-reason-input"]',
    ) as HTMLTextAreaElement;
    expect(reasonInput).toBeTruthy();
    expect(respondMock).not.toHaveBeenCalled();

    // Type a reason into the revealed field (native setter so React's
    // controlled-input tracker can't revert the DOM value).
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(reasonInput, "Run it on gamma instead.");
      reasonInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Second press submits the deny with the reason attached.
    await act(async () => {
      denyButton().click();
    });
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(respondMock).toHaveBeenCalledWith({
      proposalId: "mcp_approve_fail",
      action: "deny",
      reason: "Run it on gamma instead.",
    });
  });

  it("skipping the reason (empty or whitespace) sends a plain deny", async () => {
    respondMock.mockResolvedValue({ requestId: "req-deny-plain", ok: true });

    act(() => {
      root?.render(<ProposalCard proposal={proposal} event={event} />);
    });

    const denyButton = () =>
      container?.querySelector(
        '[data-testid="mission-control-proposal-deny"]',
      ) as HTMLButtonElement;

    // Reveal the reason field and type only whitespace (skippable).
    await act(async () => {
      denyButton().click();
    });
    const reasonInput = container?.querySelector(
      '[data-testid="mission-control-proposal-deny-reason-input"]',
    ) as HTMLTextAreaElement;
    expect(reasonInput).toBeTruthy();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(reasonInput, "   ");
      reasonInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      denyButton().click();
    });
    // Whitespace-only reason is trimmed away: the RPC carries a plain deny
    // with no reason key.
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(respondMock).toHaveBeenCalledWith({
      proposalId: "mcp_approve_fail",
      action: "deny",
    });
  });

  it("cancel closes the reason field without sending", async () => {
    respondMock.mockResolvedValue({ requestId: "req-deny-cancel", ok: true });

    act(() => {
      root?.render(<ProposalCard proposal={proposal} event={event} />);
    });

    const denyButton = () =>
      container?.querySelector(
        '[data-testid="mission-control-proposal-deny"]',
      ) as HTMLButtonElement;
    await act(async () => {
      denyButton().click();
    });
    expect(
      container?.querySelector('[data-testid="mission-control-proposal-deny-reason-input"]'),
    ).toBeTruthy();

    const cancelButton = container?.querySelector(
      '[data-testid="mission-control-proposal-cancel-deny-reason"]',
    ) as HTMLButtonElement;
    expect(cancelButton).toBeTruthy();
    await act(async () => {
      cancelButton.click();
    });

    // The field is gone, the deny button is back to its reveal state, and no
    // RPC was ever sent.
    expect(
      container?.querySelector('[data-testid="mission-control-proposal-deny-reason-input"]'),
    ).toBeNull();
    expect(respondMock).not.toHaveBeenCalled();
    await act(async () => {
      denyButton().click();
    });
    expect(
      container?.querySelector('[data-testid="mission-control-proposal-deny-reason-input"]'),
    ).toBeTruthy();
  });
});
