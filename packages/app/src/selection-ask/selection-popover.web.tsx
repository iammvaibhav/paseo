import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  CornerDownLeft,
  ExternalLink,
  MessageSquareQuote,
  X,
} from "lucide-react-native";
import { usePathname } from "expo-router";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { usePaneFocus } from "@/panels/pane-context";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SyncedLoader } from "@/components/synced-loader";
import type { Theme } from "@/styles/theme";
import { quoteSelection } from "./format";
import {
  useSelectionAsk,
  type AnchorRect,
  type SelectionAskConfig,
  type SelectionAskState,
} from "./use-selection-ask";

const POPOVER_WIDTH = 380;
const POPOVER_MARGIN = 8;
const ANSWER_MAX_HEIGHT = 320;
const QUOTE_PREVIEW_MAX_HEIGHT = 96;

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const ThemedMessageSquareQuote = withUnistyles(MessageSquareQuote);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedX = withUnistyles(X);

const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
}));

export interface SelectionAskPopoverHostProps {
  config: SelectionAskConfig | null;
  children: ReactNode;
}

/**
 * Web-only host for the selection Ask popover. Wraps the agent stream, waits
 * for a completed mouse selection (mouseup), and renders the popover portaled
 * to the overlay root anchored at the selection. Native builds use the no-op
 * sibling (`selection-popover.tsx`) so the feature is web-only.
 */
export function SelectionAskPopoverHost({ config, children }: SelectionAskPopoverHostProps) {
  if (!config) {
    return children;
  }
  return <SelectionAskPopoverHostInner config={config}>{children}</SelectionAskPopoverHostInner>;
}

function SelectionAskPopoverHostInner({
  config,
  children,
}: {
  config: SelectionAskConfig;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const ask = useSelectionAsk(config);
  const scrollFrameRef = useRef<number | null>(null);
  const containerStyle = useMemo<CSSProperties>(() => ({ display: "contents" }), []);
  // While a popover-internal overlay (model browser, thinking combobox) is open,
  // outside pointerdowns must not dismiss the popover — the overlay's own
  // backdrop handles clicks outside it first.
  const internalOverlayOpenRef = useRef(0);
  // True while this host's popover is actually open. Every dismiss path is
  // guarded by it: dismissing a closed popover would still clear the shared
  // selection-ask timeline source, wiping a sibling host's open popover (e.g.
  // two agent tabs in a split view).
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = ask.anchorRect !== null;
  // Focus tracking for the focusin net: remembers whether focus was last seen
  // inside the popover, so focus leaving it (Tab, focus restore, clicking a
  // non-focusable surface outside) dismisses while portaled internal overlays
  // never do.
  const focusInsidePopoverRef = useRef(false);
  const wasPaneFocusedRef = useRef(false);
  const previousPathnameRef = useRef<string | null>(null);

  // The popover is anchored to a workspace pane; the pane-focus context is the
  // same source agent-panel reads (`isInteractive`). Dismissing on the focused
  // -> unfocused transition covers clicking another pane, switching tabs, and
  // the workspace route losing focus. Clicking inside the portaled popover
  // never changes pane focus, so this only fires on genuine focus loss.
  const { isInteractive } = usePaneFocus();
  const pathname = usePathname();

  const handleInternalOverlayOpenChange = useCallback((open: boolean) => {
    internalOverlayOpenRef.current = Math.max(0, internalOverlayOpenRef.current + (open ? 1 : -1));
  }, []);

  const handleMouseUp = useCallback(() => {
    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      return;
    }
    const anchorNode = selection.anchorNode;
    if (!anchorNode || !container.contains(anchorNode)) {
      return;
    }
    const content = createAssistantSelectionClipboardContent(selection);
    if (!content) {
      return;
    }
    ask.showSelection({
      markdown: content.plainText,
      range: selection.getRangeAt(0),
    });
  }, [ask]);

  // Dismiss when the user starts interacting anywhere outside the popover —
  // clicking in the stream, the sidebar, or another window. Clicking inside
  // the popover (comment input, model selector) never dismisses.
  const handlePointerDown = useCallback(
    (event: PointerEvent) => {
      if (!popoverOpenRef.current || internalOverlayOpenRef.current > 0) {
        return;
      }
      const popoverElement = popoverRef.current;
      if (popoverElement && event.target instanceof Node && popoverElement.contains(event.target)) {
        return;
      }
      ask.dismiss();
    },
    [ask],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && popoverOpenRef.current) {
        ask.dismiss();
      }
    },
    [ask],
  );

  // Dismiss when the window loses focus (switching apps, clicking browser
  // chrome) and when the tab becomes hidden (new tab, minimized).
  const handleWindowBlur = useCallback(() => {
    if (popoverOpenRef.current) {
      ask.dismiss();
    }
  }, [ask]);

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === "hidden" && popoverOpenRef.current) {
      ask.dismiss();
    }
  }, [ask]);

  // Net for dismissals pointerdown misses: focus moving out of the popover via
  // keyboard or programmatic focus changes. Focus inside the popover arms the
  // check; focus handed to a popover-internal overlay disarms it (the overlay
  // owns focus while open and its backdrop handles outside clicks).
  const handleFocusIn = useCallback(
    (event: FocusEvent) => {
      const popoverElement = popoverRef.current;
      const targetInside =
        popoverElement !== null &&
        event.target instanceof Node &&
        popoverElement.contains(event.target);
      if (targetInside) {
        focusInsidePopoverRef.current = true;
        return;
      }
      if (internalOverlayOpenRef.current > 0) {
        focusInsidePopoverRef.current = false;
        return;
      }
      if (focusInsidePopoverRef.current && popoverOpenRef.current) {
        ask.dismiss();
      }
      focusInsidePopoverRef.current = false;
    },
    [ask],
  );

  // Keep the popover glued to the selection while the user scrolls the stream.
  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      ask.recomputeAnchorRect();
    });
  }, [ask]);

  useEffect(() => {
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [
    handleFocusIn,
    handleKeyDown,
    handleMouseUp,
    handlePointerDown,
    handleVisibilityChange,
    handleWindowBlur,
  ]);

  // Dismiss when the pane/workspace the popover is anchored to loses focus.
  useEffect(() => {
    const wasFocused = wasPaneFocusedRef.current;
    wasPaneFocusedRef.current = isInteractive;
    if (wasFocused && !isInteractive && popoverOpenRef.current) {
      ask.dismiss();
    }
  }, [ask, isInteractive]);

  // Dismiss on any route change (open-in-tab, sidebar, workspace switch,
  // browser back/forward) — expo-router re-renders this host with the new
  // pathname. The openInTab button dismisses first, so by the time the route
  // lands the popover is already closed and this is a no-op.
  useEffect(() => {
    if (previousPathnameRef.current === null) {
      previousPathnameRef.current = pathname;
      return;
    }
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      if (popoverOpenRef.current) {
        ask.dismiss();
      }
    }
  }, [ask, pathname]);

  // A closed popover must not inherit stale "focus was inside" state — e.g.
  // reopened in answer mode (no autofocus), where the next outside focusin
  // would otherwise count as a focus-leave and dismiss immediately.
  useEffect(() => {
    if (!ask.anchorRect) {
      focusInsidePopoverRef.current = false;
    }
  }, [ask.anchorRect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ask.selection) {
      return;
    }
    container.addEventListener("scroll", handleScroll, true);
    return () => container.removeEventListener("scroll", handleScroll, true);
  }, [ask.selection, handleScroll]);

  return (
    <div ref={containerRef} style={containerStyle}>
      {children}
      {ask.anchorRect ? (
        <SelectionAskPopover
          ref={popoverRef}
          anchorRect={ask.anchorRect}
          ask={ask}
          onInternalOverlayOpenChange={handleInternalOverlayOpenChange}
        />
      ) : null}
    </div>
  );
}

function computePopoverPosition(anchorRect: AnchorRect, width: number, height: number) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.min(
    Math.max(anchorRect.left, POPOVER_MARGIN),
    Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN),
  );
  let top = anchorRect.top + anchorRect.height + POPOVER_MARGIN;
  if (top + height > viewportHeight - POPOVER_MARGIN) {
    top = anchorRect.top - height - POPOVER_MARGIN;
  }
  return { top: Math.max(POPOVER_MARGIN, top), left };
}

const SelectionAskPopover = forwardRef<HTMLDivElement, SelectionAskPopoverProps>(
  function SelectionAskPopover({ anchorRect, ask, onInternalOverlayOpenChange }, ref) {
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
    const anchorRectRef = useRef(anchorRect);
    anchorRectRef.current = anchorRect;

    useEffect(() => {
      setPosition(computePopoverPosition(anchorRect, POPOVER_WIDTH, 260));
    }, [anchorRect]);

    const handleLayout = useCallback(
      (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
        const { width, height } = event.nativeEvent.layout;
        setPosition(computePopoverPosition(anchorRectRef.current, width, height));
      },
      [],
    );

    const popoverStyle = useMemo<CSSProperties>(
      () => ({
        position: "fixed",
        zIndex: OVERLAY_Z.floating,
        width: POPOVER_WIDTH,
        ...(position ? { top: position.top, left: position.left } : { visibility: "hidden" }),
        pointerEvents: "auto",
        maxHeight: `calc(100vh - ${POPOVER_MARGIN * 2}px)`,
        display: "flex",
        flexDirection: "column",
      }),
      [position],
    );

    return createPortal(
      <div ref={ref} style={popoverStyle}>
        <View style={styles.popoverCard} onLayout={handleLayout}>
          {ask.askAgentId || ask.isStartingAsk ? (
            <SelectionAskAnswerBody
              ask={ask}
              onInternalOverlayOpenChange={onInternalOverlayOpenChange}
            />
          ) : (
            <SelectionAskComposeBody
              ask={ask}
              onInternalOverlayOpenChange={onInternalOverlayOpenChange}
            />
          )}
        </View>
      </div>,
      getOverlayRoot(),
    );
  },
);

interface SelectionAskPopoverProps {
  anchorRect: AnchorRect;
  ask: SelectionAskState;
  onInternalOverlayOpenChange: (open: boolean) => void;
}

function SelectionAskComposeBody({
  ask,
  onInternalOverlayOpenChange,
}: {
  ask: SelectionAskState;
  onInternalOverlayOpenChange: (open: boolean) => void;
}) {
  const quote = useMemo(() => quoteSelection(ask.selection?.markdown ?? ""), [ask.selection]);
  const canAsk = (ask.comment.trim().length > 0 || quote.length > 0) && !ask.isStartingAsk;

  const handleAskKey = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === "Enter") {
        void ask.startAsk();
      }
    },
    [ask],
  );

  return (
    <>
      <View style={styles.popoverHeader}>
        <ThemedMessageSquareQuote size={13} uniProps={foregroundMutedMapping} />
        <Text style={styles.popoverTitle}>Selection</Text>
        <Pressable
          onPress={ask.dismiss}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="Close selection popover"
        >
          <ThemedX size={14} uniProps={foregroundMutedMapping} />
        </Pressable>
      </View>
      <View style={styles.quotePreview}>
        <Text style={styles.quotePreviewText} numberOfLines={6}>
          {quote}
        </Text>
      </View>
      <ThemedTextInput
        value={ask.comment}
        onChangeText={ask.setComment}
        placeholder="Comment…"
        style={styles.commentInput}
        multiline
        autoFocus
        onKeyPress={handleAskKey}
      />
      <SelectionAskModelControls
        ask={ask}
        onInternalOverlayOpenChange={onInternalOverlayOpenChange}
      />
      {ask.error ? <Text style={styles.errorText}>{ask.error}</Text> : null}
      <View style={styles.actionRow}>
        <Button
          variant="outline"
          size="sm"
          style={styles.actionButton}
          onPress={ask.addToComposer}
          disabled={quote.length === 0}
        >
          Add to composer
        </Button>
        <Button
          variant="default"
          size="sm"
          style={styles.actionButton}
          onPress={ask.startAsk}
          disabled={!canAsk}
          loading={ask.isStartingAsk}
        >
          Ask
        </Button>
      </View>
    </>
  );
}

function SelectionAskAnswerBody({
  ask,
  onInternalOverlayOpenChange,
}: {
  ask: SelectionAskState;
  onInternalOverlayOpenChange: (open: boolean) => void;
}) {
  const scrollViewRef = useRef<ScrollView>(null);
  const lastMessageCountRef = useRef(0);
  const messageCount = ask.askMessages.length;

  // Keep the newest message in view when a new row lands (follow-up or a new
  // reply); streaming text chunks into the last row do not fight the user.
  useEffect(() => {
    if (messageCount > lastMessageCountRef.current) {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
    lastMessageCountRef.current = messageCount;
  }, [messageCount]);

  const handleFollowUpKey = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === "Enter") {
        void ask.sendFollowUp();
      }
    },
    [ask],
  );

  const sendIcon = useMemo(
    () => <ThemedCornerDownLeft size={13} uniProps={accentForegroundMapping} />,
    [],
  );

  // The loader lives in the title bar only: a SyncedLoader next to the title
  // while the fork is starting (status not yet known) or running. The body
  // never shows an activity loader.
  const showHeaderLoader = ask.isAskRunning || ask.askStatus == null;

  return (
    <>
      <View style={styles.popoverHeader}>
        <Text style={styles.popoverTitle} numberOfLines={1}>
          {ask.askTitle ?? "Ask"}
        </Text>
        {showHeaderLoader ? (
          <ThemedSyncedLoader size={13} uniProps={foregroundMutedMapping} />
        ) : null}
        <View style={styles.headerSpacer} />
        {ask.canJumpToSelection ? (
          <Pressable
            onPress={ask.jumpToSelection}
            style={styles.jumpToSelectionChip}
            accessibilityRole="button"
            accessibilityLabel="Jump to selection in chat"
          >
            <Text style={styles.jumpToSelectionText}>Jump to chat</Text>
          </Pressable>
        ) : null}
        {ask.askAgentId ? (
          <Pressable
            onPress={ask.openInTab}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="Open ask in tab"
          >
            <ThemedExternalLink size={13} uniProps={foregroundMutedMapping} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={ask.dismiss}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="Close selection popover"
        >
          <ThemedX size={14} uniProps={foregroundMutedMapping} />
        </Pressable>
      </View>
      <View style={[styles.answerScroller, { maxHeight: ANSWER_MAX_HEIGHT }]}>
        <ScrollView
          ref={scrollViewRef}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
          contentContainerStyle={styles.answerContent}
        >
          {messageCount === 0 ? (
            <Text style={styles.answerEmptyText}>Waiting…</Text>
          ) : (
            ask.askMessages.map((message) =>
              message.role === "user" ? (
                <View key={message.id} style={styles.userBubble}>
                  <Text style={styles.userBubbleText}>{message.text}</Text>
                </View>
              ) : (
                <View key={message.id} style={styles.assistantMessage}>
                  <MarkdownRenderer text={message.text} compact enableHtmlish={false} />
                </View>
              ),
            )
          )}
        </ScrollView>
      </View>
      <SelectionAskModelControls
        ask={ask}
        onInternalOverlayOpenChange={onInternalOverlayOpenChange}
      />
      {ask.error ? <Text style={styles.errorText}>{ask.error}</Text> : null}
      <View style={styles.followUpRow}>
        <ThemedTextInput
          value={ask.followUp}
          onChangeText={ask.setFollowUp}
          placeholder="Follow up…"
          style={styles.followUpInput}
          multiline
          onKeyPress={handleFollowUpKey}
        />
        <Button
          variant="default"
          size="sm"
          disabled={!ask.askAgentId || ask.followUp.trim().length === 0 || ask.isSendingFollowUp}
          loading={ask.isSendingFollowUp}
          onPress={ask.sendFollowUp}
          leftIcon={sendIcon}
        >
          Send
        </Button>
      </View>
    </>
  );
}

function SelectionAskModelControls({
  ask,
  onInternalOverlayOpenChange,
}: {
  ask: SelectionAskState;
  onInternalOverlayOpenChange: (open: boolean) => void;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingAnchorRef = useRef<View>(null);

  const handleThinkingOpenChange = useCallback(
    (open: boolean) => {
      setThinkingOpen(open);
      onInternalOverlayOpenChange(open);
    },
    [onInternalOverlayOpenChange],
  );

  const handleOpenThinking = useCallback(() => {
    handleThinkingOpenChange(true);
  }, [handleThinkingOpenChange]);

  const handleOverlayOpen = useCallback(() => {
    onInternalOverlayOpenChange(true);
  }, [onInternalOverlayOpenChange]);

  const handleOverlayClose = useCallback(() => {
    onInternalOverlayOpenChange(false);
  }, [onInternalOverlayOpenChange]);

  const handleModelSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      ask.onSelectModel(provider, modelId);
    },
    [ask],
  );

  const thinkingOptions = useMemo<ComboboxOption[]>(
    () => ask.thinkingOptions.map((option) => ({ id: option.id, label: option.label })),
    [ask.thinkingOptions],
  );
  const selectedThinkingLabel = useMemo(
    () =>
      ask.thinkingOptions.find((option) => option.id === ask.selectedThinkingOptionId)?.label ??
      null,
    [ask.selectedThinkingOptionId, ask.thinkingOptions],
  );

  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      onPress,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }) => (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={[styles.modelChip, (hovered || pressed || isOpen) && styles.modelChipActive]}
        accessibilityRole="button"
        accessibilityLabel={`Model: ${selectedModelLabel}`}
      >
        <Text style={styles.modelChipText} numberOfLines={1}>
          {selectedModelLabel || "Model…"}
        </Text>
        <ThemedChevronDown size={12} uniProps={foregroundMutedMapping} />
      </Pressable>
    ),
    [],
  );

  return (
    <View style={styles.modelRow}>
      <CombinedModelSelector
        providers={ask.modelProviders}
        selectedProvider={ask.selectedProvider}
        selectedModel={ask.selectedModel}
        onSelect={handleModelSelect}
        isLoading={ask.isModelLoading}
        renderTrigger={renderModelTrigger}
        onOpen={handleOverlayOpen}
        onClose={handleOverlayClose}
      />
      {ask.thinkingOptions.length > 1 ? (
        <>
          <Pressable
            ref={thinkingAnchorRef}
            onPress={handleOpenThinking}
            style={styles.modelChip}
            accessibilityRole="button"
            accessibilityLabel="Thinking"
          >
            <Text style={styles.modelChipText} numberOfLines={1}>
              {selectedThinkingLabel ?? "Thinking"}
            </Text>
            <ThemedChevronDown size={12} uniProps={foregroundMutedMapping} />
          </Pressable>
          <Combobox
            options={thinkingOptions}
            value={ask.selectedThinkingOptionId ?? ""}
            onSelect={ask.onSelectThinkingOption}
            open={thinkingOpen}
            onOpenChange={handleThinkingOpenChange}
            anchorRef={thinkingAnchorRef}
            desktopPlacement="top-start"
            desktopMinWidth={180}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  popoverCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 10,
    gap: 8,
    // Always a black drop shadow — `theme.colors.foreground` is white in dark
    // mode and renders as a white glow. The border carries the theme contrast.
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  popoverHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  popoverTitle: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  headerSpacer: {
    flex: 1,
  },
  headerIconButton: {
    padding: 3,
    borderRadius: theme.borderRadius.sm,
  },
  jumpToSelectionChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  jumpToSelectionText: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  },
  quotePreview: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
    maxHeight: QUOTE_PREVIEW_MAX_HEIGHT,
    overflow: "hidden",
  },
  quotePreviewText: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: theme.fontFamily.mono,
    flexShrink: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  commentInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 56,
    maxHeight: 120,
    textAlignVertical: "top",
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  modelChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: 220,
  },
  modelChipActive: {
    backgroundColor: theme.colors.surface3,
  },
  modelChipText: {
    color: theme.colors.foreground,
    fontSize: 12,
    flexShrink: 1,
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 6,
  },
  actionButton: {
    minWidth: 96,
  },
  answerScroller: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
    maxHeight: ANSWER_MAX_HEIGHT,
  },
  answerContent: {
    gap: 8,
    // Keep the scroll content at the scroller width: without minWidth: 0 an
    // unbreakable token (long code identifier) makes the flex column lay out
    // wider than the panel and every line past the edge gets clipped by the
    // ScrollView's hidden overflow-x.
    minWidth: 0,
    width: "100%",
  },
  answerEmptyText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    minWidth: 0,
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  userBubbleText: {
    color: theme.colors.foreground,
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
    overflowWrap: "anywhere",
  },
  assistantMessage: {
    alignSelf: "stretch",
    minWidth: 0,
  },
  followUpRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  followUpInput: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 80,
    textAlignVertical: "top",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: 12,
  },
}));
