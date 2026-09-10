/**
 * @vitest-environment jsdom
 *
 * Regression: thought items ("thinking" tool calls) in ALL agent chats must be
 * pressable and show their text when expanded. Two past bugs from the render
 * slice: (a) thought items computed `canOpenDetails: false` when the
 * empty-detail heuristic swallowed their text, killing the toggle; (b)
 * "thinking" was routed to FleetToolCallDetailBody which returned null,
 * leaving the expanded body empty.
 */
import { act } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stable context value for the ToolCallSheet mock, hoisted to module scope so
// the Provider never re-creates it per render.
const toolCallSheetValue = { openToolCall: vi.fn(), closeToolCall: vi.fn() };

vi.mock("@/components/tool-call-sheet", () => {
  const { createContext, useContext } = require("react");
  const ToolCallSheetContext = createContext(null);
  return {
    ToolCallSheetProvider: ({ children }: { children?: React.ReactNode }) => (
      <ToolCallSheetContext.Provider value={toolCallSheetValue}>
        {children}
      </ToolCallSheetContext.Provider>
    ),
    useToolCallSheet: () => useContext(ToolCallSheetContext),
  };
});

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: () => null,
  addMathPlugin: () => {},
  createMathRenderRules: () => ({}),
}));

vi.mock("@/components/markdown/rich-fence", () => ({
  renderRichFence: () => null,
}));

vi.mock("@/components/markdown-text", () => ({
  MarkdownParagraphView: () => null,
  MarkdownTextSpan: () => null,
}));

vi.mock("@/components/markdown-text-selection", () => ({
  MarkdownTableCellText: () => null,
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => true),
  getStringAsync: vi.fn(async () => ""),
  ClipboardPasteButton: () => null,
}));

// diff-viewer picks GHScrollView only when !isWeb; web tests never use it, and
// the native package's deep imports are not jsdom-parseable.
vi.mock("react-native-gesture-handler", () => ({
  ScrollView: () => null,
}));

vi.mock("expo-image", () => ({
  Image: () => null,
}));

vi.mock("@/components/appearance-style-boundary", () => ({
  AppearanceStyleBoundary: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/components/highlighted-code-block", () => ({
  HighlightedCodeBlock: () => null,
}));

vi.mock("@/attachments/attachment-pill-content", () => ({
  getAgentAttachmentPillContent: () => null,
}));

vi.mock("@/components/plan-card", () => ({
  PlanCard: () => null,
}));

vi.mock("@/components/chart-data-context", () => ({
  ChartDataProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/components/rewind/rewind-menu", () => ({
  RewindMenu: () => null,
}));

vi.mock("@/components/rewind/use-rewind-agent-mutation", () => ({
  useRewindAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () => null,
}));

vi.mock("@/components/jump-to-user-message-button", () => ({
  JumpToUserMessageButton: () => null,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

vi.mock("@/history-ask/open-agent-link", () => ({
  openHistoryAskAgentLink: () => false,
}));

vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: () => null,
}));

vi.mock("@/assistant-image/use-assistant-image", () => ({
  useAssistantImage: () => null,
}));

vi.mock("@/components/attachment-pill", () => ({
  getAttachmentPillContent: () => null,
  AttachmentPill: () => null,
}));

vi.mock("@/utils/markdown-ast", () => ({
  markdownNodeContainsType: () => false,
}));

vi.mock("@/utils/assistant-markdown-parser", () => ({
  createAssistantMarkdownParser: () => ({}),
}));

vi.mock("@/components/message-compaction-label", () => ({
  getCompactionMarkerLabel: () => null,
}));

vi.mock("@/utils/markdown-list", () => ({
  getMarkdownListMarker: () => null,
  getMarkdownListSpacing: () => undefined,
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => null,
}));

vi.mock("@/assistant-file-links", () => ({
  useAssistantFileLinkActions: () => ({ open: vi.fn() }),
  AssistantFileLinkResolverProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/assistant-selection-copy/markup", () => ({
  markdownCopyDataSet: {},
  markdownCopyOrderedListDataSet: {},
  markdownCopyTableCellDataSet: {},
}));

vi.mock("@/utils/assistant-message-height-estimate", () => ({
  setAssistantMarkdownBlockHeight: () => {},
}));

vi.mock("@/utils/rich-clipboard", () => ({
  writeMarkdownToRichClipboard: vi.fn(),
}));

vi.mock("@/utils/rich-clipboard-default-environment", () => ({
  getDefaultMarkdownClipboardEnvironment: vi.fn(() => ({})),
}));

import { ToolCall } from "@/components/message";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";

const THOUGHT_TEXT = "step one: inspect the fleet roster before steering";

function renderToolCall(extra: Partial<Parameters<typeof ToolCall>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ToolCallSheetProvider>
        <ToolCall toolName="thinking" args={THOUGHT_TEXT} status="completed" {...extra} />
      </ToolCallSheetProvider>,
    );
  });
  return { container, root };
}

describe("thinking tool call expansion", () => {
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(() => {
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns = [];
  });

  it("renders a pressable thought badge when the thought has text", () => {
    const { container } = renderToolCall();
    cleanupFns.push(() => container.remove());

    const badge = container.querySelector('[data-testid="tool-call-badge"]');
    expect(badge).not.toBeNull();

    const buttons = container.querySelectorAll('[role="button"]');
    expect(buttons.length).toBeGreaterThan(0);
    // The badge's own Pressable must be interactive (not disabled).
    const pressables = Array.from(container.querySelectorAll('[role="button"]'));
    expect(pressables.some((el) => !el.hasAttribute("aria-disabled"))).toBe(true);
  });

  it("expands on press and renders the thought text", () => {
    const { container } = renderToolCall();
    cleanupFns.push(() => container.remove());

    const badge = container.querySelector('[data-testid="tool-call-badge"]');
    const pressable = badge?.querySelector('[role="button"]');
    expect(pressable).not.toBeNull();

    act(() => {
      pressable!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain(THOUGHT_TEXT);
  });

  it("does not show the raw 'empty' state for a thought with text", () => {
    const { container } = renderToolCall();
    cleanupFns.push(() => container.remove());

    const badge = container.querySelector('[data-testid="tool-call-badge"]');
    const pressable = badge?.querySelector('[role="button"]');
    act(() => {
      pressable!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("No details");
    expect(container.textContent).toContain(THOUGHT_TEXT);
  });
});
