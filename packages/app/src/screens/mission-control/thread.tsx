import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ChevronDown } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { containsLeakedToolMarkup } from "./answer-card-display";
import {
  ActivityLog,
  AssistantMessage,
  CompactionMarker,
  TodoListCard,
  ToolCall,
  UserMessage,
} from "@/components/message";
import { type BottomAnchorRouteRequest } from "@/agent-stream/bottom-anchor-controller";
import { AnchoredList } from "@/agent-stream/anchored-list";
import {
  type StreamHistoryBoundary,
  type StreamRenderSegments,
  type StreamSegmentRenderers,
  type StreamViewportHandle,
} from "@/agent-stream/strategy";
import { resolveStreamRenderStrategy } from "@/agent-stream/strategy-resolver";
import {
  AssistantFileLinkResolverProvider,
  normalizeInlinePathTarget,
  type InlinePathTarget,
} from "@/assistant-file-links";
import { useToast } from "@/contexts/toast-context";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { AgentToolCallData, StreamItem } from "@/types/stream";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import { cardRunPosition, FeedCard, type CardRunRowClass, type FeedCardEvent } from "./feed-card";
import { readDispatchToolResultError } from "./thread-tool-error";
import {
  classifyThreadRow,
  isTagMessageTool,
  prettyDispatchToolLeaf,
  type ThreadRow,
} from "./thread-classification";
import { MutedSystemRow } from "./muted-system-row";
import { isPaseoSystemMessage, PaseoSystemRow } from "./paseo-system-row";
import { commanderUserMessageText } from "./thread-instruction-envelope";
import { PaseoAgentLinkProvider } from "@/components/markdown/paseo-agent-link";
import { parseHistoryAskAgentOpenUrl } from "@/history-ask/open-agent-link-parse";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { useShallow } from "zustand/react/shallow";

const THREAD_ANCHOR_ID = "mission-control-thread";
const THREAD_INITIAL_REQUEST_KEY = "mission-control-thread-initial";
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_THREAD_ROWS: ThreadRow[] = [];
const EMPTY_AGENT_NAMES: Readonly<Record<string, string | undefined>> = Object.freeze({});

const ThemedChevronDown = withUnistyles(ChevronDown);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

// Bracket-prefixed provider fallback records ("[credential_pin] Unsupported
// history record", "[developer] developer note") are plumbing, not prose.
const BRACKET_PLUMBING_PATTERN = /^\[[a-z][a-z0-9_]*\]\s/;
const OMP_NOTICE_SOURCES = new Set(["omp_notice", "omp_system_notice"]);

function isPlumbingAssistantText(text: string): boolean {
  const trimmed = text.trimStart();
  // A raw tool-call tag is never prose: it is a model that failed native
  // function calling. Cards carry the outcome, so hide the markup here.
  if (containsLeakedToolMarkup(trimmed)) {
    return true;
  }
  return BRACKET_PLUMBING_PATTERN.test(trimmed);
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
  /** host → display alias resolver (maps "local" to host alias). */
  resolveHost?: (host: string) => string;
}

function renderThreadToolCall(
  item: Extract<StreamItem, { kind: "tool_call" }>,
  verbose: boolean,
  agentNames: Readonly<Record<string, string | undefined>>,
  resolveHost?: (host: string) => string,
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
    // Errors are not machinery noise: a failed dispatch must read as failed in
    // normal AND verbose mode. The result-level check catches rejections that
    // completed with a structured `success: false` result (live incident:
    // a rejected fleet_create_agent showed a success header).
    const dispatchError = prettyLeaf ? readDispatchToolResultError(data) : null;
    return (
      <ToolCall
        toolName={data.name}
        detail={data.detail}
        status={dispatchError ? "failed" : data.status}
        error={dispatchError ?? data.error}
        metadata={data.metadata}
        agentNames={agentNames}
        resolveHost={resolveHost}
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
      resolveHost={resolveHost}
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
  resolveHost,
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
      // Busy Commander instruction envelopes ("New instruction (#N). Acknowledge
      // it in one line, …" + the ledger + the auto-recall block) are steered
      // prompts, not conversation: normal mode shows only the instruction text
      // the envelope carries; verbose keeps the full machinery verbatim.
      return (
        <UserMessage
          serverId={serverId}
          agentId={agentId}
          messageId={item.messageId}
          message={commanderUserMessageText(item.text, verbose)}
          images={item.images}
          attachments={item.attachments}
          timestamp={item.timestamp.getTime()}
          client={client}
        />
      );
    case "assistant_message":
      // Normal mode shows ONLY cards and user messages: assistant turn text,
      // thinking, tool calls, and acknowledgments are all verbose-only.
      if (!verbose) {
        return null;
      }
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
          phase="complete"
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
      return renderThreadToolCall(item, verbose, agentNames, resolveHost);
    case "todo_list":
      return verbose ? <TodoListCard items={item.items} activity={item.activity} /> : null;
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

// Resolves tool-payload host strings for display. "local" (or an empty host)
// is only meaningful daemon-side — render the commander host's alias instead;
// never the literal "local".
function useCommanderHostResolver(commander: MissionControlCommander | null) {
  const hosts = useHosts();
  const commanderConfig = useDaemonConfig(commander?.serverId ?? null);
  const commanderHostAlias =
    commanderConfig.config?.missionControl?.hostAlias?.trim() ||
    hosts.find((h) => h.serverId === commander?.serverId)?.label ||
    commander?.serverId ||
    null;
  return useCallback(
    (host: string): string => {
      const trimmed = host.trim();
      if (trimmed === "" || trimmed.toLowerCase() === "local") {
        return commanderHostAlias ?? trimmed;
      }
      return trimmed;
    },
    [commanderHostAlias],
  );
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

  const resolveHost = useCommanderHostResolver(commander);
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
  const isMobile = useIsCompactFormFactor();
  const streamStrategy = useMemo(
    () => resolveStreamRenderStrategy({ platform: Platform.OS, isMobileBreakpoint: isMobile }),
    [isMobile],
  );
  const viewportRef = useRef<StreamViewportHandle | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  isNearBottomRef.current = isNearBottom;

  // Cursor paging on scroll-up (older events): the shared surface's
  // history-start pagination calls onNearHistoryStart when the user scrolls
  // to the top; the surface's own prepend anchoring keeps the visible rows
  // from jumping when the older page lands.
  const [olderPageCount, setOlderPageCount] = useState(0);
  const olderPageCountRef = useRef(0);
  // Set when an older page resolved with events, so the rows-growth effect
  // doesn't count prepended history as "new" activity.
  const prependGrowthRef = useRef(false);
  // "Clear view" (spec): a per-device clear point filters the thread to rows
  // from that moment on; the hidden rows stay in the store behind a "Show
  // earlier" affordance. Revealing is in-memory — a fresh clear re-filters.
  // Declared before the paging callback: while hiding rows, "Show earlier"
  // owns paging back, so the scroll surface must not fetch older pages.
  const [revealEarlier, setRevealEarlier] = useState(false);
  useEffect(() => {
    setRevealEarlier(false);
  }, [clearPointTs]);
  const requestOlderEvents = useCallback(async (): Promise<boolean> => {
    if (!onLoadOlder || isLoadingOlder || !hasOlderEvents) {
      return false;
    }
    // While a "Clear view" filter is hiding earlier rows, "Show earlier" owns
    // paging back — the scroll surface must not fetch older pages.
    if (clearPointTs !== null && !revealEarlier) {
      return false;
    }
    const loaded = await onLoadOlder();
    // The screen's loadOlderEvents resolves true when any host returned new
    // events; the surface treats `started === true` as a landed page.
    const loadedEvents = loaded === true;
    if (loadedEvents) {
      prependGrowthRef.current = true;
      olderPageCountRef.current += 1;
      setOlderPageCount(olderPageCountRef.current);
    }
    return loadedEvents;
  }, [clearPointTs, hasOlderEvents, isLoadingOlder, onLoadOlder, revealEarlier]);
  // The surface keys paging progress on this: it is always non-null (the
  // paging state machine refuses to load while the key is null) and changes
  // exactly when an older page lands, which arms its prepend-anchor settle
  // pass. The value itself is meaningless — only stability and change-on-load
  // matter.
  const olderHistoryProgressKey = `mission-control-older:${olderPageCount}`;

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
  // keeps its reference while the store churns. Live NAME is fine (names are
  // write-once identity); live TITLE is not a snapshot — a badge must never
  // read a recorded dispatch through today's title. When no name is known the
  // display falls back to the agentId carried in the tool payload itself.
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
        names[agentId] = agent.name ?? undefined;
      }
      for (const [agentId, agent] of session.agentDetails) {
        if (names[agentId] === undefined) {
          names[agentId] = agent.name ?? undefined;
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

  const [pendingNewCount, setPendingNewCount] = useState(0);
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
    if (!isNearBottomRef.current && rows.length > previousCount) {
      setPendingNewCount((current) => current + (rows.length - previousCount));
    }
  }, [rows.length]);
  useEffect(() => {
    if (isNearBottom) {
      setPendingNewCount(0);
    }
  }, [isNearBottom]);

  const handleJumpToBottom = useCallback(() => {
    viewportRef.current?.scrollToBottom("jump-to-bottom");
  }, []);

  const renderThreadRow = useStableEvent(
    (item: ThreadRow, index: number, items: ThreadRow[]): ReactElement => {
      // Fresh per render: `verbose` only changes via the header toggle.
      const classifyRow = (row: ThreadRow): CardRunRowClass => classifyThreadRow(row, verbose);
      const row =
        item.kind === "event" ? (
          <FeedCard
            event={item.event}
            verbose={verbose}
            position={
              classifyRow(item) === "card" ? cardRunPosition(items, index, classifyRow) : "only"
            }
          />
        ) : (
          <MemoizedCommanderMessageRow
            item={item.item}
            agentId={commander?.agentId ?? ""}
            serverId={commander?.serverId ?? ""}
            client={client}
            workspaceRoot={workspaceRoot}
            verbose={verbose}
            agentNames={agentNames}
            resolveHost={resolveHost}
          />
        );
      // Same centered content column as AgentStreamView's stream items: the web
      // strategy viewport is full-width, so each row centers itself.
      return <View style={styles.rowContent}>{row}</View>;
    },
  );
  const renderers = useMemo<StreamSegmentRenderers<ThreadRow>>(() => {
    // Referenced so the memo re-creates when verbose flips (same pattern as
    // use-aggregated-agents' runtimeVersion): the web strategy memoizes
    // rendered rows on renderer identity, so a toggle flip MUST re-create the
    // renderers or mounted rows keep the stale gate until new data lands. The
    // stable event ref already points at this render's closure, so re-created
    // renderers render with the fresh verbose value immediately — no remount.
    void verbose;
    return {
      renderHistoryVirtualizedRow: (item, index, items) => renderThreadRow(item, index, items),
      renderHistoryMountedRow: (item, index, items) => renderThreadRow(item, index, items),
      renderLiveHeadRow: (item, index, items) => renderThreadRow(item, index, items),
      renderLiveAuxiliary: () => null,
    };
  }, [renderThreadRow, verbose]);

  const keyExtractor = useCallback((row: ThreadRow) => {
    return row.kind === "event" ? `event:${row.event.id}` : `cmd:${row.item.id}`;
  }, []);

  const segments = useMemo<StreamRenderSegments<ThreadRow>>(
    () => ({
      historyVirtualized: EMPTY_THREAD_ROWS,
      historyMounted: visibleRows,
      liveHead: EMPTY_THREAD_ROWS,
    }),
    [visibleRows],
  );
  const boundary = useMemo<StreamHistoryBoundary>(
    () => ({
      hasVirtualizedHistory: false,
      hasMountedHistory: visibleRows.length > 0,
      hasLiveHead: false,
    }),
    [visibleRows.length],
  );

  const handleRevealEarlier = useCallback(() => setRevealEarlier(true), []);

  const showEarlierHeader = useMemo(() => {
    if (hiddenEarlierCount <= 0) {
      return undefined;
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

  const newPillAffordance = useMemo(() => {
    if (pendingNewCount <= 0) {
      return undefined;
    }
    return (
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
    );
  }, [handleJumpToBottom, pendingNewCount]);

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
            <AnchoredList
              strategy={streamStrategy}
              viewportRef={viewportRef}
              onNearBottomChange={setIsNearBottom}
              scrollToBottomAffordance={newPillAffordance}
              agentId={anchorAgentId}
              segments={segments}
              boundary={boundary}
              renderers={renderers}
              listEmptyComponent={null}
              routeBottomAnchorRequest={routeRequest}
              isAuthoritativeHistoryReady
              onNearHistoryStart={requestOlderEvents}
              isLoadingOlderHistory={isLoadingOlder}
              hasOlderHistory={hasOlderEvents}
              olderHistoryProgressKey={olderHistoryProgressKey}
              scrollEnabled
              listStyle={styles.list}
              baseListContentContainerStyle={styles.listContent}
              forwardListContentContainerStyle={styles.listContent}
              keyExtractor={keyExtractor}
              topSlot={showEarlierHeader}
            />
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
  // Rows center themselves inside the platform viewport (the web strategy's
  // scroll container is full-width; the native list centers via listContent).
  rowContent: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginHorizontal: "auto",
    alignSelf: "center",
  },
  newPill: {
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
