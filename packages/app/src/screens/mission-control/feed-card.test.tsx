/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
type FeedCardEvent = import("./feed-card").FeedCardEvent;

const { liveAgent, theme } = vi.hoisted(() => ({
  liveAgent: {
    id: "agent-1",
    name: "Worker One",
    title: "Repair mission control cards",
    shortDescription: "Polishing the shared card anatomy",
  },
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderRadius: { sm: 2, md: 6, full: 9999 },
    fontFamily: { ui: "system-ui" },
    fontSize: { xs: 12, sm: 14 },
    colors: {
      accent: "#20744a",
      border: "#333333",
      foreground: "#ffffff",
      foregroundMuted: "#aaaaaa",
      foregroundExtraMuted: "#777777",
      surface0: "#111111",
      surface1: "#222222",
      surface2: "#333333",
      statusDanger: "#d8847b",
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

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    BadgeCheck: icon("BadgeCheck"),
    Bot: icon("Bot"),
    CircleCheck: icon("CircleCheck"),
    CircleX: icon("CircleX"),
    Clock: icon("Clock"),
    Flag: icon("Flag"),
    GitBranch: icon("GitBranch"),
    GitFork: icon("GitFork"),
    LoaderCircle: icon("LoaderCircle"),
    Rocket: icon("Rocket"),
    Search: icon("Search"),
    Send: icon("Send"),
    ShieldAlert: icon("ShieldAlert"),
    ShieldCheck: icon("ShieldCheck"),
    Wrench: icon("Wrench"),
  };
});

vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          agents: new Map([["agent-1", liveAgent]]),
          agentDetails: new Map(),
        },
      },
    }),
}));
vi.mock("@/screens/mission-control/inspector-store", () => ({
  useInspectorStore: { getState: () => ({ openInspectorAgent: vi.fn() }) },
}));
vi.mock("@/mission-control/central-config", () => ({
  useMissionControlCentralConfig: () => ({ config: { hideAgentNames: false } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
vi.mock("@/components/host-glyph", () => ({
  HostGlyph: ({ label, size, testID }: { label: string; size: string; testID: string }) => (
    <span data-testid={testID} data-host-label={label} data-size={size} />
  ),
}));
vi.mock("@/components/settings-textarea", () => ({
  SettingsTextArea: () => <textarea />,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => <input type="checkbox" /> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./proofs/proof-sections", () => ({ ProofSections: () => null }));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const { deriveFeedCardText, FeedCard } = await import("./feed-card");

function event(overrides: Partial<FeedCardEvent> = {}): FeedCardEvent {
  return {
    id: "event-1",
    ts: new Date().toISOString(),
    agentId: "agent-1",
    agentTitle: "Original event title",
    kind: "failed",
    source: "self",
    severity: "attention",
    headline: "Failed",
    serverId: "server-1",
    serverLabel: "MacBook-Pro-89.local",
    ...overrides,
  };
}

describe("FeedCard", () => {
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

  it("reactively joins the live title onto terminal cards", () => {
    expect(deriveFeedCardText(event(), liveAgent as Agent, false)).toEqual({
      agentChipLabel: "Worker One",
      title: "Repair mission control cards",
      headline: "Failed",
      detail: null,
    });
  });

  it("uses the living description for started cards", () => {
    expect(
      deriveFeedCardText(
        event({ kind: "started", headline: "Started" }),
        liveAgent as Agent,
        false,
      ),
    ).toMatchObject({
      title: "Repair mission control cards",
      headline: "Polishing the shared card anatomy",
    });
  });

  it("keeps the status icon, title, and small host glyph inside the highlighted card", () => {
    act(() => root?.render(<FeedCard event={event()} />));

    const card = container?.querySelector('[data-testid="mission-control-feed-card-failed"]');
    expect(card?.textContent).toContain("Repair mission control cards");
    expect(card?.querySelector('[data-icon="CircleX"]')).not.toBeNull();
    expect(card?.querySelector('[data-testid="mission-control-feed-host-glyph"]')).not.toBeNull();
    expect(
      card
        ?.querySelector('[data-testid="mission-control-feed-host-glyph"]')
        ?.getAttribute("data-size"),
    ).toBe("sm");
    expect(card?.textContent).not.toContain("MacBook-Pro-89.local");
  });

  it("renders proposal title, icon, host glyph, and relative time in one surface", () => {
    const proposalEvent = event({
      kind: "proposal",
      headline: "Proposal (stall): nudge",
      severity: "blocker",
      proposal: {
        id: "proposal-1",
        createdAt: new Date().toISOString(),
        origin: "stall",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Please report progress",
        deliveryMode: "steer",
        reason: "No recent activity",
        classification: "normal",
        status: "pending",
      },
    });

    act(() => root?.render(<FeedCard event={proposalEvent} />));

    const card = container?.querySelector('[data-testid="mission-control-proposal-card"]');
    expect(card?.textContent).toContain("Repair mission control cards");
    expect(card?.querySelector('[data-icon="Clock"]')).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="mission-control-proposal-host-glyph"]'),
    ).not.toBeNull();
    expect(card?.textContent).not.toContain("MacBook-Pro-89.local");
  });

  it("hides a sent stall nudge in normal mode and shows it in verbose", () => {
    const nudgeEvent = event({
      kind: "proposal",
      headline: "Proposal sent",
      severity: "info",
      verboseOnly: true,
      proposal: {
        id: "proposal-nudge",
        createdAt: new Date().toISOString(),
        origin: "stall",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "You've been quiet for a while. Post a one-line report_status.",
        deliveryMode: "steer",
        reason: "No recent status",
        classification: "normal",
        status: "sent",
      },
    });

    act(() => root?.render(<FeedCard event={nudgeEvent} />));
    expect(container?.querySelector('[data-testid="mission-control-proposal-card"]')).toBeNull();

    act(() => root?.render(<FeedCard event={nudgeEvent} verbose />));
    const card = container?.querySelector('[data-testid="mission-control-proposal-card"]');
    expect(card?.textContent).toContain("Stall check");
  });

  it("treats a sent stall steer without the field as machinery (legacy fallback)", () => {
    const legacyNudge = event({
      kind: "proposal",
      headline: "Proposal sent",
      severity: "info",
      proposal: {
        id: "proposal-legacy",
        createdAt: new Date().toISOString(),
        origin: "stall",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "You've been quiet for a while.",
        deliveryMode: "steer",
        reason: "No recent status",
        classification: "normal",
        status: "sent",
      },
    });

    act(() => root?.render(<FeedCard event={legacyNudge} />));
    expect(container?.querySelector('[data-testid="mission-control-proposal-card"]')).toBeNull();
    act(() => root?.render(<FeedCard event={legacyNudge} verbose />));
    expect(
      container?.querySelector('[data-testid="mission-control-proposal-card"]'),
    ).not.toBeNull();
  });

  it("always renders escalation recovery proposals (interrupt) in normal mode", () => {
    const recoveryEvent = event({
      kind: "proposal",
      headline: "Proposal (stall): recovery",
      severity: "blocker",
      proposal: {
        id: "proposal-recovery",
        createdAt: new Date().toISOString(),
        origin: "stall",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Continue whatever you were working on and post a one-line report_status.",
        deliveryMode: "interrupt",
        reason: "No response after nudge",
        classification: "normal",
        status: "pending",
      },
    });

    act(() => root?.render(<FeedCard event={recoveryEvent} />));
    expect(
      container?.querySelector('[data-testid="mission-control-proposal-card"]'),
    ).not.toBeNull();
  });

  it("keeps report kinds semantically distinct: progress loader, fix wrench, decision branch, milestone flag", () => {
    const cases: Array<{
      reportKind: "progress" | "fix" | "decision" | "milestone";
      icon: string;
    }> = [
      { reportKind: "progress", icon: "LoaderCircle" },
      { reportKind: "fix", icon: "Wrench" },
      { reportKind: "decision", icon: "GitBranch" },
      { reportKind: "milestone", icon: "Flag" },
    ];
    for (const { reportKind, icon } of cases) {
      act(() =>
        root?.render(
          <FeedCard event={event({ kind: "milestone", reportKind, headline: "Status" })} />,
        ),
      );
      const card = container?.querySelector('[data-testid="mission-control-feed-card-milestone"]');
      expect(
        card?.querySelector(`[data-icon="${icon}"]`),
        `${reportKind} → ${icon}`,
      ).not.toBeNull();
    }
  });

  it("keeps finding/fix/decision events on the search icon when reportKind is absent", () => {
    act(() => root?.render(<FeedCard event={event({ kind: "finding", headline: "Found it" })} />));
    const card = container?.querySelector('[data-testid="mission-control-feed-card-finding"]');
    expect(card?.querySelector('[data-icon="Search"]')).not.toBeNull();
  });
});
