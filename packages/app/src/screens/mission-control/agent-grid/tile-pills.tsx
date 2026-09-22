import { memo, useCallback, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";
import { SelectionAsksList } from "@/selection-ask";
import { useArchiveSubagent, useDetachSubagent, useSubagentsForParent } from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useAgentGridStore } from "./store";

export interface TilePillsProps {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
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
 * Floating above the composer when active, or at the bottom edge when inactive.
 * Clicking a sub-agent opens that sub-agent in a new workspace tab.
 */
export const TilePills = memo(function TilePills({
  serverId,
  agentId,
  workspaceId,
  isActive = false,
}: TilePillsProps): ReactElement {
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId ?? "");
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

  return (
    <View
      style={[styles.container, isActive ? styles.aboveComposer : styles.atBottom]}
      testID={`mission-control-agent-grid-subagents-${agentId}`}
      pointerEvents="box-none"
    >
      {diffStat && workspaceId ? (
        <WorkspaceDiffStatPill
          serverId={serverId}
          workspaceId={workspaceId}
          onPress={handleOpenDiffs}
        />
      ) : null}
      <SelectionAsksList serverId={serverId} agentId={agentId} />
      {subagentRows.length > 0 ? (
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
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    zIndex: 5,
  },
  aboveComposer: {
    bottom: 56,
  },
  atBottom: {
    bottom: theme.spacing[1],
  },
}));
