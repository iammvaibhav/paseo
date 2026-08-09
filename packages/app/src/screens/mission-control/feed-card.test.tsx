/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
type FeedCardEvent = import("./feed-card").FeedCardEvent;

const { liveAgent, theme, openInspectorAgentMock } = vi.hoisted(() => ({
  liveAgent: {
    id: "agent-1",
    name: "Worker One",
    title: "Repair mission control cards",
    shortDescription: "Polishing the shared card anatomy",
  },
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderRadius: { none: 0, sm: 2, md: 6, full: 9999 },
    borderWidth: { 0: 0, 1: 1, 2: 2 },
    fontFamily: { ui: "system-ui", code: "monospace" },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
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
  openInspectorAgentMock: vi.fn(),
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
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return React.createElement("span", { ...props, "data-icon": name });
    };
  return {
    BadgeCheck: icon("BadgeCheck"),
    Bot: icon("Bot"),
    ChevronDown: icon("ChevronDown"),
    CircleCheck: icon("CircleCheck"),
    CircleSlash: icon("CircleSlash"),
    CircleX: icon("CircleX"),
    Clock: icon("Clock"),
    Flag: icon("Flag"),
    GitBranch: icon("GitBranch"),
    GitFork: icon("GitFork"),
    HelpCircle: icon("HelpCircle"),
    LoaderCircle: icon("LoaderCircle"),
    MessageSquare: icon("MessageSquare"),
    MessageSquareText: icon("MessageSquareText"),
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
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: () => {}, show: () => {}, copied: () => {} }),
}));
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
  useInspectorStore: { getState: () => ({ openInspectorAgent: openInspectorAgentMock }) },
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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("./proofs/proof-sections", () => ({ ProofSections: () => null }));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const { cardRunPosition, deriveFeedCardText, FeedCard } = await import("./feed-card");
const { ComposerToolbarGlyph } = await import("@/composer/agent-controls/glyph");

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

  it("keeps title frozen from event snapshot while agent name chip stays live", () => {
    expect(deriveFeedCardText(event(), liveAgent as Agent, false)).toEqual({
      agentChipLabel: "Worker One",
      title: "Original event title",
      headline: "Failed",
      detail: null,
    });
  });

  it("uses the shortDescription snapshot on started cards", () => {
    expect(
      deriveFeedCardText(
        event({
          kind: "started",
          headline: "Started running",
          shortDescription: "Polishing the shared card anatomy",
        }),
        liveAgent as Agent,
        false,
      ),
    ).toMatchObject({
      title: "Original event title",
      headline: "Polishing the shared card anatomy",
      agentChipLabel: "Worker One",
    });
  });

  it("falls back to the event headline on legacy started cards with no snapshot", () => {
    expect(
      deriveFeedCardText(
        event({ kind: "started", headline: "Started running" }),
        liveAgent as Agent,
        false,
      ),
    ).toMatchObject({
      title: "Original event title",
      headline: "Started running",
      agentChipLabel: "Worker One",
    });
  });

  it("advances the relative time label live without any other state change", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-08T12:00:00.000Z");
      vi.setSystemTime(now);

      const pastEvent = event({
        ts: new Date(now.getTime() - 60_000).toISOString(),
      });

      act(() => {
        root?.render(<FeedCard event={pastEvent} />);
      });

      const card = container?.querySelector('[data-testid="mission-control-feed-card-failed"]');
      expect(card?.textContent).toContain("1m ago");

      // Advance clock by 2 minutes and tick the shared ticker
      vi.setSystemTime(new Date(now.getTime() + 120_000));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(card?.textContent).toContain("4m ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the status icon, title, and small host glyph inside the highlighted card", () => {
    act(() => root?.render(<FeedCard event={event()} />));

    const card = container?.querySelector('[data-testid="mission-control-feed-card-failed"]');
    expect(card?.textContent).toContain("Original event title");
    expect(card?.querySelector('[data-icon="CircleX"]')).not.toBeNull();
    expect(card?.querySelector('[data-testid="mission-control-feed-host-glyph"]')).not.toBeNull();
    expect(
      card
        ?.querySelector('[data-testid="mission-control-feed-host-glyph"]')
        ?.getAttribute("data-size"),
    ).toBe("sm");
    expect(card?.textContent).not.toContain("MacBook-Pro-89.local");
  });

  it("does not nest button roles: the agent chip is not inside another button", () => {
    // BUG-8: FeedCardBody used to be a Pressable (button role) wrapping the
    // meta row's agent-chip Pressable → "button cannot be a descendant of
    // button" + hydration error on web. The body frame is now a plain View
    // with a separate "Open agent" pressable; the chip is a sibling.
    act(() =>
      root?.render(<FeedCard event={event({ kind: "started", headline: "Started running" })} />),
    );
    const buttons = Array.from(container?.querySelectorAll('[role="button"]') ?? []);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      // closest() includes the element itself — check the ancestor chain only.
      const ancestor = button.parentElement?.closest('[role="button"]') ?? null;
      expect(ancestor, "button must not nest a button").toBeNull();
    }
    // The chip keeps its own pressable identity.
    expect(
      container?.querySelector('[data-testid="mission-control-feed-agent-chip"]'),
    ).not.toBeNull();
  });

  it("does not leak RN-only accessibility props into the DOM", () => {
    // BUG-8 companion: accessibilityElementsHidden / importantForAccessibility
    // are not consumed by react-native-web 0.21 — they reached the DOM and
    // tripped React's unknown-prop warning. aria-hidden is the cross-platform
    // form (RN core maps it natively, rnw renders it as the DOM attribute).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      act(() => root?.render(<FeedCard event={event()} />));
      // Shared composer glyph chip: the exact component the MC screen rendered
      // with the leaked props.
      act(() =>
        root?.render(
          <ComposerToolbarGlyph size={16}>
            <span />
          </ComposerToolbarGlyph>,
        ),
      );
      expect(container?.querySelector("[accessibilityelementshidden]")).toBeNull();
      expect(container?.querySelector("[importantforaccessibility]")).toBeNull();
      expect(container?.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(
        errorSpy.mock.calls.some((args) => String(args[0]).includes("React does not recognize")),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("renders a user-interrupted run as a distinct non-error card", () => {
    // A run superseded by a USER prompt (interrupt-and-send) carries the
    // daemon's kind:"interrupted" card ("Interrupted by you", severity info) —
    // never the failure icon/tone.
    const interruptedEvent = event({
      kind: "interrupted",
      severity: "info",
      headline: "Interrupted by you",
    });

    act(() => root?.render(<FeedCard event={interruptedEvent} />));

    const card = container?.querySelector('[data-testid="mission-control-feed-card-interrupted"]');
    expect(card?.textContent).toContain("Interrupted by you");
    expect(card?.querySelector('[data-icon="CircleSlash"]')).not.toBeNull();
    expect(card?.querySelector('[data-icon="CircleX"]')).toBeNull();
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
        // Interrupt (escalation/recovery) so the card renders in normal mode:
        // stall-origin STEER proposals are machinery, whatever their status.
        deliveryMode: "interrupt",
        reason: "No recent activity",
        classification: "normal",
        status: "pending",
      },
    });

    act(() => root?.render(<FeedCard event={proposalEvent} />));

    const card = container?.querySelector('[data-testid="mission-control-proposal-card"]');
    // The card renders the emit-time title snapshot, never the live title.
    expect(card?.textContent).toContain("Original event title");
    expect(card?.textContent).not.toContain("Repair mission control cards");
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

  it("gates ANY unflagged stall steer as machinery, whatever its status (legacy fallback)", () => {
    // Pre-field persisted events only carry origin+delivery+status. The
    // fallback previously required status "sent", leaking EXPIRED stall
    // proposal cards into normal mode — every stall steer is machinery
    // regardless of how it resolved.
    for (const status of ["expired", "denied"] as const) {
      const legacyNudge = event({
        kind: "proposal",
        headline: `Proposal ${status}`,
        severity: "info",
        proposal: {
          id: `proposal-legacy-${status}`,
          createdAt: new Date().toISOString(),
          origin: "stall",
          serverId: "server-1",
          targetAgentId: "agent-1",
          message: "You've been quiet for a while.",
          deliveryMode: "steer",
          reason: "No recent status",
          classification: "normal",
          status,
        },
      });

      act(() => root?.render(<FeedCard event={legacyNudge} />));
      expect(
        container?.querySelector('[data-testid="mission-control-proposal-card"]'),
        `normal mode hides a ${status} stall steer`,
      ).toBeNull();
      act(() => root?.render(<FeedCard event={legacyNudge} verbose />));
      expect(
        container?.querySelector('[data-testid="mission-control-proposal-card"]'),
        `verbose mode shows a ${status} stall steer`,
      ).not.toBeNull();
    }
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
    const cases: {
      reportKind: "progress" | "fix" | "decision" | "milestone";
      icon: string;
    }[] = [
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

  it("squares run members and keeps only the run's outer corners rounded", () => {
    const cases: {
      position: "first" | "middle" | "last" | "only";
      top: string;
      bottom: string;
    }[] = [
      // Standalone card keeps all four corners; first keeps top, last keeps
      // bottom, middle is square.
      { position: "only", top: "6px", bottom: "6px" },
      { position: "first", top: "6px", bottom: "0px" },
      { position: "middle", top: "0px", bottom: "0px" },
      { position: "last", top: "0px", bottom: "6px" },
    ];
    for (const { position, top, bottom } of cases) {
      act(() => root?.render(<FeedCard event={event()} position={position} />));
      const card = container?.querySelector<HTMLElement>(
        '[data-testid="mission-control-feed-card-failed"]',
      );
      expect(card?.style.borderTopLeftRadius, `${position} top-left`).toBe(top);
      expect(card?.style.borderTopRightRadius, `${position} top-right`).toBe(top);
      expect(card?.style.borderBottomLeftRadius, `${position} bottom-left`).toBe(bottom);
      expect(card?.style.borderBottomRightRadius, `${position} bottom-right`).toBe(bottom);
    }
  });

  it("drops the bottom border on first/middle run members so the divider is single-px", () => {
    act(() => root?.render(<FeedCard event={event()} position="first" />));
    const firstCard = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-feed-card-failed"]',
    );
    // The card above the last member supplies its divider via borderTop; the
    // member itself only carries the run's outer edges.
    expect(firstCard?.style.borderBottomWidth).toBe("0px");
    expect(firstCard?.style.borderTopWidth).toBe("1px");
    expect(firstCard?.style.borderLeftWidth).toBe("1px");
    expect(firstCard?.style.borderRightWidth).toBe("1px");

    act(() => root?.render(<FeedCard event={event()} position="middle" />));
    const middleCard = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-feed-card-failed"]',
    );
    expect(middleCard?.style.borderBottomWidth).toBe("0px");
    expect(middleCard?.style.borderTopWidth).toBe("1px");
    expect(middleCard?.style.borderLeftWidth).toBe("1px");
    expect(middleCard?.style.borderRightWidth).toBe("1px");

    act(() => root?.render(<FeedCard event={event()} position="last" />));
    const lastCard = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-feed-card-failed"]',
    );
    expect(lastCard?.style.borderBottomWidth).toBe("1px");
    expect(lastCard?.style.borderTopWidth).toBe("1px");
  });

  it("joins run members to the group frame (shared surface + border edge)", () => {
    act(() => root?.render(<FeedCard event={event()} position="first" />));
    const card = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-feed-card-failed"]',
    );
    expect(card?.style.borderLeftColor).toBe("rgba(51,51,51,1.00)");
    expect(card?.style.borderTopColor).toBe("rgba(51,51,51,1.00)");
    expect(card?.style.backgroundColor).toBe("rgb(34, 34, 34)");
  });

  it("applies run corners to proposal cards too", () => {
    const proposalEvent = event({
      kind: "proposal",
      headline: "Proposal (stall): recovery",
      severity: "blocker",
      proposal: {
        id: "proposal-1",
        createdAt: new Date().toISOString(),
        origin: "stall",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Continue whatever you were working on.",
        deliveryMode: "interrupt",
        reason: "No response after nudge",
        classification: "normal",
        status: "pending",
      },
    });

    act(() => root?.render(<FeedCard event={proposalEvent} position="middle" />));
    const card = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-proposal-card"]',
    );
    expect(card?.style.borderTopLeftRadius).toBe("0px");
    expect(card?.style.borderTopRightRadius).toBe("0px");
    expect(card?.style.borderBottomLeftRadius).toBe("0px");
    expect(card?.style.borderBottomRightRadius).toBe("0px");
    expect(card?.style.borderBottomWidth).toBe("0px");
    expect(card?.style.borderTopWidth).toBe("1px");

    act(() => root?.render(<FeedCard event={proposalEvent} position="last" />));
    const lastCard = container?.querySelector<HTMLElement>(
      '[data-testid="mission-control-proposal-card"]',
    );
    expect(lastCard?.style.borderTopLeftRadius).toBe("0px");
    expect(lastCard?.style.borderTopRightRadius).toBe("0px");
    expect(lastCard?.style.borderBottomLeftRadius).toBe("6px");
    expect(lastCard?.style.borderBottomRightRadius).toBe("6px");
  });
});

describe("cardRunPosition", () => {
  const card = { card: true };
  const gap = { card: false };
  const skip = { skip: true };
  const classify = (row: unknown): "card" | "skip" | "gap" => {
    if ((row as { card?: boolean }).card) {
      return "card";
    }
    if ((row as { skip?: boolean }).skip) {
      return "skip";
    }
    return "gap";
  };

  it("classifies a standalone card as only", () => {
    expect(cardRunPosition([card], 0, classify)).toBe("only");
    expect(cardRunPosition([gap, card, gap], 1, classify)).toBe("only");
  });

  it("derives first/middle/last from adjacent runs, not index parity", () => {
    const rows = [card, card, gap, card, card, card];
    expect(cardRunPosition(rows, 0, classify)).toBe("first");
    expect(cardRunPosition(rows, 1, classify)).toBe("last");
    expect(cardRunPosition(rows, 3, classify)).toBe("first");
    expect(cardRunPosition(rows, 4, classify)).toBe("middle");
    expect(cardRunPosition(rows, 5, classify)).toBe("last");
  });

  it("breaks runs at non-card rows", () => {
    expect(cardRunPosition([card, gap, card], 0, classify)).toBe("only");
    expect(cardRunPosition([card, gap, card], 2, classify)).toBe("only");
  });

  it("treats zero-height skip rows as transparent: cards around them stay one run", () => {
    // A verbose-only stall card hidden by normal mode renders nothing and
    // takes no height, so the cards around it are still visually adjacent.
    expect(cardRunPosition([card, skip, card], 0, classify)).toBe("first");
    expect(cardRunPosition([card, skip, card], 2, classify)).toBe("last");
    // A run edge stays on the last VISIBLE card even when a skip row follows.
    expect(cardRunPosition([card, card, skip], 1, classify)).toBe("last");
    expect(cardRunPosition([card, card, skip], 0, classify)).toBe("first");
  });

  it("throws for a row that is not classified as a card", () => {
    expect(() => cardRunPosition([gap], 0, classify)).toThrow();
    expect(() => cardRunPosition([skip], 0, classify)).toThrow();
  });
});

describe("FeedCard verdict drill-in", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    openInspectorAgentMock.mockClear();
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

  it("verdict card click opens the VERIFIER's thread, not the worker's", () => {
    act(() => {
      root?.render(
        <FeedCard
          event={event({
            kind: "verdict",
            source: "verifier",
            agentId: "worker-1",
            agentTitle: "Worker One",
            verifierAgentId: "verifier-9",
          })}
        />,
      );
    });
    const card = container?.querySelector('[data-testid="mission-control-feed-card-verdict"]');
    expect(card).not.toBeNull();
    const openSurface = card?.querySelector('[data-testid="mission-control-feed-card-open"]');
    expect(openSurface).not.toBeNull();
    act(() => {
      openSurface?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openInspectorAgentMock).toHaveBeenCalledWith({
      serverId: "server-1",
      agentId: "verifier-9",
    });
  });

  it("cards without a verifier attribution open the event's own agent", () => {
    act(() => {
      root?.render(
        <FeedCard event={event({ kind: "verdict", source: "system", agentId: "worker-1" })} />,
      );
    });
    const card = container?.querySelector('[data-testid="mission-control-feed-card-verdict"]');
    const openSurface = card?.querySelector('[data-testid="mission-control-feed-card-open"]');
    act(() => {
      openSurface?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openInspectorAgentMock).toHaveBeenCalledWith({
      serverId: "server-1",
      agentId: "worker-1",
    });
  });
});
describe("Proposal Card v2, ClarificationCard, and AnswerCard", () => {
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

  it("renders raw payload JSON in verbose mode and hides it in normal mode", () => {
    const proposalEvent = event({
      kind: "proposal",
      headline: "Proposal (commander): spawn",
      proposal: {
        id: "proposal-v2-payload",
        createdAt: new Date().toISOString(),
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Spawn agent",
        deliveryMode: "interrupt",
        reason: "User requested worker",
        classification: "normal",
        status: "pending",
        kind: "spawn",
        spawnPlan: {
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          summary: "Spawn new worker",
        },
      },
    });

    act(() => root?.render(<FeedCard event={proposalEvent} verbose={false} />));
    expect(container?.querySelector('[data-testid="mission-control-proposal-payload"]')).toBeNull();

    act(() => root?.render(<FeedCard event={proposalEvent} verbose={true} />));
    const payloadEl = container?.querySelector('[data-testid="mission-control-proposal-payload"]');
    expect(payloadEl).not.toBeNull();
    expect(payloadEl?.textContent).toContain("proposal-v2-payload");
  });

  it("renders meta proposal summaries, model line, and plan chips", () => {
    const metaEvent = event({
      kind: "proposal",
      proposal: {
        id: "proposal-meta-1",
        createdAt: new Date().toISOString(),
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Meta action",
        deliveryMode: "interrupt",
        reason: "Renaming workspace",
        classification: "normal",
        status: "pending",
        kind: "meta",
        metaPlan: {
          action: "rename_workspace",
          targetLabel: "OldWorkspace",
          newValue: "NewWorkspace",
        },
      },
    });

    act(() => root?.render(<FeedCard event={metaEvent} />));
    const card = container?.querySelector('[data-testid="mission-control-proposal-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("missionControl.proposal.meta.renameWorkspace");

    const spawnEvent = event({
      kind: "proposal",
      proposal: {
        id: "proposal-spawn-1",
        createdAt: new Date().toISOString(),
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "agent-1",
        message: "Spawn worker",
        deliveryMode: "interrupt",
        reason: "New project spawn",
        classification: "normal",
        status: "pending",
        kind: "spawn",
        spawnPlan: {
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          summary: "Create worker agent for backend",
          labels: {
            newProject: "BackendAPI",
          },
        },
      },
    });

    act(() => root?.render(<FeedCard event={spawnEvent} />));
    const spawnCard = container?.querySelector('[data-testid="mission-control-proposal-card"]');
    expect(spawnCard?.textContent).toContain("Create worker agent for backend");
    expect(
      spawnCard?.querySelector('[data-testid="mission-control-proposal-model"]'),
    ).not.toBeNull();
    expect(
      spawnCard?.querySelector('[data-testid="mission-control-proposal-chips"]'),
    ).not.toBeNull();
  });

  it("renders clarification card with question and options", () => {
    const clarificationEvent = event({
      kind: "clarification",
      clarification: {
        question: "Which workspace should be updated?",
        options: ["workspace-a", "workspace-b"],
        allowFreeText: true,
      },
    });

    act(() => root?.render(<FeedCard event={clarificationEvent} />));
    const card = container?.querySelector('[data-testid="mission-control-clarification-card"]');
    expect(card).not.toBeNull();
    const question = container?.querySelector(
      '[data-testid="mission-control-clarification-question"]',
    );
    expect(question?.textContent).toBe("Which workspace should be updated?");
  });

  it("renders answer card for agent_status and generic kinds", () => {
    const statusAnswerEvent = event({
      kind: "answer",
      answer: {
        kind: "agent_status",
        headline: "Agent worker-1 is idle",
        body: "Completed all assigned tasks.",
        fields: [{ label: "Status", value: "idle" }],
      },
    });

    act(() => root?.render(<FeedCard event={statusAnswerEvent} />));
    const card = container?.querySelector('[data-testid="mission-control-answer-card"]');
    expect(card).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="mission-control-answer-headline"]')?.textContent,
    ).toBe("Agent worker-1 is idle");
    expect(
      container?.querySelector('[data-testid="mission-control-answer-body"]')?.textContent,
    ).toBe("Completed all assigned tasks.");
    expect(
      container?.querySelector('[data-testid="mission-control-answer-fields"]'),
    ).not.toBeNull();

    const genericAnswerEvent = event({
      kind: "answer",
      answer: {
        kind: "generic",
        headline: "Fleet Overview",
        body: "All systems operational.",
      },
    });

    act(() => root?.render(<FeedCard event={genericAnswerEvent} />));
    expect(container?.querySelector('[data-testid="mission-control-answer-card"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="mission-control-answer-headline"]')?.textContent,
    ).toBe("Fleet Overview");
  });
});
