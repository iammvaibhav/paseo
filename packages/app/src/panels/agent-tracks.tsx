import { memo, useCallback, type ReactElement } from "react";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { SelectionAsksList } from "@/selection-ask/asks-list";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * The pane's trackers — its subagents, its asks, and its task list — as a row
 * of pills over the foot of the transcript.
 *
 * It is mounted inside the transcript's animated container rather than above the composer, and
 * that placement is the whole design: the pills paint over the timeline, so scrolled content
 * passes under them instead of stopping at a band, and the container carries the same keyboard
 * transform the composer does, so the pills stay glued to its top edge while the keyboard moves.
 *
 * Its state was living in the composer only because that is where it used to render. None of it
 * is composer state — a subagent row opens a tab, an ask row reopens the selection popover, the
 * task list reads the agent's stream.

 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  agentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
}: {
  serverId: string;
  agentId: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
}): ReactElement | null {
  const { openTab } = usePaneContext();
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [serverId],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );

  if (!hasAgentTracks({ subagentRows, tasks, archiveFinishedStatus })) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <SelectionAsksList serverId={serverId} agentId={agentId} />
      <AgentTaskList tasks={tasks} />
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  archiveFinishedStatus,
  hasSelectionAsks = false,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  hasSelectionAsks?: boolean;
}): boolean {
  return (
    subagentRows.length > 0 ||
    Boolean(tasks?.length) ||
    archiveFinishedStatus.kind !== "idle" ||
    hasSelectionAsks
  );
}
