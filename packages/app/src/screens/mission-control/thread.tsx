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
import type { StreamItem } from "@/types/stream";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import { FeedCard, type FeedCardEvent } from "./feed-card";

const THREAD_ANCHOR_ID = "mission-control-thread";
const THREAD_INITIAL_REQUEST_KEY = "mission-control-thread-initial";
const THREAD_CONTAINER_KEY = "mission-control-thread";
const NEAR_BOTTOM_THRESHOLD = 32;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];

const ThemedChevronDown = withUnistyles(ChevronDown);
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

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
}

export function MissionControlThread({
  events,
  commander,
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
  const routeRequest = useMemo<BottomAnchorRouteRequest | null>(
    () =>
      hasAnyRow
        ? {
            reason: "initial-entry",
            agentId: THREAD_ANCHOR_ID,
            requestKey: THREAD_INITIAL_REQUEST_KEY,
          }
        : null,
    [hasAnyRow],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId: THREAD_ANCHOR_ID,
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
    bottomAnchorController.handleScrollNearBottomChange({
      nextIsNearBottom: nearBottom,
      scrollDelta: contentOffset.y - previousOffsetY,
    });
  });

  const handleScrollBeginDrag = useStableEvent(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isUserScrollActiveRef.current = true;
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
              <ThemedChevronDown size={14} uniProps={accentForegroundMapping} />
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
    paddingVertical: theme.spacing[3],
  },
  newPill: {
    position: "absolute",
    bottom: theme.spacing[4],
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  newPillText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
}));
