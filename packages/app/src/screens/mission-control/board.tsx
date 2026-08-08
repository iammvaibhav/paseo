import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  FlatList,
  Modal,
  Platform,
  StatusBar,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FadeIn, FadeOut } from "react-native-reanimated";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  Square,
} from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { HostGlyph } from "@/components/host-glyph";
import { FloatingSurface } from "@/components/ui/floating";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { isWeb } from "@/constants/platform";
import {
  LIFECYCLE_BUCKET_LABELS,
  rowActivityMs,
  type LifecycleBucket,
  type LifecycleRow,
} from "@/mission-control/lifecycle";
import {
  buildAgentReference,
  resolveBoardRowMenuActions,
  type BoardRowMenuAction,
} from "@/mission-control/row-menu";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useInspectorStore } from "./inspector-store";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedArchive = withUnistyles(Archive);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSquare = withUnistyles(Square);

const menuIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Static row-menu icons. Hoisted so the menu items never re-create JSX per
// render (react-perf: no JSX literals in prop position).
const MENU_OPEN_ICON = <ThemedExternalLink size={14} uniProps={menuIconMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={14} uniProps={menuIconMapping} />;
const MENU_STOP_ICON = <ThemedSquare size={14} uniProps={menuIconMapping} />;
const MENU_CIRCLE_CHECK_ICON = <ThemedCircleCheck size={14} uniProps={menuIconMapping} />;
const MENU_ARCHIVE_ICON = <ThemedArchive size={14} uniProps={menuIconMapping} />;

const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotWarning });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotDanger });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Per-row leading glyph: failure stays red, awaiting-input amber, running blue,
 * ready success green, done/dormant quiet. One status token per signal (§13). */
function rowIconAndColor(row: LifecycleRow) {
  switch (row.bucket) {
    case "needs_you": {
      const failed = row.agent.status === "error" || row.agent.attentionReason === "error";
      return failed
        ? { Icon: ThemedCircleX, mapping: dangerColorMapping }
        : { Icon: ThemedCircleAlert, mapping: warningColorMapping };
    }
    case "running":
      return { Icon: ThemedCircleDot, mapping: runningColorMapping };
    case "ready":
      return { Icon: ThemedCircleCheck, mapping: successColorMapping };
    case "done":
      return { Icon: ThemedCircleCheck, mapping: mutedColorMapping };
    case "dormant":
      return { Icon: ThemedCircleDot, mapping: mutedColorMapping };
  }
}

type BoardItem =
  | { kind: "bucket"; bucket: LifecycleBucket; label: string }
  | { kind: "agent"; row: LifecycleRow }
  | { kind: "offlineHost"; serverId: string; label: string };

function itemKey(item: BoardItem): string {
  switch (item.kind) {
    case "bucket":
      return `bucket:${item.bucket}`;
    case "agent":
      return `agent:${item.row.agent.serverId}:${item.row.agent.id}`;
    case "offlineHost":
      return `offline:${item.serverId}`;
  }
}

async function setAgentLifecycle(
  serverId: string,
  agentId: string,
  action: "done" | "clear",
): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    return;
  }
  const payload = await client.missionControlLifecycleSet({ serverId, agentId, action });
  if (!payload.ok) {
    throw new Error(payload.error ?? "Failed to update agent");
  }
}

async function clearAgentLifecycle(serverId: string, agentId: string): Promise<void> {
  await setAgentLifecycle(serverId, agentId, "clear");
}

function MissionControlBoardEmpty(): ReactElement {
  return (
    <Text style={styles.emptyState} testID="mission-control-board-empty">
      No active agents
    </Text>
  );
}

export function MissionControlBoard({
  testID,
  hideAgentNames = false,
}: {
  testID?: string;
  /**
   * Central-config preference: hide name chips, leaving titles (spec).
   * Defaults to the central config read; the prop lets callers override.
   */
  hideAgentNames?: boolean;
} = {}) {
  const [showAll, setShowAll] = useState(false);
  const centralConfig = useMissionControlCentralConfig();
  const resolvedHideAgentNames = hideAgentNames || centralConfig.config?.hideAgentNames === true;
  const { groups } = useMissionControlLifecycle({
    showAll,
    retentionDays: centralConfig.config?.retentionDays,
  });
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);

  const doneRows = useMemo(
    () => groups.find((group) => group.bucket === "done")?.rows ?? [],
    [groups],
  );

  const handleClearAll = useCallback(() => {
    // Clear every Done row on its own host. Fire-and-forget per agent; the
    // "Cleared" verdict cards push back and refresh the board.
    for (const row of doneRows) {
      void clearAgentLifecycle(row.agent.serverId, row.agent.id).catch(() => {
        // A failed clear leaves the row in Done; the next push reconciles.
      });
    }
  }, [doneRows]);

  const items = useMemo<BoardItem[]>(() => {
    const boardItems: BoardItem[] = [];
    for (const group of groups) {
      boardItems.push({
        kind: "bucket",
        bucket: group.bucket,
        label: LIFECYCLE_BUCKET_LABELS[group.bucket],
      });
      for (const row of group.rows) {
        boardItems.push({ kind: "agent", row });
      }
    }
    for (const host of hosts) {
      if (connectionStatuses.get(host.serverId) === "online") {
        continue;
      }
      boardItems.push({ kind: "offlineHost", serverId: host.serverId, label: host.label });
    }
    return boardItems;
  }, [connectionStatuses, groups, hosts]);

  const renderItem = useCallback(
    ({ item }: { item: BoardItem }) => {
      if (item.kind === "bucket") {
        return (
          <BucketHeader
            key={itemKey(item)}
            bucket={item.bucket}
            label={item.label}
            onClearAll={item.bucket === "done" && doneRows.length > 0 ? handleClearAll : null}
          />
        );
      }
      if (item.kind === "offlineHost") {
        return (
          <View style={styles.offlineHostRow} key={itemKey(item)}>
            <HostGlyph
              serverId={item.serverId}
              label={item.label}
              size="sm"
              testID={`mission-control-offline-host-glyph-${item.serverId}`}
            />
            <Text style={styles.offlineHostState}>offline</Text>
          </View>
        );
      }
      return (
        <MemoizedAgentRow
          key={itemKey(item)}
          row={item.row}
          hideAgentNames={resolvedHideAgentNames}
        />
      );
    },
    [doneRows.length, handleClearAll, resolvedHideAgentNames],
  );

  return (
    <View style={styles.container}>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>All unarchived</Text>
        <Switch
          value={showAll}
          onValueChange={setShowAll}
          accessibilityLabel="Show all unarchived agents"
          testID="mission-control-board-toggle"
        />
      </View>
      <FlatList
        testID={testID}
        data={items}
        renderItem={renderItem}
        keyExtractor={itemKey}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={MissionControlBoardEmpty}
      />
    </View>
  );
}

function BucketHeader({
  bucket,
  label,
  onClearAll,
}: {
  bucket: LifecycleBucket;
  label: string;
  onClearAll: (() => void) | null;
}) {
  return (
    <View style={styles.bucketHeaderRow}>
      <Text style={styles.bucketHeader}>{label}</Text>
      {onClearAll ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={onClearAll}
          testID={`mission-control-clear-${bucket}`}
        >
          Clear all
        </Button>
      ) : null}
    </View>
  );
}

/** The row's identity block: title, status chips, headline, and the Done
 * verdict line. Extracted so the trigger's JSX stays shallow (jsx-max-depth)
 * and the chips keep the same nesting inside their own component. */
function AgentRowTextContent({
  row,
  keyLine,
  showNameChip,
  headline,
}: {
  row: LifecycleRow;
  keyLine: string;
  showNameChip: boolean;
  headline: string | null;
}): ReactElement {
  const isDone = row.bucket === "done";
  return (
    <View style={styles.agentText}>
      <Text numberOfLines={1} style={styles.agentTitle}>
        {keyLine}
      </Text>
      <View style={styles.agentMetaRow}>
        {row.doneReason === "stopped-by-user" ? (
          <View style={styles.stoppedChip}>
            <Text numberOfLines={1} style={styles.stoppedChipText}>
              Stopped by you
            </Text>
          </View>
        ) : null}
        {row.agent.stoppedBy === "system" ? (
          <View style={styles.stoppedChip}>
            <Text numberOfLines={1} style={styles.stoppedChipText}>
              Interrupted
            </Text>
          </View>
        ) : null}
        {showNameChip ? (
          <View style={styles.nameChip}>
            <Text numberOfLines={1} style={styles.nameChipText}>
              {row.agent.name}
            </Text>
          </View>
        ) : null}
        {headline ? (
          <Text numberOfLines={1} style={styles.agentHeadline}>
            {headline}
          </Text>
        ) : null}
      </View>
      {isDone && row.verdict ? (
        <Text numberOfLines={1} style={styles.verdictLine}>
          {row.verdict.summary}
        </Text>
      ) : null}
    </View>
  );
}

/** The row's context-menu items. Renders inside <ContextMenu> so the surface
 * context flows through; extracted so AgentRowImpl's branch count stays under
 * the complexity budget. */
function AgentRowMenuContent({
  agentId,
  menuActions,
  isArchiving,
  onOpenInWorkspace,
  onCopyReference,
  onStop,
  onMarkDone,
  onClear,
  onArchive,
}: {
  agentId: string;
  menuActions: BoardRowMenuAction[];
  isArchiving: boolean;
  onOpenInWorkspace: () => void;
  onCopyReference: () => void;
  onStop: () => void;
  onMarkDone: () => void;
  onClear: () => void;
  onArchive: () => void;
}): ReactElement {
  return (
    <ContextMenuContent
      align="start"
      width={240}
      testID={`mission-control-row-context-menu-${agentId}`}
    >
      {menuActions.includes("open") ? (
        <ContextMenuItem
          leading={MENU_OPEN_ICON}
          onSelect={onOpenInWorkspace}
          testID={`mission-control-row-open-${agentId}`}
        >
          Open in workspace
        </ContextMenuItem>
      ) : null}
      {menuActions.includes("copy-reference") ? (
        <ContextMenuItem
          leading={MENU_COPY_ICON}
          onSelect={onCopyReference}
          testID={`mission-control-row-copy-reference-${agentId}`}
        >
          Copy reference
        </ContextMenuItem>
      ) : null}
      {menuActions.includes("stop") ? (
        <ContextMenuItem
          leading={MENU_STOP_ICON}
          onSelect={onStop}
          testID={`mission-control-row-stop-${agentId}`}
        >
          Stop
        </ContextMenuItem>
      ) : null}
      {menuActions.includes("mark-done") ? (
        <ContextMenuItem
          leading={MENU_CIRCLE_CHECK_ICON}
          onSelect={onMarkDone}
          testID={`mission-control-row-mark-done-${agentId}`}
        >
          Mark done
        </ContextMenuItem>
      ) : null}
      {menuActions.includes("clear") ? (
        <ContextMenuItem
          leading={MENU_CIRCLE_CHECK_ICON}
          onSelect={onClear}
          testID={`mission-control-row-clear-${agentId}`}
        >
          Clear
        </ContextMenuItem>
      ) : null}
      {menuActions.includes("archive") ? (
        <ContextMenuItem
          leading={MENU_ARCHIVE_ICON}
          onSelect={onArchive}
          status={isArchiving ? "pending" : undefined}
          pendingLabel="Archiving..."
          testID={`mission-control-row-archive-${agentId}`}
        >
          Archive
        </ContextMenuItem>
      ) : null}
    </ContextMenuContent>
  );
}

interface PopoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measurePopoverTrigger(element: View): Promise<PopoverRect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

// Native Modal onRequestClose (Android back button). Hoisted so the Modal
// never re-creates a prop per render; the popover is hover-only (web) today.
const noopRequestClose = () => undefined;

/** Hover identity card (docs/hover.md + spec "Hover identity card"): shows
 * the full agent title and its short description below the row, truncated
 * compact; when both are missing it renders nothing.
 *
 * Rendered through the sanctioned floating-panel escape
 * (docs/floating-panels.md Gotcha 1/2): web portals into the shared
 * overlay-root at the tooltip layer, native opens a transparent Modal. An
 * in-tree absolutely positioned popover paints BEHIND adjacent FlatList rows
 * on web — later siblings stack above earlier ones regardless of zIndex.
 * Positioning mirrors ui/tooltip.tsx: the trigger is measured with
 * measureInWindow and the content is bottom-anchored below the row at the
 * old in-tree offsets, so it needs no content-size round-trip (no
 * two-measurement flash). Pointer-events stay none; the row's
 * useHoverSafeZone bridges the gap. */
function AgentRowIdentityPopover({
  rowTriggerRef,
  rowPopoverRef,
  title,
  description,
}: {
  rowTriggerRef: RefObject<View | null>;
  rowPopoverRef: RefObject<View | null>;
  title: string | null;
  description: string | null;
}): ReactElement | null {
  const [triggerRect, setTriggerRect] = useState<PopoverRect | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!rowTriggerRef.current) {
      return;
    }
    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;
    void measurePopoverTrigger(rowTriggerRef.current).then((rect) => {
      if (!cancelled) {
        setTriggerRect({ ...rect, y: rect.y + statusBarHeight });
      }
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [rowTriggerRef]);

  useEffect(() => {
    if (!triggerRect) {
      return;
    }
    // Below the row, inset like the old in-tree popover (left/right
    // theme.spacing[2], gap theme.spacing[1]).
    setPosition({ x: triggerRect.x + 8, y: triggerRect.y + triggerRect.height + 4 });
  }, [triggerRect]);

  const frameStyle = useMemo(() => {
    const width = triggerRect ? Math.max(0, triggerRect.width - 16) : undefined;
    return {
      position: "absolute" as const,
      top: position?.y ?? -9999,
      left: position?.x ?? -9999,
      ...(width !== undefined ? { width } : {}),
    };
  }, [position?.x, position?.y, triggerRect]);

  if (title === null && description === null) {
    return null;
  }

  const popover = (
    <FloatingSurface
      ref={rowPopoverRef}
      pointerEvents="none"
      entering={FadeIn.duration(80)}
      exiting={FadeOut.duration(80)}
      collapsable={false}
      testID="mission-control-row-popover"
      style={styles.identityPopover}
      frameStyle={frameStyle}
    >
      {title ? (
        <Text style={styles.identityPopoverTitle} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
      {description ? (
        <Text style={styles.identityPopoverDescription} numberOfLines={3}>
          {description}
        </Text>
      ) : null}
    </FloatingSurface>
  );

  // Web: avoid React Native Web's <Modal/> (it renders <dialog> and can steal
  // focus / disrupt hover) — portal into the shared overlay-root at the
  // tooltip layer so the popover floats above adjacent rows, dropdown menus,
  // and modals. Same escape as ui/tooltip.tsx.
  if (isWeb) {
    return createPortal(
      <View pointerEvents="none" style={styles.identityPopoverOverlay}>
        {popover}
      </View>,
      getOverlayRoot(),
    );
  }

  // Native: a transparent Modal floats above every sibling pane (hover is
  // web-only today, so this is the defensive native path of the same escape).
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={noopRequestClose}
    >
      <View pointerEvents="none" style={styles.identityPopoverModalOverlay}>
        {popover}
      </View>
    </Modal>
  );
}

const MemoizedAgentRow = memo(AgentRowImpl);

function AgentRowImpl({
  row,
  hideAgentNames,
}: {
  row: LifecycleRow;
  hideAgentNames: boolean;
}): ReactElement {
  const { agent } = row;
  // Dormant rows derive their timestamp from the agent's real last activity
  // (newest MC event) instead of the directory's rollout/boot fallback, so
  // each dormant row reads when it last did anything (live bug: every Dormant
  // row showed the same relative time).
  const activityTime = useMemo(() => new Date(rowActivityMs(row)), [row]);
  const timeLabel = useCompactTimeAgo(activityTime);
  const { Icon, mapping } = rowIconAndColor(row);
  const toast = useToast();
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [rowHovered, setRowHovered] = useState(false);
  const rowTriggerRef = useRef<View | null>(null);
  const rowPopoverRef = useRef<View | null>(null);

  const handleRowPointerEnter = useCallback(() => setRowHovered(true), []);
  const handleRowPointerLeave = useCallback(() => setRowHovered(false), []);
  const handleRowSafeZoneEnter = useCallback(() => setRowHovered(true), []);
  const handleRowSafeZoneLeave = useCallback(() => setRowHovered(false), []);
  useHoverSafeZone({
    enabled: rowHovered,
    triggerRef: rowTriggerRef,
    contentRef: rowPopoverRef,
    onEnterSafeZone: handleRowSafeZoneEnter,
    onLeaveSafeZone: handleRowSafeZoneLeave,
  });

  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
  }, []);

  const handlePress = useCallback(() => {
    useInspectorStore.getState().openInspectorAgent({
      serverId: agent.serverId,
      agentId: agent.id,
    });
  }, [agent.id, agent.serverId]);

  const handleOpenInWorkspace = useCallback(() => {
    void openAgentFromHistory({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: Boolean(agent.archivedAt),
    });
  }, [agent]);

  const handleCopyReference = useCallback(() => {
    void copyToClipboard(buildAgentReference(agent))
      .then(() => toast.copied("Reference copied"))
      .catch(() => toast.error("Unable to copy reference"));
  }, [agent, toast]);

  const handleStop = useCallback(() => {
    const client = getHostRuntimeStore().getClient(agent.serverId);
    if (!client) {
      return;
    }
    void client.cancelAgent(agent.id).catch(() => {
      // A failed cancel leaves the run going; the next push reconciles.
    });
  }, [agent.id, agent.serverId]);

  const handleMarkDone = useCallback(() => {
    void setAgentLifecycle(agent.serverId, agent.id, "done").catch(() => {
      // Bookkeeping action; a failed mark leaves the row in Ready.
    });
  }, [agent.id, agent.serverId]);

  const handleClear = useCallback(() => {
    void clearAgentLifecycle(agent.serverId, agent.id).catch(() => {
      // Bookkeeping action; a failed clear leaves the row in Done.
    });
  }, [agent.id, agent.serverId]);

  const handleArchive = useCallback(() => {
    void archiveAgent({ serverId: agent.serverId, agentId: agent.id }).catch(() => {
      // The daemon still processes the archive; the row disappears on push.
    });
  }, [agent.id, agent.serverId, archiveAgent]);

  const keyLine = agent.title ?? agent.name ?? agent.id;
  const showNameChip = agent.name !== null && agent.name !== keyLine && !hideAgentNames;
  const isDone = row.bucket === "done";
  const bucketLabel = LIFECYCLE_BUCKET_LABELS[row.bucket];
  // On done rows the verdict line already carries the summary; a headline that
  // is literally the same text (user "Marked done"/"Cleared" cards) would read
  // as a duplicated line.
  const headline =
    row.lastReportHeadline !== null &&
    isDone &&
    row.verdict !== null &&
    row.lastReportHeadline === row.verdict.summary
      ? null
      : row.lastReportHeadline;

  const menuActions = resolveBoardRowMenuActions(row);
  const isArchiving = isArchivingAgent({ serverId: agent.serverId, agentId: agent.id });

  return (
    <View
      ref={rowTriggerRef}
      style={styles.rowHoverEnvelope}
      onPointerEnter={handleRowPointerEnter}
      onPointerLeave={handleRowPointerLeave}
    >
      <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
        <ContextMenuTrigger
          onPress={handlePress}
          accessibilityRole="button"
          accessibilityLabel={`${keyLine}, ${bucketLabel}`}
          style={agentRowStyle}
          testID={`mission-control-row-${agent.id}`}
        >
          <>
            <Icon size={12} uniProps={mapping} />
            <HostGlyph serverId={agent.serverId} label={agent.serverLabel} size="sm" />
            <AgentRowTextContent
              row={row}
              keyLine={keyLine}
              showNameChip={showNameChip}
              headline={headline}
            />
            {timeLabel ? <Text style={styles.rowTime}>{timeLabel}</Text> : null}
            {isDone ? (
              <Button
                variant="ghost"
                size="xs"
                onPress={handleClear}
                testID={`mission-control-clear-agent-${agent.id}`}
              >
                Clear
              </Button>
            ) : null}
          </>
        </ContextMenuTrigger>
        <AgentRowMenuContent
          agentId={agent.id}
          menuActions={menuActions}
          isArchiving={isArchiving}
          onOpenInWorkspace={handleOpenInWorkspace}
          onCopyReference={handleCopyReference}
          onStop={handleStop}
          onMarkDone={handleMarkDone}
          onClear={handleClear}
          onArchive={handleArchive}
        />
      </ContextMenu>
      {rowHovered ? (
        <AgentRowIdentityPopover
          rowTriggerRef={rowTriggerRef}
          rowPopoverRef={rowPopoverRef}
          title={agent.title}
          description={agent.shortDescription ?? headline}
        />
      ) : null}
    </View>
  );
}

const agentRowStyle = ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
  styles.agentRow,
  hovered && styles.agentRowHovered,
];

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toggleLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  bucketHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[2],
  },
  bucketHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    userSelect: "none",
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
  },
  // Hover envelope (docs/hover.md): plain View tracks pointer, the
  // ContextMenuTrigger inside owns press. The identity popover portals out of
  // this envelope (it can't paint above later siblings from inside the list),
  // so the envelope only anchors the hover region.
  rowHoverEnvelope: {
    position: "relative",
  },
  // Full-screen portal overlay in the shared overlay-root. The popover floats
  // at the tooltip layer — above adjacent rows, dropdown menus, and modals.
  identityPopoverOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: OVERLAY_Z.tooltip,
  },
  identityPopoverModalOverlay: {
    flex: 1,
  },
  // Content styling only — position/width live in the FloatingSurface
  // frameStyle (measured, row-relative).
  identityPopover: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  identityPopoverTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  identityPopoverDescription: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  agentRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  agentText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  agentTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  agentMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
  },
  nameChip: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  nameChipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  stoppedChip: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  stoppedChipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDotWarning,
  },
  agentHeadline: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  verdictLine: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  rowTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  emptyState: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[4],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  offlineHostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  offlineHostState: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
}));
