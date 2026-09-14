import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUpRight, CircleCheck, CircleDot } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HostGlyph } from "@/components/host-glyph";
import { LiveElapsed } from "@/components/message";
import { useWorkspaceOpenState } from "@/mission-control/workspace-open-state";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { EmbeddedAgentPane } from "@/screens/mission-control/embedded-agent-pane";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import type { AgentGridItem, AgentGridSection } from "./items";
import { resolveAgentGridZoom } from "./font-size";

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);

// Same bucket colours the board's row glyphs use: running blue, ready green.
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });

// Hoisted so the chip never takes a fresh JSX element as a prop
// (react-perf: no JSX literals in prop position).
const RUNNING_CHIP_ICON = <ThemedCircleDot size={12} uniProps={runningColorMapping} />;
const READY_CHIP_ICON = <ThemedCircleCheck size={12} uniProps={successColorMapping} />;

const SECTION_LABELS: Record<AgentGridSection, string> = {
  running: "Running",
  ready: "Ready for review",
};

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

function OpenInWorkspaceButton({ row }: { row: LifecycleRow }): ReactElement {
  const { agent } = row;
  const { isArchivedOrMissing } = useWorkspaceOpenState(agent.serverId, agent.workspaceId);
  const handlePress = useCallback(() => {
    void openAgentFromHistory({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: Boolean(agent.archivedAt),
    });
  }, [agent.archivedAt, agent.id, agent.serverId, agent.workspaceId]);

  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View collapsable={false}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={ThemedArrowUpRight}
            onPress={handlePress}
            disabled={isArchivedOrMissing}
            accessibilityLabel="Open in workspace"
            testID={`mission-control-agent-grid-open-${agent.id}`}
          />
        </View>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" offset={8}>
        <Text style={styles.tooltipText}>Open in workspace</Text>
      </TooltipContent>
    </Tooltip>
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

function TileHeader({
  item,
  onActivate,
}: {
  item: AgentGridItem;
  onActivate?: () => void;
}): ReactElement {
  const { row, section } = item;
  const { agent } = row;
  const primaryLabel = agent.name ?? agent.title ?? agent.id;
  const secondaryLabel = agent.name && agent.title ? agent.title : null;
  // Same source as the agent window's turn footer, so both timers agree.
  const runStartedAt = agent.turn.phase === "open" ? agent.turn.startedAt : null;

  return (
    <View style={styles.header}>
      <Pressable
        onPress={onActivate}
        disabled={!onActivate}
        style={styles.headerCluster}
        accessibilityRole="button"
        accessibilityLabel={`Select ${primaryLabel}`}
        testID={onActivate ? `mission-control-agent-grid-activate-${agent.id}` : undefined}
      >
        <View style={styles.identity}>
          <Text style={styles.name} numberOfLines={1}>
            {primaryLabel}
          </Text>
          {secondaryLabel ? (
            <Text style={styles.title} numberOfLines={1}>
              {secondaryLabel}
            </Text>
          ) : null}
        </View>
        <HostGlyph serverId={agent.serverId} label={agent.serverLabel} size="sm" />
        <StatusBadge
          label={SECTION_LABELS[section]}
          leading={section === "running" ? RUNNING_CHIP_ICON : READY_CHIP_ICON}
          testID={`mission-control-agent-grid-tile-section-${agent.id}`}
        />
        {runStartedAt ? (
          <LiveElapsed
            startedAt={runStartedAt}
            style={styles.elapsed}
            testID={`mission-control-agent-grid-elapsed-${agent.id}`}
          />
        ) : null}
      </Pressable>
      <View style={styles.headerAction}>
        <OpenInWorkspaceButton row={row} />
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
}

/**
 * One agent in the grid. Default chrome is monitor-only: opaque identity
 * strip + live stream. Clicking the tile toggles that agent's composer;
 * the transcript stays scrollable without that click. Expanding (open in
 * workspace) restores the full agent pane.
 */
export const AgentGridTile = memo(function AgentGridTile({
  item,
  isFocused,
  isActive,
  onActivate,
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
      if (isComposerField(event.target)) {
        return;
      }
      handleToggle();
    },
    [handleToggle],
  );

  return (
    <View style={[styles.tile, frameStyle]} testID={`mission-control-agent-grid-tile-${agentId}`}>
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
      </View>
    </View>
  );
});

export interface AgentGridTilePlaceholderProps extends TileFrame {
  item: AgentGridItem;
}

/** A tile outside the mount window: same identity chrome and size, no stream. */
export const AgentGridTilePlaceholder = memo(function AgentGridTilePlaceholder({
  item,
  width,
  height,
  x,
  y,
}: AgentGridTilePlaceholderProps): ReactElement {
  const frameStyle = useTileFrameStyle({ width, height, x, y });
  return (
    <View
      style={[styles.tile, frameStyle]}
      testID={`mission-control-agent-grid-tile-placeholder-${item.row.agent.id}`}
    >
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
