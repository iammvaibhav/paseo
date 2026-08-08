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
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { AgentToolCallData, StreamItem } from "@/types/stream";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import { FeedCard, type FeedCardEvent } from "./feed-card";
import { MutedSystemRow } from "./muted-system-row";
import { isPaseoSystemMessage, PaseoSystemRow } from "./paseo-system-row";
import { PaseoAgentLinkProvider } from "@/components/markdown/paseo-agent-link";
import { parseHistoryAskAgentOpenUrl } from "@/history-ask/open-agent-link-parse";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { useShallow } from "zustand/react/shallow";

const THREAD_ANCHOR_ID = "mission-control-thread";
const THREAD_INITIAL_REQUEST_KEY = "mission-control-thread-initial";
const THREAD_CONTAINER_KEY = "mission-control-thread";
const NEAR_BOTTOM_THRESHOLD = 32;
/** Offset from the top that triggers loading an older page of events. */
const NEAR_TOP_THRESHOLD = 24;
/** Safety window: a prepend anchor that never lands is dropped after this. */
const PREPEND_ANCHOR_TIMEOUT_MS = 3_000;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_AGENT_NAMES: Readonly<Record<string, string | undefined>> = Object.freeze({});

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

// Pretty-rendered dispatch actions (spec "Tool rendering"). These are the only
// Commander tool calls that surface in normal (non-verbose) mode — everything
// else is machinery. `tag_message` is additionally silent in normal mode even
// though it renders pretty in verbose.
const PRETTY_DISPATCH_TOOLS: Record<string, true> = {
  fleet_send_prompt: true,
  fleet_list_agents: true,
  fleet_create_agent: true,
  create_agent: true,
  fleet_search: true,
};

function prettyDispatchToolLeaf(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  if (PRETTY_DISPATCH_TOOLS[trimmed]) {
    return trimmed;
  }
  const leaf = trimmed.split(/[.:/]/).at(-1) ?? "";
  return PRETTY_DISPATCH_TOOLS[leaf] ? leaf : null;
}

function isTagMessageTool(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "tag_message" || (trimmed.split(/[.:/]/).at(-1) ?? "") === "tag_message";
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
  /** Verbose mode (per-device header toggle, default OFF) shows the full
   * machinery: tool-call internals, thinking, paseo-system digests, interrupt
   * mechanics. Normal mode renders only the conversation, status/verdict/
   * proposal cards, and pretty-rendered dispatch actions. */
  verbose: boolean;
  /** agentId → display name for fleet dispatch tool badges. */
  agentNames: Readonly<Record<string, string | undefined>>;
}

function renderThreadToolCall(
  item: Extract<StreamItem, { kind: "tool_call" }>,
  verbose: boolean,
  agentNames: Readonly<Record<string, string | undefined>>,
): ReactElement | null {
  if (item.payload.source === "agent") {
    const data = item.payload.data;
    // OMP provider notices (quota warnings, task-result notices) render as
    // muted one-line system rows, never as inline tool-call prose — and they
    // are interrupt/cancel machinery, so normal mode hides them.
    if (isOmpNoticeToolCall(data)) {
      return verbose ? (
        <MutedSystemRow message={ompNoticeMessage(data)} timestamp={item.timestamp.getTime()} />
      ) : null;
    }
    // Normal mode: only pretty dispatch actions (tag_message is silent).
    const prettyLeaf = prettyDispatchToolLeaf(data.name);
    if (!verbose && (!prettyLeaf || isTagMessageTool(data.name))) {
      return null;
    }
    return (
      <ToolCall
        toolName={data.name}
        detail={data.detail}
        status={data.status}
        error={data.error}
        metadata={data.metadata}
        agentNames={agentNames}
      />
    );
  }
  if (!verbose) {
    return null;
  }
  return (
    <ToolCall
      toolName={item.payload.data.toolName}
      args={item.payload.data.arguments}
      result={item.payload.data.result}
      status={item.payload.data.status}
    />
  );
}

function CommanderMessageRow({
  item,
  agentId,
  serverId,
  client,
  workspaceRoot,
  verbose,
  agentNames,
}: CommanderMessageRowProps): ReactElement | null {
  switch (item.kind) {
    case "user_message":
      // `<paseo-system>` envelopes (fleet digests, schedule fires, notify-on-
      // finish) are pure machinery duplicating the cards — normal mode never
      // renders them; verbose shows the parsed digest/context as an expanded
      // block (never a collapsed divider).
      if (isPaseoSystemMessage(item.text)) {
        return verbose ? (
          <PaseoSystemRow text={item.text} timestamp={item.timestamp.getTime()} />
        ) : null;
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
      // Thinking is machinery noise in normal mode; verbose is the debug view.
      if (!verbose) {
        return null;
      }
      return (
        <ToolCall
          toolName="thinking"
          args={item.text}
          status={item.status === "ready" ? "completed" : "executing"}
        />
      );
    case "tool_call":
      return renderThreadToolCall(item, verbose, agentNames);
    case "todo_list":
      return verbose ? <TodoListCard items={item.items} /> : null;
    case "activity_log":
      return verbose ? (
        <ActivityLog
          type={item.activityType}
          message={item.message}
          timestamp={item.timestamp.getTime()}
          metadata={item.metadata}
        />
      ) : null;
    case "compaction":
      return verbose ? (
        <CompactionMarker status={item.status} trigger={item.trigger} preTokens={item.preTokens} />
      ) : null;
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
   * Verbose mode (per-device header overflow toggle, default OFF). Normal mode
   * shows only the conversation, status/verdict/proposal cards, and
   * pretty-rendered dispatch actions; verbose reveals tool-call internals,
   * thinking, inbound paseo-system digests, and interrupt mechanics.
   */
  verbose?: boolean;
  /**
   * Per-device "Clear view" point (ms epoch): the thread renders only rows at
   * or after this moment, with a "Show earlier" affordance paging back to the
   * hidden rows. Null/undefined = no clear point (full thread).
   */
  clearPointTs?: number | null;
  /** Load an older page of feed events (cursor paging via beforeSeq). */
  onLoadOlder?: () => void | Promise<unknown>;
  isLoadingOlder?: boolean;
  hasOlderEvents?: boolean;
}

export function MissionControlThread({
  events,
  commander,
  verbose = false,
  clearPointTs = null,
  onLoadOlder,
  isLoadingOlder = false,
  hasOlderEvents = false,
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
  const streamViewportMetricsRef = useRef({
    containerKey: THREAD_CONTAINER_KEY,
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });

  // Cursor paging on scroll-up: a load is in flight while the request ref is
  // armed; once it resolves with events, the next content-size change is the
  // prepend and gets scroll-compensated so the visible rows don't jump.
  const olderRequestInFlightRef = useRef(false);
  const prependReadyRef = useRef(false);
  // Set when an older page resolved with events, so the rows-growth effect
  // doesn't count prepended history as "new" activity.
  const prependGrowthRef = useRef(false);
  const prependAnchorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPrependAnchor = useCallback(() => {
    prependReadyRef.current = false;
    clearTimeout(prependAnchorTimeoutRef.current ?? undefined);
    prependAnchorTimeoutRef.current = null;
  }, []);

  const requestOlderEvents = useCallback(() => {
    if (!onLoadOlder || olderRequestInFlightRef.current || isLoadingOlder || !hasOlderEvents) {
      return;
    }
    olderRequestInFlightRef.current = true;
    clearPrependAnchor();
    const result = onLoadOlder();
    if (result && typeof result.then === "function") {
      void Promise.resolve(result)
        .then((loaded) => {
          if (loaded) {
            prependGrowthRef.current = true;
            prependReadyRef.current = true;
            prependAnchorTimeoutRef.current = setTimeout(
              clearPrependAnchor,
              PREPEND_ANCHOR_TIMEOUT_MS,
            );
          }
          return loaded;
        })
        .finally(() => {
          olderRequestInFlightRef.current = false;
        });
    } else {
      olderRequestInFlightRef.current = false;
    }
  }, [clearPrependAnchor, hasOlderEvents, isLoadingOlder, onLoadOlder]);

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

  // Live agent identity for the fleet dispatch tool badges ("Steered Name
  // (host)", "Spawned Name on host"). Shallow-compared so the memoized row
  // keeps its reference while the store churns.
  const agentNames = useSessionStore(
    useShallow((state) => {
      if (!commander) {
        return EMPTY_AGENT_NAMES;
      }
      const session = state.sessions[commander.serverId];
      if (!session) {
        return EMPTY_AGENT_NAMES;
      }
      const names: Record<string, string | undefined> = {};
      for (const [agentId, agent] of session.agents) {
        names[agentId] = agent.name ?? agent.title ?? undefined;
      }
      for (const [agentId, agent] of session.agentDetails) {
        if (names[agentId] === undefined) {
          names[agentId] = agent.name ?? agent.title ?? undefined;
        }
      }
      return names;
    }),
  );

  const handleOpenPaseoAgent = useCallback((href: string): boolean => {
    const target = parseHistoryAskAgentOpenUrl(href);
    if (!target) {
      return false;
    }
    useInspectorStore.getState().openInspectorAgent(target);
    return true;
  }, []);

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

  // "Clear view" (spec): a per-device clear point filters the thread to rows
  // from that moment on; the hidden rows stay in the store behind a "Show
  // earlier" affordance. Revealing is in-memory — a fresh clear re-filters.
  const [revealEarlier, setRevealEarlier] = useState(false);
  useEffect(() => {
    setRevealEarlier(false);
  }, [clearPointTs]);

  const visibleRows = useMemo(() => {
    if (clearPointTs === null || revealEarlier) {
      return rows;
    }
    return rows.filter((row) => row.ts >= clearPointTs);
  }, [clearPointTs, revealEarlier, rows]);
  const hiddenEarlierCount = rows.length - visibleRows.length;

  const hasAnyRow = rows.length > 0;
  const anchorAgentId = commander ? `${THREAD_ANCHOR_ID}:${commander.serverId}` : THREAD_ANCHOR_ID;
  const routeRequest = useMemo<BottomAnchorRouteRequest | null>(
    () =>
      hasAnyRow
        ? {
            reason: "initial-entry",
            agentId: THREAD_ANCHOR_ID,
            requestKey: `${THREAD_INITIAL_REQUEST_KEY}:${commander?.serverId ?? ""}:${commander?.agentId ?? ""}`,
          }
        : null,
    [commander, hasAnyRow],
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
    // Older-page prepends are not new activity — never count them toward the
    // "N new" pill (which tracks events since the user left the live tail).
    if (prependGrowthRef.current) {
      prependGrowthRef.current = false;
      return;
    }
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

    // Scroll-up paging: reaching the top of the loaded history with more
    // events available fetches an older page. Only when the user has left the
    // live tail (detached) — the initial bottom-anchored landing must never
    // page. A "Clear view" filter that is hiding earlier rows disables
    // scroll-up paging: the "Show earlier" affordance owns paging back.
    if (
      contentOffset.y <= NEAR_TOP_THRESHOLD &&
      modeRef.current !== "sticky-bottom" &&
      (clearPointTs === null || revealEarlier)
    ) {
      requestOlderEvents();
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
      // swallowing the user's own scroll events.
      programmaticScrollEventBudgetRef.current = 0;
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

  // Drop any in-flight prepend anchoring when the thread goes away. Scroll
  // position preservation is the agent-chat pattern: the screen stays mounted
  // (freeze, don't unmount) and the bottom-anchor controller owns follow; the
  // FlatList keeps its offset across re-renders and width changes without a
  // bespoke restore pass.
  useEffect(() => {
    return () => {
      clearTimeout(prependAnchorTimeoutRef.current ?? undefined);
      prependAnchorTimeoutRef.current = null;
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
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    let nextOffsetY = streamViewportMetricsRef.current.offsetY;
    // Prepend anchoring: after an older page lands, the rows above the
    // viewport grew by the prepended height; compensate the scroll offset so
    // the previously visible rows stay put (no jump during scroll-up paging).
    if (prependReadyRef.current) {
      clearPrependAnchor();
      const addedHeight = nextContentHeight - previousContentHeight;
      if (addedHeight > 0) {
        nextOffsetY = Math.max(0, nextOffsetY + addedHeight);
        programmaticScrollEventBudgetRef.current = 3;
        flatListRef.current?.scrollToOffset({ offset: nextOffsetY, animated: false });
        scrollOffsetYRef.current = nextOffsetY;
      }
    }
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: THREAD_CONTAINER_KEY,
      contentHeight: nextContentHeight,
      contentMeasuredForKey: THREAD_CONTAINER_KEY,
      offsetY: nextOffsetY,
    };
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
  });

  const renderItem = useStableEvent(({ item }: ListRenderItemInfo<ThreadRow>): ReactElement => {
    if (item.kind === "event") {
      return <FeedCard event={item.event} verbose={verbose} />;
    }
    return (
      <MemoizedCommanderMessageRow
        item={item.item}
        agentId={commander?.agentId ?? ""}
        serverId={commander?.serverId ?? ""}
        client={client}
        workspaceRoot={workspaceRoot}
        verbose={verbose}
        agentNames={agentNames}
      />
    );
  });

  const keyExtractor = useCallback((row: ThreadRow) => {
    return row.kind === "event" ? `event:${row.event.id}` : `cmd:${row.item.id}`;
  }, []);

  const handleRevealEarlier = useCallback(() => setRevealEarlier(true), []);

  const showEarlierHeader = useMemo(() => {
    if (hiddenEarlierCount <= 0) {
      return null;
    }
    return (
      <Pressable
        onPress={handleRevealEarlier}
        style={styles.showEarlierButton}
        accessibilityRole="button"
        accessibilityLabel={`Show ${hiddenEarlierCount} earlier messages`}
        testID="mission-control-show-earlier"
      >
        <Text style={styles.showEarlierText}>Show earlier ({hiddenEarlierCount})</Text>
      </Pressable>
    );
  }, [handleRevealEarlier, hiddenEarlierCount]);

  return (
    <ToolCallSheetProvider>
      <AssistantFileLinkResolverProvider
        client={client}
        serverId={commander?.serverId ?? ""}
        workspaceRoot={workspaceRoot}
        onOpenWorkspaceFile={handleInlinePathPress}
        toast={toast}
      >
        <PaseoAgentLinkProvider openAgent={handleOpenPaseoAgent}>
          <View style={styles.container}>
            <FlatList
              ref={flatListRef}
              data={visibleRows}
              ListHeaderComponent={showEarlierHeader}
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
        </PaseoAgentLinkProvider>
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
    // Same centered content column as AgentStreamView's stream items and the
    // Composer (MAX_CONTENT_WIDTH): the thread list and the composer box share
    // one gutter, so message text and the composer edge align exactly as a
    // workspace agent chat does, at any thread column width.
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginHorizontal: "auto",
    alignSelf: "center",
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
  showEarlierButton: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    marginBottom: theme.spacing[3],
  },
  showEarlierText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
}));
