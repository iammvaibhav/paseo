/**
 * @vitest-environment jsdom
 *
 * Mission Control mounts AgentStreamView outside a workspace pane. Chat find
 * reads pane focus and crashes the desktop tree when that context is missing.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedAgentPane } from "./embedded-agent-pane";

const focus = vi.hoisted(() => ({
  interactive: [] as boolean[],
}));
const timelineSync = vi.hoisted(() => ({
  replaceVisibleAgentIds: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? {} : factory),
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({
    show: () => undefined,
    copied: () => undefined,
    error: () => undefined,
  }),
  ToastApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// vi.mock factories are hoisted above static imports, so the probe has to load
// the pane-focus hook through the Vite resolver instead of a top-level import.
vi.mock("@/agent-stream/view", async () => {
  const React = await import("react");
  const { usePaneFocus } = await import("@/panels/pane-context");
  return {
    AgentStreamView: function ProbeStream() {
      const paneFocus = usePaneFocus();
      focus.interactive.push(paneFocus.isInteractive);
      return React.createElement("div", { "data-testid": "probe-stream" });
    },
  };
});

vi.mock("@/composer", () => ({
  Composer: () => null,
}));

vi.mock("@/composer/draft/input-draft", () => ({
  useAgentInputDraft: () => ({
    textSource: { text: "" },
    editText: () => undefined,
    textReplacement: null,
    attachments: [],
    setAttachments: () => undefined,
    clear: () => undefined,
  }),
}));
vi.mock("@/components/archived-agent-callout", () => ({
  ArchivedAgentCallout: () => null,
}));

vi.mock("@/composer/submission/model", () => ({
  getActiveMessageSubmissions: () => [],
}));

vi.mock("@/utils/agent-snapshots", () => ({
  resolveSessionAgent: () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<string, unknown>;
      setFocusedAgentId: () => void;
    }) => unknown,
  ) =>
    selector({
      sessions: {
        "server-1": {
          viewedTimelineSync: timelineSync,
          agentStreamTail: new Map(),
          agentStreamHead: new Map(),
          messageSubmissions: new Map(),
          pendingPermissions: new Map(),
          agentAuthoritativeHistoryApplied: new Map(),
        },
      },
      setFocusedAgentId: () => undefined,
    }),
  selectAgentTurnPresentation: () => ({ phase: "idle" }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: () => undefined,
}));

vi.mock("@/workspace/file-open", () => ({
  createWorkspaceFileTabTarget: () => ({ kind: "file" }),
}));

vi.mock("@/mission-control/use-mission-control-verbose", () => ({
  useMissionControlVerbose: () => [false, () => undefined],
}));

vi.mock("./inspector-stream-filter", () => ({
  filterMissionControlInspectorStream: <T,>(items: T) => items,
}));

vi.mock("@/hooks/use-load-older-agent-history", () => ({
  useLoadOlderAgentHistory: () => ({
    hasOlder: false,
    isLoadingOlder: false,
    progressKey: "0",
    loadOlder: () => undefined,
  }),
}));

function renderPane(isFocused: boolean): void {
  act(() => {
    root?.render(
      <EmbeddedAgentPane
        serverId="server-1"
        agentId="agent-1"
        isFocused={isFocused}
        viewedTimelineSourceId="mission-control-inspector"
        reportsFocusedAgent={false}
      />,
    );
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("EmbeddedAgentPane pane focus", () => {
  beforeEach(() => {
    focus.interactive.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it("gives the stream pane focus without crashing, and only the focused pane is interactive", () => {
    renderPane(true);
    expect(container?.querySelector("[data-testid='probe-stream']")).not.toBeNull();
    expect(focus.interactive.at(-1)).toBe(true);

    renderPane(false);
    expect(focus.interactive.at(-1)).toBe(false);
  });

  it("immediately registers viewedTimelineSync when timelineSyncDebounceMs is 0", () => {
    timelineSync.replaceVisibleAgentIds.mockClear();
    renderPane(true);
    expect(timelineSync.replaceVisibleAgentIds).toHaveBeenCalledWith(
      "mission-control-inspector",
      ["agent-1"],
      undefined,
    );
  });

  it("debounces viewedTimelineSync registration and skips registration on fast unmount", () => {
    vi.useFakeTimers();
    try {
      timelineSync.replaceVisibleAgentIds.mockClear();
      act(() => {
        root?.render(
          <EmbeddedAgentPane
            serverId="server-1"
            agentId="agent-1"
            isFocused={true}
            viewedTimelineSourceId="mission-control-agent-grid:server-1:agent-1"
            reportsFocusedAgent={false}
            timelineSyncDebounceMs={150}
          />,
        );
      });
      // Immediately after render, debounce has not fired
      expect(timelineSync.replaceVisibleAgentIds).not.toHaveBeenCalled();

      // Unmounting before 150ms cancels the timer, so agent-1 is never registered
      act(() => {
        root?.unmount();
      });
      expect(timelineSync.replaceVisibleAgentIds).toHaveBeenCalledWith(
        "mission-control-agent-grid:server-1:agent-1",
        [],
        { ephemeral: true },
      );
      // Verify it was never registered with ['agent-1']
      expect(timelineSync.replaceVisibleAgentIds).not.toHaveBeenCalledWith(
        "mission-control-agent-grid:server-1:agent-1",
        ["agent-1"],
        { ephemeral: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers viewedTimelineSync with ephemeral option after debounce delay settles", () => {
    vi.useFakeTimers();
    try {
      timelineSync.replaceVisibleAgentIds.mockClear();
      act(() => {
        root?.render(
          <EmbeddedAgentPane
            serverId="server-1"
            agentId="agent-1"
            isFocused={true}
            viewedTimelineSourceId="mission-control-agent-grid:server-1:agent-1"
            reportsFocusedAgent={false}
            timelineSyncDebounceMs={150}
          />,
        );
      });
      expect(timelineSync.replaceVisibleAgentIds).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(timelineSync.replaceVisibleAgentIds).toHaveBeenCalledWith(
        "mission-control-agent-grid:server-1:agent-1",
        ["agent-1"],
        { ephemeral: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
