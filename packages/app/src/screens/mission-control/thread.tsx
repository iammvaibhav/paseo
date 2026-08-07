import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ChevronDown } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  ActivityLog,
  AssistantMessage,
  CompactionMarker,
  TodoListCard,
  ToolCall,
  UserMessage,
} from "@/components/message";
import {
  type BottomAnchorRouteRequest,
  useBottomAnchorController,
} from "@/agent-stream/bottom-anchor-controller";
import {
  AssistantFileLinkResolverProvider,
  normalizeInlinePathTarget,
  type InlinePathTarget,
} from "@/assistant-file-links";
import { useToast } from "@/contexts/toast-context";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { AgentToolCallData, StreamItem } from "@/types/stream";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import {
  loadScrollRestoreStates,
  saveScrollRestoreState,
  type CommanderScrollRestoreState,
} from "@/mission-control/scroll-restore-store";
import { FeedCard, type FeedCardEvent } from "./feed-card";
import { MutedSystemRow } from "./muted-system-row";
import { isPaseoSystemMessage, PaseoSystemRow } from "./paseo-system-row";

const THREAD_ANCHOR_ID = "mission-control-thread";
const THREAD_INITIAL_REQUEST_KEY = "mission-control-thread-initial";
const THREAD_CONTAINER_KEY = "mission-control-thread";
const NEAR_BOTTOM_THRESHOLD = 32;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
/** Hard cap for the scroll-restore application window during hydration. */
const RESTORE_DEADLINE_MS = 8_000;

const ThemedChevronDown = withUnistyles(ChevronDown);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

// Bracket-prefixed provider fallback records ("[credential_pin] Unsupported
// history record", "[developer] developer note") are plumbing, not prose.
const BRACKET_PLUMBING_PATTERN = /^\[[a-z][a-z0-9_]*\]\s/;
const OMP_NOTICE_SOURCES = new Set(["omp_notice", "omp_system_notice"]);

function isPlumbingAssistantText(text: string): boolean {
  return BRACKET_PLUMBING_PATTERN.test(text.trimStart());
}

function isOmpNoticeToolCall(data: AgentToolCallData): boolean {
  const source = data.metadata?.source;
  return (
    data.name === "omp_notice" || (typeof source === "string" && OMP_NOTICE_SOURCES.has(source))
  );
}

function ompNoticeMessage(data: AgentToolCallData): string {
  const detail = data.detail;
  if (detail.type === "plain_text") {
    return detail.label || detail.text || data.name;
  }
  return data.name;
}

type ThreadRow =
  | { kind: "event"; event: FeedCardEvent; ts: number }
  | { kind: "commander"; item: StreamItem; ts: number };

interface CommanderMessageRowProps {
  item: StreamItem;
  agentId: string;
  serverId: string;
  client: DaemonClient | null;
  workspaceRoot: string;
}

function CommanderMessageRow({
  item,
  agentId,
  serverId,
  client,
  workspaceRoot,
}: CommanderMessageRowProps): ReactElement | null {
  switch (item.kind) {
    case "user_message":
      // `<paseo-system>` envelopes (fleet digests, schedule fires, notify-on-
      // finish) must never render as raw user prose — they become a collapsed
      // divider row that expands into the formatted digest.
      if (isPaseoSystemMessage(item.text)) {
        return <PaseoSystemRow text={item.text} timestamp={item.timestamp.getTime()} />;
      }
      return (
        <UserMessage
          serverId={serverId}
          agentId={agentId}
          messageId={item.messageId}
          message={item.text}
          images={item.images}
          attachments={item.attachments}
          timestamp={item.timestamp.getTime()}
          client={client}
        />
      );
    case "assistant_message":
      // Unknown provider history records fall through as bracket-prefixed
      // plumbing text ("[credential_pin] Unsupported history record"). They
      // carry no conversation value — drop them entirely.
      if (isPlumbingAssistantText(item.text)) {
        return null;
      }
      return (
        <AssistantMessage
          occurrenceKey={item.id}
          message={item.text}
          timestamp={item.timestamp.getTime()}
          workspaceRoot={workspaceRoot}
          serverId={serverId}
          client={client}
        />
      );
    case "thought":
      return (
        <ToolCall
          toolName="thinking"
          args={item.text}
          status={item.status === "ready" ? "completed" : "executing"}
        />
      );
    case "tool_call":
      if (item.payload.source === "agent") {
        const data = item.payload.data;
        // OMP provider notices (quota warnings, task-result notices) render as
        // muted one-line system rows, never as inline tool-call prose.
        if (isOmpNoticeToolCall(data)) {
          return (
            <MutedSystemRow message={ompNoticeMessage(data)} timestamp={item.timestamp.getTime()} />
          );
        }
        return (
          <ToolCall
            toolName={data.name}
            detail={data.detail}
            status={data.status}
            error={data.error}
            metadata={data.metadata}
          />
        );
      }
      return (
        <ToolCall
          toolName={item.payload.data.toolName}
          args={item.payload.data.arguments}
          result={item.payload.data.result}
          status={item.payload.data.status}
        />
      );
    case "todo_list":
      return <TodoListCard items={item.items} />;
    case "activity_log":
      return (
        <ActivityLog
          type={item.activityType}
          message={item.message}
          timestamp={item.timestamp.getTime()}
          metadata={item.metadata}
        />
      );
    case "compaction":
      return (
        <CompactionMarker status={item.status} trigger={item.trigger} preTokens={item.preTokens} />
      );
    default:
      return null;
  }
}

const MemoizedCommanderMessageRow = memo(CommanderMessageRow);

export interface MissionControlCommander {
  serverId: string;
  agentId: string;
}

interface MissionControlThreadProps {
  events: FeedCardEvent[];
  commander: MissionControlCommander | null;
  /**
   * False when the owning screen lost navigation focus while staying mounted
   * (web keeps route screens mounted/hidden). Scroll state is persisted on the
   * focus-out transition, because react-native-screens web remounts the thread
   * on the next visit without ever running unmount cleanups.
   */
  isFocused: boolean;
}

export function MissionControlThread({
  events,
  commander,
  isFocused,
}: MissionControlThreadProps): ReactElement {
  const client = useHostRuntimeClient(commander?.serverId ?? "");
  const commanderAgent = useSessionStore((state) =>
    commander ? (state.sessions[commander.serverId]?.agents.get(commander.agentId) ?? null) : null,
  );
  const workspaceRoot = commanderAgent?.cwd?.trim() || "";
  const toast = useToast();
  const handleInlinePathPress = useStableEvent((target: InlinePathTarget) => {
    if (!target.path || !commander) {
      return;
    }
    const normalized = normalizeInlinePathTarget(target.path, workspaceRoot);
    if (!normalized?.file || !commanderAgent?.workspaceId) {
      return;
    }
    const location = normalizeWorkspaceFileLocation({
      path: normalized.file,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
    });
    if (!location) {
      return;
    }
    navigateToWorkspace({
      serverId: commander.serverId,
      workspaceId: commanderAgent.workspaceId,
      target: createWorkspaceFileTabTarget(location),
    });
  });
  const flatListRef = useRef<FlatList<ThreadRow>>(null);
  const scrollOffsetYRef = useRef(0);
  const programmaticScrollEventBudgetRef = useRef(0);
  const isUserScrollActiveRef = useRef(false);
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  // Armed while a mid-history scroll restore owns the landing position; gates
  // the initial-entry route request so it cannot yank the restored viewport.
  const [midHistoryRestoreArmed, setMidHistoryRestoreArmed] = useState(false);
  const streamViewportMetricsRef = useRef({
    containerKey: THREAD_CONTAINER_KEY,
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });

  const tail = useSessionStore((state) =>
    commander
      ? (state.sessions[commander.serverId]?.agentStreamTail.get(commander.agentId) ??
        EMPTY_STREAM_ITEMS)
      : EMPTY_STREAM_ITEMS,
  );
  const head = useSessionStore((state) =>
    commander
      ? (state.sessions[commander.serverId]?.agentStreamHead.get(commander.agentId) ??
        EMPTY_STREAM_ITEMS)
      : EMPTY_STREAM_ITEMS,
  );
  const viewedTimelineSync = useSessionStore((state) =>
    commander ? (state.sessions[commander.serverId]?.viewedTimelineSync ?? null) : null,
  );

  useEffect(() => {
    if (!commander || !viewedTimelineSync) {
      return;
    }
    viewedTimelineSync.replaceVisibleAgentIds("mission-control-thread", [commander.agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds("mission-control-thread", []);
  }, [commander, viewedTimelineSync]);

  const eventRows = useMemo<ThreadRow[]>(
    () =>
      events.map((event) => ({
        kind: "event",
        event,
        ts: Date.parse(event.ts),
      })),
    [events],
  );
  const commanderRows = useMemo<ThreadRow[]>(
    () =>
      commander
        ? [...tail, ...head].map((item) => ({
            kind: "commander",
            item,
            ts: item.timestamp.getTime(),
          }))
        : [],
    [commander, head, tail],
  );
  const rows = useMemo(() => {
    const merged = [...eventRows, ...commanderRows];
    merged.sort((left, right) => {
      if (left.ts !== right.ts) {
        return left.ts - right.ts;
      }
      if (left.kind === right.kind) {
        return 0;
      }
      return left.kind === "event" ? -1 : 1;
    });
    return merged;
  }, [commanderRows, eventRows]);

  const hasAnyRow = rows.length > 0;
  const anchorAgentId = commander ? `${THREAD_ANCHOR_ID}:${commander.serverId}` : THREAD_ANCHOR_ID;
  const routeRequest = useMemo<BottomAnchorRouteRequest | null>(
    () =>
      // A mid-history restore owns the landing position; the initial-entry
      // anchor would otherwise yank the restored viewport to the live tail.
      hasAnyRow && !midHistoryRestoreArmed
        ? {
            reason: "initial-entry",
            agentId: THREAD_ANCHOR_ID,
            requestKey: `${THREAD_INITIAL_REQUEST_KEY}:${commander?.serverId ?? ""}:${commander?.agentId ?? ""}`,
          }
        : null,
    [commander, hasAnyRow, midHistoryRestoreArmed],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId: anchorAgentId,
    routeRequest,
    isAuthoritativeHistoryReady: true,
    renderStrategy: "forward-list",
    transportBehavior: { verificationDelayFrames: 2, verificationRetryMode: "recheck" },
    getMeasurementState: () => streamViewportMetricsRef.current,
    isNearBottom: () => {
      const metrics = streamViewportMetricsRef.current;
      return (
        metrics.offsetY + metrics.viewportHeight >= metrics.contentHeight - NEAR_BOTTOM_THRESHOLD
      );
    },
    scrollToBottom: (animated) => {
      const metrics = streamViewportMetricsRef.current;
      const maxOffset = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({ offset: maxOffset, animated });
      // Mirror what the resulting scroll event will report before the reflow
      // lands, so the sticky verification never races an event-less or laggy
      // scrollToOffset and leaves the tail un-followed.
      if (metrics.offsetY !== maxOffset) {
        streamViewportMetricsRef.current = { ...metrics, offsetY: maxOffset };
      }
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: true,
        scrollDelta: 0,
      });
    },
  });

  const [pendingNewCount, setPendingNewCount] = useState(0);
  const modeRef = useRef(bottomAnchorController.mode);
  modeRef.current = bottomAnchorController.mode;
  const previousRowCountRef = useRef(0);
  useEffect(() => {
    const previousCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (modeRef.current === "detached" && rows.length > previousCount) {
      setPendingNewCount((current) => current + (rows.length - previousCount));
    }
  }, [rows.length]);
  useEffect(() => {
    if (bottomAnchorController.mode === "sticky-bottom") {
      setPendingNewCount(0);
    }
  }, [bottomAnchorController.mode]);

  const handleJumpToBottom = useCallback(() => {
    bottomAnchorController.requestLocalAnchor({
      agentId: THREAD_ANCHOR_ID,
      reason: "jump-to-bottom",
    });
  }, [bottomAnchorController]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return (
        contentOffset.y + layoutMeasurement.height >= contentSize.height - NEAR_BOTTOM_THRESHOLD
      );
    },
  );

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    scrollOffsetYRef.current = contentOffset.y;

    streamViewportMetricsRef.current = {
      containerKey: THREAD_CONTAINER_KEY,
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      offsetY: contentOffset.y,
      viewportMeasuredForKey: THREAD_CONTAINER_KEY,
      contentMeasuredForKey: THREAD_CONTAINER_KEY,
    };

    if (programmaticScrollEventBudgetRef.current > 0) {
      programmaticScrollEventBudgetRef.current -= 1;
      return;
    }

    const nearBottom = isScrollEventNearBottom(event);
    // Wheel/trackpad scrolling never fires the drag events the controller
    // reattaches on. When the user rolls back down to the bottom while
    // detached, re-latch follow the same way a drag ending at the bottom does.
    if (nearBottom && modeRef.current === "detached" && !isUserScrollActiveRef.current) {
      bottomAnchorController.endUserScroll({ isNearBottom: true });
      return;
    }
    bottomAnchorController.handleScrollNearBottomChange({
      nextIsNearBottom: nearBottom,
      scrollDelta: contentOffset.y - previousOffsetY,
    });
  });

  const handleScrollBeginDrag = useStableEvent(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isUserScrollActiveRef.current = true;
      // A drag is user intent: never let the programmatic-scroll budget keep
      // swallowing the user's own scroll events, and drop any restore still
      // waiting out hydration — the user is choosing their own position.
      programmaticScrollEventBudgetRef.current = 0;
      clearPendingRestore();
      bottomAnchorController.beginUserScroll();
    },
  );

  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isNearBottom = isScrollEventNearBottom(event);
    const frameId = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    });
    userScrollEndFrameIdRef.current = frameId;
  });

  const handleMomentumScrollBegin = useStableEvent(() => {
    programmaticScrollEventBudgetRef.current = 0;
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  });

  const handleMomentumScrollEnd = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isUserScrollActiveRef.current) {
        return;
      }
      const isNearBottom = isScrollEventNearBottom(event);
      if (userScrollEndFrameIdRef.current !== null) {
        cancelAnimationFrame(userScrollEndFrameIdRef.current);
        userScrollEndFrameIdRef.current = null;
      }
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    },
  );

  // Scroll restore: per-host persisted position (or the live bottom for first
  // visits), applied deterministically instead of racing hydration. The
  // initial-entry route request drives sticky-bottom mode, but its frame-based
  // verification swallows rapid content-size changes while the thread hydrates
  // (observed: the anchor chases 830 -> 3692 and then strands the viewport
  // mid-history). So the restore target is re-applied on every content change
  // until the thread has hydrated to (at least) the height the user left, or a
  // deadline elapses — whichever comes first guarantees the correct landing.
  const restoreServerIdRef = useRef<string | null>(null);
  const restorePendingRef = useRef<CommanderScrollRestoreState | null>(null);
  const restoreDeadlineRef = useRef(0);
  const restoreApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingRestore = useCallback(() => {
    restorePendingRef.current = null;
    clearTimeout(restoreApplyTimerRef.current ?? undefined);
    restoreApplyTimerRef.current = null;
  }, []);

  const scheduleRestoreApply = useStableEvent(() => {
    if (!restorePendingRef.current) {
      return;
    }
    clearTimeout(restoreApplyTimerRef.current ?? undefined);
    restoreApplyTimerRef.current = null;
    const delay = Math.min(400, Math.max(0, restoreDeadlineRef.current - Date.now()));
    restoreApplyTimerRef.current = setTimeout(() => {
      restoreApplyTimerRef.current = null;
      applyRestore();
    }, delay);
  });

  // Applies the pending restore target to the current list metrics. Stays
  // armed (re-applying on later content-size changes) until the content has
  // hydrated to the saved height or the restore deadline elapses.
  const applyRestore = useStableEvent(() => {
    const pending = restorePendingRef.current;
    if (!pending) {
      return;
    }
    const metrics = streamViewportMetricsRef.current;
    if (
      metrics.viewportMeasuredForKey !== metrics.containerKey ||
      metrics.contentMeasuredForKey !== metrics.containerKey ||
      metrics.contentHeight <= 0 ||
      metrics.viewportHeight <= 0
    ) {
      scheduleRestoreApply();
      return;
    }
    const maxOffset = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
    const restoredOffset = pending.atBottom
      ? maxOffset
      : Math.min(
          Math.max(
            0,
            pending.contentHeight > 0
              ? Math.round(pending.offsetY * (metrics.contentHeight / pending.contentHeight))
              : pending.offsetY,
          ),
          maxOffset,
        );
    programmaticScrollEventBudgetRef.current = 3;
    flatListRef.current?.scrollToOffset({ offset: restoredOffset, animated: false });
    scrollOffsetYRef.current = restoredOffset;
    streamViewportMetricsRef.current = { ...metrics, offsetY: restoredOffset };
    if (pending.atBottom) {
      // The restore landed on the live tail: keep follow engaged so later
      // streaming stays anchored.
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: true,
        scrollDelta: 0,
      });
    } else {
      // Restored position is mid-history by definition — never let the
      // controller re-yank to the live tail.
      bottomAnchorController.detachByUser();
    }
    const deadlinePassed = Date.now() >= restoreDeadlineRef.current;
    const hydratedToSaved =
      pending.contentHeight > 0 && metrics.contentHeight >= pending.contentHeight * 0.95;
    if (deadlinePassed || hydratedToSaved) {
      restorePendingRef.current = null;
      return;
    }
    // Still hydrating: stay armed so the next content-size change re-applies.
    scheduleRestoreApply();
  });

  const serverId = commander?.serverId ?? null;
  useEffect(() => {
    if (!serverId) {
      return;
    }
    if (restoreServerIdRef.current === serverId) {
      return;
    }
    restoreServerIdRef.current = serverId;
    clearPendingRestore();
    restoreDeadlineRef.current = Date.now() + RESTORE_DEADLINE_MS;
    let cancelled = false;
    void loadScrollRestoreStates()
      .then((states) => {
        if (cancelled) {
          return;
        }
        const state = states[serverId] ?? null;
        // First-ever visit (no stored state), "left at the bottom", and a
        // recreated commander on the same host all restore to the live tail —
        // armed as a pending bottom target so hydration cannot strand the
        // viewport mid-history (the initial-entry route request alone races
        // hydration). A mid-history position from the same commander restores
        // verbatim (scaled by content height).
        if (state && !state.atBottom && (!state.agentId || state.agentId === commander?.agentId)) {
          restorePendingRef.current = state;
          setMidHistoryRestoreArmed(true);
        } else {
          restorePendingRef.current = {
            serverId,
            atBottom: true,
            offsetY: 0,
            contentHeight: state?.contentHeight ?? 0,
            viewportHeight: state?.viewportHeight ?? 0,
          };
        }
        return scheduleRestoreApply();
      })
      .catch(() => {
        // Storage read failure falls back to bottom-anchored (no pending).
      });
    return () => {
      cancelled = true;
    };
  }, [clearPendingRestore, commander?.agentId, scheduleRestoreApply, serverId]);

  // Snapshot the current scroll state for a commander host. Reads live refs, so
  // it is safe to call from any effect that runs after the last scroll.
  const persistScrollPosition = useCallback((targetServerId: string, targetAgentId: string) => {
    const metrics = streamViewportMetricsRef.current;
    const atBottom =
      modeRef.current === "sticky-bottom" ||
      metrics.offsetY + metrics.viewportHeight >= metrics.contentHeight - NEAR_BOTTOM_THRESHOLD;
    void saveScrollRestoreState({
      serverId: targetServerId,
      agentId: targetAgentId,
      atBottom,
      offsetY: scrollOffsetYRef.current,
      contentHeight: metrics.contentHeight,
      viewportHeight: metrics.viewportHeight,
    });
  }, []);

  // Persist where the user left, keyed by commander host, when the thread goes
  // away (navigation, host switch, compact-panel swap). Keyed on the stable
  // identity string, not the object: session hydration re-creates the
  // `commander` object every few ms on first load, and tearing down on that
  // churn would snapshot half-hydrated scroll metrics into storage.
  const commanderRef = useRef(commander);
  commanderRef.current = commander;
  const commanderIdentity = commander ? `${commander.serverId}:${commander.agentId}` : "";
  useEffect(() => {
    const current = commanderRef.current;
    if (!current) {
      return;
    }
    const savedServerId = current.serverId;
    const savedAgentId = current.agentId;
    return () => {
      persistScrollPosition(savedServerId, savedAgentId);
    };
  }, [commanderIdentity, persistScrollPosition]);

  // On web the route screen blurs but stays mounted (react-native-screens
  // remounts it on the next visit without running unmount cleanups), so the
  // focus-out transition is the reliable "user left" signal.
  const lastFocusedRef = useRef(isFocused);
  useEffect(() => {
    const wasFocused = lastFocusedRef.current;
    lastFocusedRef.current = isFocused;
    if (!wasFocused || isFocused || !commander) {
      return;
    }
    persistScrollPosition(commander.serverId, commander.agentId);
  }, [commander, isFocused, persistScrollPosition]);

  // Drop any in-flight restore scheduling when the thread goes away.
  useEffect(() => {
    return () => {
      clearTimeout(restoreApplyTimerRef.current ?? undefined);
      restoreApplyTimerRef.current = null;
    };
  }, []);

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: THREAD_CONTAINER_KEY,
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: THREAD_CONTAINER_KEY,
    };
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
    scheduleRestoreApply();
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: THREAD_CONTAINER_KEY,
      contentHeight: nextContentHeight,
      contentMeasuredForKey: THREAD_CONTAINER_KEY,
    };
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
    scheduleRestoreApply();
  });

  const renderItem = useStableEvent(({ item }: ListRenderItemInfo<ThreadRow>): ReactElement => {
    if (item.kind === "event") {
      return <FeedCard event={item.event} />;
    }
    return (
      <MemoizedCommanderMessageRow
        item={item.item}
        agentId={commander?.agentId ?? ""}
        serverId={commander?.serverId ?? ""}
        client={client}
        workspaceRoot={workspaceRoot}
      />
    );
  });

  const keyExtractor = useCallback((row: ThreadRow) => {
    return row.kind === "event" ? `event:${row.event.id}` : `cmd:${row.item.id}`;
  }, []);

  return (
    <ToolCallSheetProvider>
      <AssistantFileLinkResolverProvider
        client={client}
        serverId={commander?.serverId ?? ""}
        workspaceRoot={workspaceRoot}
        onOpenWorkspaceFile={handleInlinePathPress}
        toast={toast}
      >
        <View style={styles.container}>
          <FlatList
            ref={flatListRef}
            data={rows}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            onLayout={handleListLayout}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            onContentSizeChange={handleContentSizeChange}
            contentContainerStyle={styles.listContent}
            style={styles.list}
            testID="mission-control-thread"
          />
          {bottomAnchorController.mode === "detached" && pendingNewCount > 0 ? (
            <Pressable
              onPress={handleJumpToBottom}
              style={styles.newPill}
              accessibilityRole="button"
              accessibilityLabel={`${pendingNewCount} new`}
              testID="mission-control-new-pill"
            >
              <Text style={styles.newPillText}>{pendingNewCount} new</Text>
              <ThemedChevronDown size={14} uniProps={foregroundMapping} />
            </Pressable>
          ) : null}
        </View>
      </AssistantFileLinkResolverProvider>
    </ToolCallSheetProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[4],
    // Match AgentStreamView's horizontal gutters.
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  newPill: {
    position: "absolute",
    bottom: theme.spacing[4],
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: 999,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    ...theme.shadow.sm,
  },
  newPillText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
