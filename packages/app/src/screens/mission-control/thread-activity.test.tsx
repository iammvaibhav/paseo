/**
 * @vitest-environment jsdom
 *
 * M1 activity indicator: the Mission Control thread renders the shared
 * running-turn affordance (TurnFooter → SyncedLoader + LiveElapsed, the same
 * working indicator the workspace agent chat uses) while the Commander's turn
 * is open or a submission is pending, and clears it when the turn ends.
 * The store mock seeds `agentTurnLiveness` the same way the daemon events do;
 * `hoistedTurnPresentation` is replicated faithfully so the test exercises
 * the same selector contract (open turn OR unacknowledged submission ⇒ active).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnLiveness } from "@/timeline/turn-liveness";

const COMMANDER_SERVER_ID = "server-1";
const COMMANDER_AGENT_ID = "commander-1";

const {
  sessionsState: hoistedSessions,
  theme,
  selectAgentTurnPresentation: hoistedTurnPresentation,
} = vi.hoisted(() => {
  // Literal ids: vi.hoisted runs before the module-level consts below.
  const commanderAgent = {
    id: "commander-1",
    name: "Commander",
    cwd: "/workspaces/paseo",
    workspaceId: "wks_1",
    archivedAt: null,
  };
  const makeSession = () => ({
    agents: new Map([["commander-1", commanderAgent]]),
    agentDetails: new Map(),
    agentStreamTail: new Map(),
    agentStreamHead: new Map(),
    agentTurnLiveness: new Map<string, TurnLiveness>(),
    messageSubmissions: new Map(),
    viewedTimelineSync: null,
  });
  const sessionsState = { sessions: { "server-1": makeSession() } };

  // Faithful mirror of stores/session-store.ts hoistedTurnPresentation:
  // active while the turn liveness is open OR an unacknowledged message
  // submission is pending — exactly "thinking or running".
  const selectAgentTurnPresentation = (
    session:
      | {
          agentTurnLiveness?: Map<string, TurnLiveness>;
          messageSubmissions?: Map<string, unknown[]>;
        }
      | undefined,
    agentId: string,
  ) => {
    if (!session) {
      return { isActive: false, isCancelling: false, startedAt: null, turnId: null };
    }
    const liveness = session.agentTurnLiveness?.get(agentId);
    const hasActiveSubmission = Boolean(
      (session.messageSubmissions?.get(agentId) ?? []).some(
        (submission) =>
          typeof submission === "object" &&
          submission !== null &&
          "providerAcknowledged" in submission &&
          !submission.providerAcknowledged,
      ),
    );
    if (liveness?.phase === "open") {
      return {
        isActive: true,
        isCancelling: liveness.cancellationRequestId !== null,
        startedAt: liveness.startedAt,
        turnId: liveness.turnId,
      };
    }
    return {
      isActive: hasActiveSubmission,
      isCancelling: false,
      startedAt: null,
      turnId: null,
    };
  };

  return {
    sessionsState,
    selectAgentTurnPresentation,
    theme: {
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
      borderRadius: { none: 0, sm: 2, md: 6, full: 9999 },
      borderWidth: { 0: 0, 1: 1, 2: 2 },
      fontFamily: { ui: "system-ui", code: "monospace" },
      fontWeight: { normal: "400", medium: "500", semibold: "600" },
      fontSize: { xs: 12, sm: 14, base: 16 },
      colors: {
        accent: "#20744a",
        border: "#333333",
        foreground: "#ffffff",
        foregroundMuted: "#aaaaaa",
        surface0: "#111111",
        surface1: "#222222",
        surface2: "#333333",
        surfaceSidebarHover: "#2a2a2a",
        destructive: "#d8847b",
      },
      shadow: {
        sm: {
          shadowColor: "#000000",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.2,
          shadowRadius: 2,
        },
      },
    },
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Pressable: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
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

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => <span data-icon="chevron-down" />,
}));

vi.mock("@/constants/layout", () => ({
  MAX_CONTENT_WIDTH: 640,
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: () => {}, show: () => {}, copied: () => {} }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHosts: () => [],
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: null, isLoading: false, patchConfig: async () => undefined }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(hoistedSessions),
  selectAgentTurnPresentation: hoistedTurnPresentation,
}));

vi.mock("@/screens/mission-control/inspector-store", () => ({
  useInspectorStore: { getState: () => ({ openInspectorAgent: () => {} }) },
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: () => {},
}));

vi.mock("@/workspace/file-open", () => ({
  createWorkspaceFileTabTarget: () => null,
  normalizeWorkspaceFileLocation: () => null,
}));

vi.mock("@/assistant-file-links", () => ({
  AssistantFileLinkResolverProvider: ({ children }: { children?: React.ReactNode }) => children,
  normalizeInlinePathTarget: () => null,
}));

vi.mock("@/components/tool-call-sheet", () => ({
  ToolCallSheetProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/components/markdown/paseo-agent-link", () => ({
  PaseoAgentLinkProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/history-ask/open-agent-link-parse", () => ({
  parseHistoryAskAgentOpenUrl: () => null,
}));

vi.mock("@/components/message", () => ({
  ActivityLog: () => null,
  AssistantMessage: () => null,
  AssistantTurnFooter: () => null,
  CompactionMarker: () => null,
  LiveElapsed: () => <span data-testid="running-turn-timestamp" />,
  STREAM_METADATA_FONT_SIZE: 11,
  TodoListCard: () => null,
  ToolCall: () => null,
  UserMessage: () => null,
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () => <button data-testid="running-turn-fork" type="button" />,
}));

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: () => <span data-testid="running-turn-loader" />,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

vi.mock("./feed-card", () => ({
  FeedCard: () => null,
  cardRunPosition: () => "only",
}));

vi.mock("./muted-system-row", () => ({
  MutedSystemRow: () => null,
}));

vi.mock("./paseo-system-row", () => ({
  PaseoSystemRow: () => null,
  isPaseoSystemMessage: () => false,
}));

vi.mock("./thread-instruction-envelope", () => ({
  commanderUserMessageText: () => "",
}));

import { MissionControlThread, type MissionControlCommander } from "./thread";

const COMMANDER: MissionControlCommander = {
  serverId: COMMANDER_SERVER_ID,
  agentId: COMMANDER_AGENT_ID,
};

describe("MissionControlThread commander activity indicator", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalScrollTo: HTMLElement["scrollTo"] | undefined;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: "",
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }),
    });
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    if (originalScrollTo) {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
    vi.restoreAllMocks();
  });

  function renderThread(key: string) {
    if (!container) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    // The key forces a fresh mount so the (subscription-less) store mock is
    // re-read exactly as the store would push an update in production.
    act(() => {
      root?.render(
        <MissionControlThread
          key={key}
          events={[]}
          commander={COMMANDER}
          verbose={false}
          clearPointTs={null}
        />,
      );
    });
  }

  function workingIndicator(): HTMLElement | null {
    return container?.querySelector('[data-testid="turn-working-indicator"]') ?? null;
  }

  it("shows the shared working indicator while the Commander is thinking or running and clears it when the turn ends", () => {
    // Idle Commander: no turn liveness, no pending submission — no indicator.
    renderThread("idle");
    expect(workingIndicator()).toBeNull();

    // Thinking (submission pending, provider stream not open yet): the
    // indicator mounts with the loader but no elapsed timestamp, matching the
    // workspace chat's behavior before the turn's start time is known.
    act(() => {
      hoistedSessions.sessions[COMMANDER_SERVER_ID].messageSubmissions.set(COMMANDER_AGENT_ID, [
        { clientMessageId: "msg-1", providerAcknowledged: false, rpcSettled: false },
      ]);
    });
    renderThread("thinking");
    expect(workingIndicator()).not.toBeNull();
    expect(container?.querySelector('[data-testid="running-turn-loader"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="running-turn-timestamp"]')).toBeNull();

    // Running (the daemon's stream_open transition): the live elapsed
    // affordance appears alongside the loader.
    act(() => {
      hoistedSessions.sessions[COMMANDER_SERVER_ID].messageSubmissions.delete(COMMANDER_AGENT_ID);
      hoistedSessions.sessions[COMMANDER_SERVER_ID].agentTurnLiveness.set(COMMANDER_AGENT_ID, {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        cancellationRequestId: null,
      });
    });
    renderThread("running");
    expect(workingIndicator()).not.toBeNull();
    expect(container?.querySelector('[data-testid="running-turn-loader"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="running-turn-timestamp"]')).not.toBeNull();

    // Turn ends (stream_close) — the indicator unmounts.
    act(() => {
      hoistedSessions.sessions[COMMANDER_SERVER_ID].agentTurnLiveness.delete(COMMANDER_AGENT_ID);
    });
    renderThread("settled");
    expect(workingIndicator()).toBeNull();
  });
});
