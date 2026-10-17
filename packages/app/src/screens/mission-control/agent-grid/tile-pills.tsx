import { memo, useCallback, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import {
  COMPOSER_PILL_MIN_HEIGHT,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import {
  useVisibleWorkspaceDiffStat,
  useWorkspaceHasDiffStat,
} from "@/composer/workspace-diff-stat";
import { SelectionAsksList, selectSelectionAsks } from "@/selection-ask";
import { useArchiveSubagent, useDetachSubagent, useSubagentsForParent } from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useAgentGridStore } from "./store";

/**
 * Maximum vertical reserve allocated to the in-flow pills row so it cannot push
 * the composer out of the tile on height-constrained viewports.
 */
export const TILE_PILLS_MAX_HEIGHT = COMPOSER_PILL_MIN_HEIGHT + 8; // 40px

/**
 * Maximum height allocated to the docked composer column reserve in a grid tile.
 */
export const TILE_COMPOSER_MAX_RESERVE = 180;

/**
 * Tail clearance required for the transcript view when ambient pills are rendered,
 * ensuring the last message is never obscured.
 */
export function resolveTilePillsTailClearance(hasPills: boolean, isCompact = true): number {
  return hasPills ? resolveComposerTrackTailClearance(isCompact) : 0;
}

export interface HasTilePillsOptions {
  subagentCount?: number;
  subagentRows?: readonly unknown[];
  hasSelectionAsks?: boolean;
  hasDiffStat?: boolean;
}

/**
 * Gate check: returns true if any ambient tile pills (subagents, asks, diffs) exist.
 */
export function hasTilePills(options: HasTilePillsOptions): boolean {
  const subagents =
    options.subagentCount !== undefined
      ? options.subagentCount > 0
      : Boolean(options.subagentRows?.length);
  return Boolean(subagents || options.hasSelectionAsks || options.hasDiffStat);
}

export interface UseHasTilePillsParams {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  /** Whether the composer is currently visible for this tile. */
  showComposer?: boolean;
}

/**
 * Hook to determine if any tile pills should be rendered for the agent tile.
 * Automatically evaluates to false if showComposer is false.
 */
export function useHasTilePills({
  serverId,
  agentId,
  workspaceId,
  showComposer = true,
}: UseHasTilePillsParams): boolean {
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const hasDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId ?? "");
  const selectionAsks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );

  if (!showComposer) {
    return false;
  }

  return hasTilePills({
    subagentCount: subagentRows.length,
    hasSelectionAsks: selectionAsks.length > 0,
    hasDiffStat: Boolean(workspaceId && hasDiffStat),
  });
}

export interface TilePillsProps {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  /** Whether the composer is currently visible for this tile. */
  showComposer?: boolean;
  /** Backwards compatibility alias for showComposer. */
  isActive?: boolean;
}

function notifyNavigatedFromGrid(payload: { serverId: string; agentId: string }): void {
  const store = useAgentGridStore.getState();
  if ("setNavigatedFromGrid" in store && typeof store.setNavigatedFromGrid === "function") {
    store.setNavigatedFromGrid(payload);
  }
}

/**
 * Ambient tracks strip for an AgentGridTile: subagent pills, diff stat, and asks.
 * Rendered as in-flow content immediately above the composer in the composer column.
 * Rendered ONLY when showComposer is true AND pills are non-empty; null otherwise.
 * Clicking a sub-agent opens that sub-agent in a new workspace tab.
 */
export const TilePills = memo(function TilePills({
  serverId,
  agentId,
  workspaceId,
  showComposer,
  isActive,
}: TilePillsProps): ReactElement | null {
  const isComposerVisible = Boolean(showComposer ?? isActive);
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId ?? "");
  const hasDiffStat = Boolean(diffStat && workspaceId);
  const selectionAsks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );
  const hasSelectionAsks = selectionAsks.length > 0;
  const hasSubagents = subagentRows.length > 0;

  const hasPills = hasTilePills({
    subagentCount: subagentRows.length,
    hasSelectionAsks,
    hasDiffStat,
  });

  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });

  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const subagent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);

      notifyNavigatedFromGrid({ serverId, agentId: subagentId });

      void openAgentFromHistory({
        serverId,
        agentId: subagentId,
        workspaceId: subagent?.workspaceId ?? workspaceId ?? null,
        archived: Boolean(subagent?.archivedAt),
      });
    },
    [serverId, workspaceId],
  );

  const handleOpenProviderSubagent = useCallback(
    (_parentAgentId: string, subagentId: string) => {
      notifyNavigatedFromGrid({ serverId, agentId: subagentId });

      void openAgentFromHistory({
        serverId,
        agentId: subagentId,
        workspaceId: workspaceId ?? null,
        archived: false,
      });
    },
    [serverId, workspaceId],
  );

  const handleOpenDiffs = useCallback(() => {
    if (workspaceId) {
      navigateToWorkspace({ workspaceId, serverId });
    }
  }, [serverId, workspaceId]);

  // Gate: only render when showComposer is true AND pills are non-empty.
  if (!isComposerVisible || !hasPills) {
    return null;
  }

  return (
    <View
      style={styles.container}
      testID={`mission-control-agent-grid-subagents-${agentId}`}
      pointerEvents="box-none"
    >
      {hasDiffStat && workspaceId ? (
        <WorkspaceDiffStatPill
          serverId={serverId}
          workspaceId={workspaceId}
          onPress={handleOpenDiffs}
        />
      ) : null}
      <SelectionAsksList serverId={serverId} agentId={agentId} />
      {hasSubagents ? (
        <SubagentsTrack
          serverId={serverId}
          rows={subagentRows}
          onOpenSubagent={handleOpenSubagent}
          onOpenProviderSubagent={handleOpenProviderSubagent}
          onArchiveSubagent={archiveSubagent}
          onDetachSubagent={detachSubagent}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
    minHeight: COMPOSER_PILL_MIN_HEIGHT,
    maxHeight: TILE_PILLS_MAX_HEIGHT,
    overflow: "hidden",
    flexShrink: 0,
    zIndex: 2,
  },
}));
