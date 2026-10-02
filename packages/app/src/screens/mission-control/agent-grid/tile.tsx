import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  CircleCheck,
  Copy,
  ExternalLink,
  Maximize2,
  Plus,
  Square,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HostGlyph } from "@/components/host-glyph";
import { LiveElapsed } from "@/components/message";
import { useToast } from "@/contexts/toast-context";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { setAgentLifecycle } from "@/mission-control/lifecycle-set";
import { buildAgentReference, resolveBoardRowMenuActions } from "@/mission-control/row-menu";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { focusWithRetries } from "@/utils/web-focus";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { EmbeddedAgentPane } from "@/screens/mission-control/embedded-agent-pane";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import type { AgentGridItem } from "./items";
import { useAgentGridStore } from "./store";
import { TileStatus } from "./tile-status";
import { useLastUserMessage } from "./last-user-message";
import { TilePills } from "./tile-pills";
import { AgentGridTileGlow } from "./grid-glow";

const ThemedArchive = withUnistyles(Archive);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedPlus = withUnistyles(Plus);
const ThemedSquare = withUnistyles(Square);

const menuIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const headerActionIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_OPEN_ICON = <ThemedExternalLink size={14} uniProps={menuIconMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={14} uniProps={menuIconMapping} />;
const MENU_STOP_ICON = <ThemedSquare size={14} uniProps={menuIconMapping} />;
const MENU_CIRCLE_CHECK_ICON = <ThemedCircleCheck size={14} uniProps={menuIconMapping} />;
const MENU_ARCHIVE_ICON = <ThemedArchive size={14} uniProps={menuIconMapping} />;
const MENU_PLUS_ICON = <ThemedPlus size={14} uniProps={menuIconMapping} />;

export type GridMenuAction =
  | "open"
  | "mark-done"
  | "stop"
  | "copy-agent-id"
  | "copy-reference"
  | "spin-in-workspace"
  | "archive"
  | "clear";

export function resolveGridMenuActions(row: LifecycleRow): GridMenuAction[] {
  const baseActions = resolveBoardRowMenuActions(row);
  const actions: GridMenuAction[] = [];

  if (baseActions.includes("mark-done")) {
    actions.push("mark-done");
  }
  if (baseActions.includes("open")) {
    actions.push("open");
  }
  actions.push("spin-in-workspace");
  if (baseActions.includes("stop")) {
    actions.push("stop");
  }
  if (baseActions.includes("copy-reference")) {
    actions.push("copy-reference");
  }
  actions.push("copy-agent-id");
  if (baseActions.includes("clear")) {
    actions.push("clear");
  }
  if (baseActions.includes("archive")) {
    actions.push("archive");
  }
  return actions;
}

interface TileFrame {
  width: number;
  height: number;
  x: number;
  y: number;
}

function useTileFrameStyle({ width, height, x, y }: TileFrame) {
  // Measured geometry churns on every resize; keep it out of the CSS registry.
  return useMemo(
    () => inlineUnistylesStyle({ left: x, top: y, width, height }),
    [height, width, x, y],
  );
}

function isComposerField(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object" || !("closest" in target)) {
    return false;
  }
  const node = target as { closest: (selector: string) => unknown };
  if (typeof node.closest !== "function") {
    return false;
  }
  return Boolean(node.closest("textarea, input, [contenteditable='true']"));
}

function isInteractiveOrSelection(target: EventTarget | null | undefined): boolean {
  if (isComposerField(target)) {
    return true;
  }
  if (isWeb && typeof window !== "undefined") {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      return true;
    }
  }
  if (!target || typeof target !== "object" || !("closest" in target)) {
    return false;
  }
  const node = target as { closest: (selector: string) => unknown };
  if (typeof node.closest !== "function") {
    return false;
  }
  return Boolean(node.closest("button, a, [role='button']"));
}

function TileContextMenu({ item }: { item: AgentGridItem }): ReactElement {
  const { row } = item;
  const { agent } = row;
  const { t } = useTranslation();
  const toast = useToast();
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  const menuActions = useMemo(() => resolveGridMenuActions(row), [row]);
  const isArchiving = isArchivingAgent({ serverId: agent.serverId, agentId: agent.id });

  const handleOpen = useCallback(() => {
    const store = useAgentGridStore.getState();
    if ("setNavigatedFromGrid" in store && typeof store.setNavigatedFromGrid === "function") {
      store.setNavigatedFromGrid({ serverId: agent.serverId, agentId: agent.id });
    }
    void openAgentFromHistory({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: Boolean(agent.archivedAt),
    });
  }, [agent.archivedAt, agent.id, agent.serverId, agent.workspaceId]);

  const handleMarkDone = useCallback(() => {
    void setAgentLifecycle(agent.serverId, agent.id, "done").catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleStop = useCallback(() => {
    const client = getHostRuntimeStore().getClient(agent.serverId);
    if (!client) {
      return;
    }
    void client.cancelAgent(agent.id).catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleCopyAgentId = useCallback(() => {
    void copyToClipboard(agent.id)
      .then(() => toast.copied("Agent ID copied"))
      .catch(() => toast.error("Unable to copy agent ID"));
  }, [agent.id, toast]);

  const handleCopyReference = useCallback(() => {
    void copyToClipboard(buildAgentReference(agent))
      .then(() => toast.copied("Reference copied"))
      .catch(() => toast.error("Unable to copy reference"));
  }, [agent, toast]);

  const handleSpinInWorkspace = useCallback(() => {
    const store = useAgentGridStore.getState();
    if ("setDraft" in store && typeof store.setDraft === "function") {
      store.setDraft({
        id: `draft-${Date.now()}`,
        serverId: agent.serverId ?? null,
        workspaceId: agent.workspaceId ?? null,
        projectKey: agent.projectPlacement?.projectKey ?? null,
      });
    }
  }, [agent.projectPlacement?.projectKey, agent.serverId, agent.workspaceId]);

  const handleClear = useCallback(() => {
    void setAgentLifecycle(agent.serverId, agent.id, "clear").catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleArchive = useCallback(() => {
    void archiveAgent({ serverId: agent.serverId, agentId: agent.id }).catch(() => {});
  }, [agent.id, agent.serverId, archiveAgent]);

  return (
    <ContextMenuContent
      align="start"
      minWidth={180}
      testID={`mission-control-agent-grid-menu-${agent.id}`}
    >
      {menuActions.map((action) => {
        switch (action) {
          case "open":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_OPEN_ICON}
                onSelect={handleOpen}
                testID={`mission-control-agent-grid-menu-${agent.id}-open`}
              >
                {t("sidebar.agentView.menu.open", "Open in workspace")}
              </ContextMenuItem>
            );
          case "mark-done":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_CIRCLE_CHECK_ICON}
                onSelect={handleMarkDone}
                testID={`mission-control-agent-grid-menu-${agent.id}-mark-done`}
              >
                {t("workspace.tabs.menu.markDone", "Mark done")}
              </ContextMenuItem>
            );
          case "stop":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_STOP_ICON}
                onSelect={handleStop}
                testID={`mission-control-agent-grid-menu-${agent.id}-stop`}
              >
                {t("sidebar.agentView.menu.stop", "Stop")}
              </ContextMenuItem>
            );
          case "copy-agent-id":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_COPY_ICON}
                onSelect={handleCopyAgentId}
                testID={`mission-control-agent-grid-menu-${agent.id}-copy-agent-id`}
              >
                {t("workspace.tabs.menu.copyAgentId", "Copy agent id")}
              </ContextMenuItem>
            );
          case "copy-reference":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_COPY_ICON}
                onSelect={handleCopyReference}
                testID={`mission-control-agent-grid-menu-${agent.id}-copy-reference`}
              >
                {t("sidebar.agentView.menu.copyReference", "Copy reference")}
              </ContextMenuItem>
            );
          case "spin-in-workspace":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_PLUS_ICON}
                onSelect={handleSpinInWorkspace}
                testID={`mission-control-agent-grid-menu-${agent.id}-spin-in-workspace`}
              >
                {t("missionControl.agentGrid.menu.spinInWorkspace", "New agent here")}
              </ContextMenuItem>
            );
          case "archive":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_ARCHIVE_ICON}
                onSelect={handleArchive}
                status={isArchiving ? "pending" : undefined}
                testID={`mission-control-agent-grid-menu-${agent.id}-archive`}
              >
                {t("sidebar.agentView.menu.archive", "Archive")}
              </ContextMenuItem>
            );
          case "clear":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_CIRCLE_CHECK_ICON}
                onSelect={handleClear}
                testID={`mission-control-agent-grid-menu-${agent.id}-clear`}
              >
                {t("sidebar.agentView.menu.clear", "Clear")}
              </ContextMenuItem>
            );
        }
      })}
    </ContextMenuContent>
  );
}

function TileHeader({
  item,
  onShowComposer,
}: {
  item: AgentGridItem;
  onShowComposer?: () => void;
}) {
  const { row } = item;
  const { agent } = row;
  // STE: Identity layout: primary title is project name (fallback agent title or id);
  // subtitle is agent title (when project name is primary). Agent name is dropped entirely.
  const projectName = agent.projectPlacement?.projectName;
  const primaryTitle = projectName || agent.title || agent.id;
  const subtitle = projectName && agent.title ? agent.title : null;
  const lastUserMessage = useLastUserMessage(agent.serverId, agent.id);
  const tooltipText = lastUserMessage || agent.title || primaryTitle;

  // Same source as the agent window's turn footer, so both timers agree.
  const runStartedAt = agent.turn.phase === "open" ? agent.turn.startedAt : null;

  const handleHeaderClick = useCallback(() => {
    // STE: Header click reveals the composer; maximize button expands.
    onShowComposer?.();
  }, [onShowComposer]);

  const handleOpenWorkspace = useCallback(() => {
    const store = useAgentGridStore.getState();
    if ("setNavigatedFromGrid" in store && typeof store.setNavigatedFromGrid === "function") {
      store.setNavigatedFromGrid({ serverId: agent.serverId, agentId: agent.id });
    }
    void openAgentFromHistory({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: Boolean(agent.archivedAt),
    });
  }, [agent.archivedAt, agent.id, agent.serverId, agent.workspaceId]);

  return (
    <View style={styles.header}>
      <Pressable
        onPress={handleHeaderClick}
        style={styles.headerCluster}
        accessibilityRole="button"
        accessibilityLabel={`Open ${primaryTitle} in workspace`}
        testID={`mission-control-agent-grid-header-${agent.id}`}
      >
        <TileStatus item={item} />
        <HostGlyph serverId={agent.serverId} label={agent.serverLabel} size="sm" />
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <View
              style={styles.identity}
              collapsable={false}
              accessibilityLabel={tooltipText}
              testID={`mission-control-agent-grid-lastmsg-${agent.id}`}
              {...({ title: tooltipText } as object)}
            >
              <Text
                style={styles.name}
                numberOfLines={1}
                testID={`mission-control-agent-grid-project-${agent.id}`}
              >
                {primaryTitle}
              </Text>
              {subtitle ? (
                <Text style={styles.title} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            offset={8}
            testID={`mission-control-agent-grid-lastmsg-${agent.id}-content`}
          >
            <Text
              style={styles.tooltipText}
              testID={`mission-control-agent-grid-lastmsg-${agent.id}-text`}
            >
              {tooltipText}
            </Text>
          </TooltipContent>
        </Tooltip>
        {runStartedAt ? (
          <LiveElapsed
            startedAt={runStartedAt}
            style={styles.elapsed}
            testID={`mission-control-agent-grid-elapsed-${agent.id}`}
          />
        ) : null}
      </Pressable>
      <View style={styles.headerAction}>
        <Pressable
          onPress={handleOpenWorkspace}
          style={styles.activateButton}
          accessibilityRole="button"
          accessibilityLabel={`Open ${primaryTitle} in workspace`}
          testID={`mission-control-agent-grid-expand-${agent.id}`}
          {...({
            "data-testid": `mission-control-agent-grid-expand-${agent.id}`,
            "data-test-alias": `mission-control-agent-grid-activate-${agent.id}`,
          } as object)}
        >
          <View testID={`mission-control-agent-grid-activate-${agent.id}`} collapsable={false}>
            <ThemedMaximize2 size={13} uniProps={headerActionIconMapping} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

export interface AgentGridTileProps extends TileFrame {
  item: AgentGridItem;
  /** Owning screen is visible/focused. */
  isFocused: boolean;
  /** This tile is the one the user last clicked; it is the only tile with a composer. */
  isActive: boolean;
  onActivate: (key: string | null) => void;
  /** Inner border glow indicator on navigation/focus. */
  glow?: boolean;
}

/**
 * One agent in the grid.
 * - Header: Status indicator, host glyph, project name, agent name/title (hover tooltip shows last message), live elapsed.
 * - Clicking header opens workspace via openAgentFromHistory and setNavigatedFromGrid.
 * - Clicking body (or activate button) toggles composer.
 * - Right-click context menu offers agent lifecycle and copy actions.
 * - Pills strip floats above the composer for subagent tracking, diffs, and asks.
 */
export const AgentGridTile = memo(function AgentGridTile({
  item,
  isFocused,
  isActive,
  onActivate,
  glow = false,
  width,
  height,
  x,
  y,
}: AgentGridTileProps): ReactElement {
  const { serverId, id: agentId } = item.row.agent;
  const { settings } = useAppSettings();
  const frameStyle = useTileFrameStyle({ width, height, x, y });
  const tileRef = useRef<View>(null);
  const hoverComposerEnabled = settings.agentGridHoverComposer === true;
  const [isHovered, setIsHovered] = useState(false);
  const [isScrollDismissed, setIsScrollDismissed] = useState(false);
  const isScrollDismissedRef = useRef(false);
  const lastComposerToggleRef = useRef(0);
  const dismissTimerRef = useRef<number | NodeJS.Timeout | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);

  // STE: Click (header, body, or chat area) shows the composer. Hover shows
  // it only when the Appearance setting enables hover composer.
  const shouldShowComposer =
    (isActive || (hoverComposerEnabled && isHovered)) && !isScrollDismissed;

  // STE: Stamp every composer show/hide so scroll handlers ignore the
  // layout-settle window that follows a toggle.
  useEffect(() => {
    lastComposerToggleRef.current = Date.now();
    isScrollDismissedRef.current = isScrollDismissed;
  }, [shouldShowComposer, isScrollDismissed]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    // STE: Re-hover restores composer if previously dismissed by scrolling up.
    if (hoverComposerEnabled) setIsScrollDismissed(false);
  }, [hoverComposerEnabled]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  const handleComposerFocus = useCallback(() => onActivate(item.key), [item.key, onActivate]);
  const handleShowComposer = useCallback(() => onActivate(item.key), [item.key, onActivate]);
  const handleBodyClick = useCallback(
    (event: { target?: EventTarget | null }) => {
      if (isInteractiveOrSelection(event.target)) {
        return;
      }
      onActivate(item.key);
    },
    [item.key, onActivate],
  );

  // STE: Composer reveal focuses the textarea with cursor at end of text.
  useEffect(() => {
    if (shouldShowComposer && isWeb) {
      const cancel = focusWithRetries({
        focus: () => {
          const root = tileRef.current as unknown as HTMLElement | null;
          const textarea = root?.querySelector?.("textarea[data-composer-input], textarea");
          if (textarea instanceof HTMLTextAreaElement) {
            // STE: Never let auto-focus yank the transcript scroll position.
            textarea.focus({ preventScroll: true });
            const end = textarea.value.length;
            textarea.setSelectionRange(end, end);
          }
        },
        isFocused: () => {
          const root = tileRef.current as unknown as HTMLElement | null;
          const textarea = root?.querySelector?.("textarea[data-composer-input], textarea");
          return textarea != null && document.activeElement === textarea;
        },
        timeoutMs: 800,
      });
      return cancel;
    }
  }, [shouldShowComposer]);

  // STE: Transcript scroll-up dismisses composer to read state; scroll to
  // bottom or re-hover restores. Dismiss is debounced and scroll events from
  // the composer mount/unmount layout shift are ignored, so slow scrolling
  // near the threshold cannot oscillate the composer. Unfocused wheel kept.
  useEffect(() => {
    if (!isWeb) return;
    const root = tileRef.current as unknown as HTMLElement | null;
    if (!root) return;

    const SCROLL_DISMISS_THRESHOLD_PX = 72;
    const AT_BOTTOM_THRESHOLD_PX = 12;
    const DISMISS_DEBOUNCE_MS = 120;
    const LAYOUT_SETTLE_MS = 350;

    const cancelPendingDismiss = () => {
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };

    const handleScroll = (event: Event) => {
      // STE: Layout shift from showing/hiding the composer moves scroll
      // metrics; ignore events until the layout settles to avoid toggle loop.
      if (Date.now() - lastComposerToggleRef.current < LAYOUT_SETTLE_MS) return;
      const target = event.target as HTMLElement | null;
      if (!target || target === root) return;
      if (target.scrollHeight <= target.clientHeight + 1) return;

      // STE: Upward (reading) motion dismisses; reaching the bottom edge or
      // moving downward restores. Downward motion never hides.
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = target.scrollTop;

      const distanceFromBottom = target.scrollHeight - target.clientHeight - target.scrollTop;
      if (distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX) {
        cancelPendingDismiss();
        if (isScrollDismissedRef.current) setIsScrollDismissed(false);
        return;
      }
      if (prevTop !== null && target.scrollTop >= prevTop) return;
      if (distanceFromBottom > SCROLL_DISMISS_THRESHOLD_PX) {
        if (!isScrollDismissedRef.current && dismissTimerRef.current === null) {
          dismissTimerRef.current = setTimeout(() => {
            dismissTimerRef.current = null;
            setIsScrollDismissed(true);
          }, DISMISS_DEBOUNCE_MS);
        }
      } else {
        cancelPendingDismiss();
      }
    };

    root.addEventListener("scroll", handleScroll, { capture: true, passive: true });

    return () => {
      root.removeEventListener("scroll", handleScroll, { capture: true });
      cancelPendingDismiss();
    };
  }, []);

  const beforeComposer = useMemo(
    () => (
      <TilePills
        serverId={serverId}
        agentId={agentId}
        workspaceId={item.row.agent.workspaceId}
        showComposer={shouldShowComposer}
        isActive={isActive}
      />
    ),
    [agentId, isActive, item.row.agent.workspaceId, serverId, shouldShowComposer],
  );

  return (
    <View
      ref={tileRef}
      style={[styles.tile, frameStyle, glow ? styles.tileGlow : null]}
      testID={`mission-control-agent-grid-tile-${agentId}`}
      {...({
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        onPointerEnter: handleMouseEnter,
        onPointerLeave: handleMouseLeave,
        "data-glow": glow ? "true" : undefined,
        "data-composer-auto": shouldShowComposer ? "true" : undefined,
        dataSet: {
          glow: glow ? "true" : undefined,
          composerAuto: shouldShowComposer ? "true" : undefined,
        },
      } as object)}
    >
      <AgentGridTileGlow glow={glow} agentId={agentId} />
      <ContextMenu>
        <ContextMenuTrigger contextOnly style={styles.contextTrigger}>
          <TileHeader item={item} onShowComposer={handleShowComposer} />
          <View
            style={styles.body}
            // RN-web: click bubbles from the stream; wheel still hits the list.
            {...({ onClick: handleBodyClick } as object)}
          >
            <View
              style={styles.streamFrame}
              {...({
                dataSet: { agentGridFontSize: String(settings.agentGridFontSize) },
              } as object)}
            >
              <EmbeddedAgentPane
                serverId={serverId}
                agentId={agentId}
                isFocused={isFocused && (isActive || isHovered)}
                viewedTimelineSourceId={`mission-control-agent-grid:${serverId}:${agentId}`}
                reportsFocusedAgent={isActive}
                chrome="compact"
                showComposer={shouldShowComposer}
                submitButtonTestID={`mission-control-agent-grid-composer-submit-${agentId}`}
                onComposerFocus={handleComposerFocus}
                beforeComposer={beforeComposer}
                timelineSyncDebounceMs={isActive ? 0 : 150}
              />
            </View>
            {shouldShowComposer ? (
              <View
                testID="mission-control-agent-grid-composer-auto"
                collapsable={false}
                pointerEvents="none"
                style={styles.composerAutoIndicator}
              />
            ) : null}
          </View>
        </ContextMenuTrigger>
        <TileContextMenu item={item} />
      </ContextMenu>
    </View>
  );
});

export interface AgentGridTilePlaceholderProps extends TileFrame {
  item: AgentGridItem;
  glow?: boolean;
}

/** A tile outside the mount window: same identity chrome and size, no stream. */
export const AgentGridTilePlaceholder = memo(function AgentGridTilePlaceholder({
  item,
  glow = false,
  width,
  height,
  x,
  y,
}: AgentGridTilePlaceholderProps): ReactElement {
  const frameStyle = useTileFrameStyle({ width, height, x, y });
  return (
    <View
      style={[styles.tile, frameStyle, glow ? styles.tileGlow : null]}
      testID={`mission-control-agent-grid-tile-placeholder-${item.row.agent.id}`}
      {...({
        "data-glow": glow ? "true" : undefined,
        dataSet: { glow: glow ? "true" : undefined },
      } as object)}
    >
      <AgentGridTileGlow glow={glow} agentId={item.row.agent.id} />
      <TileHeader item={item} />
      <View style={styles.placeholderBody}>
        <Text style={styles.placeholderHint}>Scroll to view</Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  tile: {
    position: "absolute",
    overflow: "hidden",
    flexDirection: "column",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  tileGlow: {
    borderColor: theme.colors.accent,
    boxShadow: `inset 0 0 0 1px ${theme.colors.accent}, 0 0 12px ${theme.colors.accent}40`,
  },
  contextTrigger: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    height: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    zIndex: 2,
    overflow: "hidden",
  },
  headerCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  headerAction: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  activateButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  projectName: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    maxWidth: 120,
  },
  identity: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  elapsed: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  body: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  streamFrame: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  placeholderBody: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderHint: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  composerAutoIndicator: {
    position: "absolute",
    width: 0,
    height: 0,
    opacity: 0,
  },
}));
