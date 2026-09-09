import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
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
import type { AgentGridItem, AgentGridSection } from "./items";

const TILE_HEADER_MIN_HEIGHT = 40;

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

  // Icon-only: the tile header is dense chrome; the label lives in the
  // accessible name and the tooltip. Disabled when the workspace would
  // dead-end (archived or no longer listed on the host).
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

function TileHeader({ item }: { item: AgentGridItem }): ReactElement {
  const { row, section } = item;
  const { agent } = row;
  const primaryLabel = agent.name ?? agent.title ?? agent.id;
  const secondaryLabel = agent.name && agent.title ? agent.title : null;
  // Same source as the agent window's turn footer, so both timers agree.
  const runStartedAt = agent.turn.phase === "open" ? agent.turn.startedAt : null;

  return (
    <View style={styles.header}>
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
      <OpenInWorkspaceButton row={row} />
    </View>
  );
}

export interface AgentGridTileProps extends TileFrame {
  item: AgentGridItem;
  /** Owning screen is visible/focused. */
  isFocused: boolean;
  /** This tile owns the composer the user last focused. */
  isActive: boolean;
  onActivate: (key: string) => void;
}

/**
 * One agent in the grid: identity header plus the same live stream and
 * composer the inspector shows. Only the active tile's composer takes the
 * pane-focus role, so keyboard actions and presence target one agent.
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
  const frameStyle = useTileFrameStyle({ width, height, x, y });
  const handleComposerFocus = useCallback(() => onActivate(item.key), [item.key, onActivate]);

  return (
    <View style={[styles.tile, frameStyle]} testID={`mission-control-agent-grid-tile-${agentId}`}>
      <TileHeader item={item} />
      <View style={styles.body}>
        <EmbeddedAgentPane
          serverId={serverId}
          agentId={agentId}
          isFocused={isFocused && isActive}
          viewedTimelineSourceId={`mission-control-agent-grid:${serverId}:${agentId}`}
          reportsFocusedAgent={isActive}
          submitButtonTestID={`mission-control-agent-grid-composer-submit-${agentId}`}
          onComposerFocus={handleComposerFocus}
        />
      </View>
    </View>
  );
});

export interface AgentGridTilePlaceholderProps extends TileFrame {
  item: AgentGridItem;
}

/** A tile outside the mount window: same header and size, no stream. */
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
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: TILE_HEADER_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
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
  },
  placeholderBody: {
    flex: 1,
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
