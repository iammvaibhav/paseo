import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  CircleCheck,
  Copy,
  ExternalLink,
  MessageSquare,
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
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { EmbeddedAgentPane } from "@/screens/mission-control/embedded-agent-pane";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import type { AgentGridItem } from "./items";
import { resolveAgentGridZoom } from "./font-size";
import { useAgentGridStore } from "./store";
import { TileStatus } from "./tile-status";
import { useLastUserMessage } from "./last-user-message";
import { TilePills } from "./tile-pills";
import { AgentGridTileGlow } from "./grid-glow";

const ThemedArchive = withUnistyles(Archive);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedMessageSquare = withUnistyles(MessageSquare);
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
  onActivate,
}: {
  item: AgentGridItem;
  onActivate?: () => void;
}): ReactElement {
  const { row } = item;
  const { agent } = row;
  const primaryLabel = agent.name ?? agent.title ?? agent.id;
  const secondaryLabel = agent.name && agent.title ? agent.title : null;
  const projectName = agent.projectPlacement?.projectName;
  const lastUserMessage = useLastUserMessage(agent.serverId, agent.id);
  const tooltipText = lastUserMessage || agent.title || primaryLabel;

  // Same source as the agent window's turn footer, so both timers agree.
  const runStartedAt = agent.turn.phase === "open" ? agent.turn.startedAt : null;

  const handleOpenWorkspace = useCallback(() => {
    const store = useAgentGridStore.getState();
    if ("setNavigatedFromGrid" in store && typeof store.setNavigatedFromGrid === "function") {
      store.setNavigatedFromGrid({
        serverId: agent.serverId,
        agentId: agent.id,
      });
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
        onPress={handleOpenWorkspace}
        style={styles.headerCluster}
        accessibilityRole="button"
        accessibilityLabel={`Open ${primaryLabel} in workspace`}
        testID={`mission-control-agent-grid-header-${agent.id}`}
      >
        <TileStatus item={item} />
        <HostGlyph serverId={agent.serverId} label={agent.serverLabel} size="sm" />
        {projectName ? (
          <Text
            style={styles.projectName}
            numberOfLines={1}
            testID={`mission-control-agent-grid-project-${agent.id}`}
          >
            {projectName}
          </Text>
        ) : null}
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <View
              style={styles.identity}
              collapsable={false}
              accessibilityLabel={tooltipText}
              testID={`mission-control-agent-grid-lastmsg-${agent.id}`}
              {...({ title: tooltipText } as object)}
            >
              <Text style={styles.name} numberOfLines={1}>
                {primaryLabel}
              </Text>
              {secondaryLabel ? (
                <Text style={styles.title} numberOfLines={1}>
                  {secondaryLabel}
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
      {onActivate ? (
        <View style={styles.headerAction}>
          <Pressable
            onPress={onActivate}
            style={styles.activateButton}
            accessibilityRole="button"
            accessibilityLabel={`Toggle composer for ${primaryLabel}`}
            testID={`mission-control-agent-grid-activate-${agent.id}`}
          >
            <ThemedMessageSquare size={13} uniProps={headerActionIconMapping} />
          </Pressable>
        </View>
      ) : null}
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
  const contentZoom = resolveAgentGridZoom(settings.agentGridFontSize, settings.contentFontSize);
  const handleToggle = useCallback(() => {
    onActivate(isActive ? null : item.key);
  }, [isActive, item.key, onActivate]);
  const handleComposerFocus = useCallback(() => onActivate(item.key), [item.key, onActivate]);
  const handleBodyClick = useCallback(
    (event: { target?: EventTarget | null }) => {
      if (isInteractiveOrSelection(event.target)) {
        return;
      }
      handleToggle();
    },
    [handleToggle],
  );

  return (
    <View
      style={[styles.tile, frameStyle, glow ? styles.tileGlow : null]}
      testID={`mission-control-agent-grid-tile-${agentId}`}
      {...({
        "data-glow": glow ? "true" : undefined,
        dataSet: { glow: glow ? "true" : undefined },
      } as object)}
    >
      <AgentGridTileGlow glow={glow} agentId={agentId} />
      <ContextMenu>
        <ContextMenuTrigger contextOnly style={styles.contextTrigger}>
          <TileHeader item={item} onActivate={handleToggle} />
          <View
            style={styles.body}
            // RN-web: click bubbles from the stream; wheel still hits the list.
            {...({ onClick: handleBodyClick } as object)}
          >
            <View
              style={[styles.body, isWeb ? ({ zoom: contentZoom } as object) : null]}
              testID="mission-control-agent-grid-content-scale"
              {...({
                dataSet: { agentGridFontSize: String(settings.agentGridFontSize) },
              } as object)}
            >
              <EmbeddedAgentPane
                serverId={serverId}
                agentId={agentId}
                isFocused={isFocused && isActive}
                viewedTimelineSourceId={`mission-control-agent-grid:${serverId}:${agentId}`}
                reportsFocusedAgent={isActive}
                chrome="compact"
                showComposer={isActive}
                submitButtonTestID={`mission-control-agent-grid-composer-submit-${agentId}`}
                onComposerFocus={handleComposerFocus}
              />
            </View>
            <TilePills
              serverId={serverId}
              agentId={agentId}
              workspaceId={item.row.agent.workspaceId}
              isActive={isActive}
            />
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
}));
