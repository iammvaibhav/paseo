import { useCallback, useEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { createPaneFocusContextValue, PaneFocusProvider } from "@/panels/pane-context";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { useToast } from "@/contexts/toast-context";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { createWorkspaceFileTabTarget, type WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { filterMissionControlInspectorStream } from "./inspector-stream-filter";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_PERMISSION_LIST: PendingPermission[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

export interface EmbeddedAgentPaneProps {
  serverId: string;
  agentId: string;
  /** Owning surface is visible/focused (drives Composer isPaneFocused and, with reportsFocusedAgent, the heartbeat). */
  isFocused: boolean;
  /** Unique per mounted pane; passed to viewedTimelineSync.replaceVisibleAgentIds. Inspector keeps "mission-control-inspector". */
  viewedTimelineSourceId: string;
  /** When true (and isFocused) this pane's agent becomes the session's focusedAgentId. Inspector: true. Grid: only the active tile. */
  reportsFocusedAgent: boolean;
  submitButtonTestID?: string;
  /** Forwarded to Composer's focus signal — grid uses it to pick the active tile. */
  onComposerFocus?: () => void;
  /**
   * `compact` drops turn-footer action chrome and safe-area padding so the
   * stream fills the host (grid tiles). Inspector keeps `full`.
   */
  chrome?: "full" | "compact";
  /**
   * Grid tiles hide the composer until the user clicks the tile.
   * Inspector keeps the default (always shown).
   */
  showComposer?: boolean;
  /** Content rendered immediately above the Composer inside the composer container. */
  beforeComposer?: ReactNode;
  /**
   * Delay before registering with viewedTimelineSync to prevent rapid subscription
   * churning during scroll. Default 0 (instant).
   */
  timelineSyncDebounceMs?: number;
}

/**
 * The live stream + composer for one agent, shared by the Mission Control
 * inspector and the agent grid tiles. Resolves its own agent snapshot from
 * the session store — callers never pass the agent object down.
 */
export function EmbeddedAgentPane({
  serverId,
  agentId,
  isFocused,
  viewedTimelineSourceId,
  reportsFocusedAgent,
  submitButtonTestID,
  onComposerFocus,
  chrome = "full",
  showComposer = true,
  beforeComposer,
  timelineSyncDebounceMs = 0,
}: EmbeddedAgentPaneProps): ReactElement {
  const insets = useSafeAreaInsets();
  const compactChrome = chrome === "compact";
  const toast = useToast();
  const [verbose] = useMissionControlVerbose();

  const agent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (!session) {
      return null;
    }
    return resolveSessionAgent(session, agentId);
  });

  const streamItems = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamTail.get(agentId) ?? EMPTY_STREAM_ITEMS,
  );
  const streamHead = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamHead.get(agentId) ?? EMPTY_STREAM_ITEMS,
  );
  const visibleStreamItems = useMemo(
    () => filterMissionControlInspectorStream(streamItems, verbose),
    [streamItems, verbose],
  );
  const visibleStreamHead = useMemo(
    () => filterMissionControlInspectorStream(streamHead, verbose),
    [streamHead, verbose],
  );
  const turnPresentation = useSessionStore(
    useShallow((state) => selectAgentTurnPresentation(state.sessions[serverId], agentId)),
  );
  const pendingMessageSubmissions = useSessionStore(
    useShallow((state) =>
      getActiveMessageSubmissions(state.sessions[serverId]?.messageSubmissions.get(agentId)),
    ),
  );
  const pendingPermissionList = useSessionStore(
    useShallow((state) => {
      const allPending = state.sessions[serverId]?.pendingPermissions;
      if (!allPending) {
        return EMPTY_PERMISSION_LIST;
      }
      const filtered: PendingPermission[] = [];
      for (const permission of allPending.values()) {
        if (permission.agentId === agentId) {
          filtered.push(permission);
        }
      }
      return filtered.length > 0 ? filtered : EMPTY_PERMISSION_LIST;
    }),
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) {
      return EMPTY_PERMISSIONS;
    }
    return new Map(pendingPermissionList.map((permission) => [permission.key, permission]));
  }, [pendingPermissionList]);
  const isAuthoritativeHistoryReady = useSessionStore(
    (state) => state.sessions[serverId]?.agentAuthoritativeHistoryApplied.get(agentId) === true,
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);

  // Register this pane's agent as viewed so the timeline stays synced (tail
  // fetch on first sight, catch-up while visible) — same bridge the thread
  // uses for the Commander.
  useEffect(() => {
    if (!viewedTimelineSync) {
      return;
    }
    const isEphemeral = viewedTimelineSourceId.startsWith("mission-control-agent-grid:");
    const options = isEphemeral ? { ephemeral: true } : undefined;
    if (!timelineSyncDebounceMs || timelineSyncDebounceMs <= 0) {
      viewedTimelineSync.replaceVisibleAgentIds(viewedTimelineSourceId, [agentId], options);
      return () => viewedTimelineSync.replaceVisibleAgentIds(viewedTimelineSourceId, [], options);
    }
    const timer = setTimeout(() => {
      viewedTimelineSync.replaceVisibleAgentIds(viewedTimelineSourceId, [agentId], options);
    }, timelineSyncDebounceMs);
    return () => {
      clearTimeout(timer);
      viewedTimelineSync.replaceVisibleAgentIds(viewedTimelineSourceId, [], options);
    };
  }, [agentId, timelineSyncDebounceMs, viewedTimelineSourceId, viewedTimelineSync]);

  // Presence: while this pane both is visible and is allowed to report focus,
  // its agent is this client's focused agent (heartbeat + proposal presence
  // gate). The grid only lets its active tile report; the inspector always does.
  useEffect(() => {
    if (!isFocused || !reportsFocusedAgent) {
      return;
    }
    setFocusedAgentId(serverId, agentId);
    return () => setFocusedAgentId(serverId, null);
  }, [agentId, isFocused, reportsFocusedAgent, serverId, setFocusedAgentId]);

  // Composer draft (spec "Composer drafts"): keyed by the agent via the
  // shared draft store, so text survives navigation — and a target swap loads
  // that agent's own saved draft (live bug: raw useState reset the draft on
  // every navigation and agent swap).
  const agentDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({ serverId, agentId }),
  });

  const olderHistory = useLoadOlderAgentHistory({ serverId, agentId, toast });
  const historyPagination = useMemo(
    () => ({
      hasOlder: olderHistory.hasOlder,
      isLoadingOlder: olderHistory.isLoadingOlder,
      progressKey: olderHistory.progressKey,
      onLoadOlder: olderHistory.loadOlder,
    }),
    [
      olderHistory.hasOlder,
      olderHistory.isLoadingOlder,
      olderHistory.loadOlder,
      olderHistory.progressKey,
    ],
  );

  const streamContext = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: agentId,
      provider: agent?.provider,
      status: agent?.status ?? "initializing",
      cwd: agent?.cwd ?? "~",
      workspaceId: agent?.workspaceId,
      capabilities: agent?.capabilities,
      currentModeId: agent?.currentModeId,
      model: agent?.model,
      thinkingOptionId: agent?.thinkingOptionId,
      effectiveThinkingOptionId: agent?.effectiveThinkingOptionId,
      runtimeInfo: agent?.runtimeInfo,
      features: agent?.features,
      lastError: agent?.lastError,
      projectPlacement: agent?.projectPlacement,
    }),
    [agent, agentId, serverId],
  );

  const handleOpenWorkspaceFile = useCallback(
    (request: WorkspaceFileOpenRequest) => {
      if (!agent?.workspaceId) {
        return;
      }
      navigateToWorkspace({
        serverId,
        workspaceId: agent.workspaceId,
        target: createWorkspaceFileTabTarget(request.location),
      });
    },
    [agent?.workspaceId, serverId],
  );

  const isArchived = agent ? Boolean(agent.archivedAt) : false;
  const composerCwd = agent?.cwd ?? "~";
  // Grid tiles already sit inside the screen's safe area; extra inset here
  // would leave a blank strip under the composer.
  const composerContainerStyle = useMemo(
    () => (compactChrome ? undefined : { paddingBottom: insets.bottom }),
    [compactChrome, insets.bottom],
  );
  // AgentStreamView's chat find requires pane focus. This host is not a
  // workspace tab, so isFocused is both the workspace and the pane signal.
  const paneFocus = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused: isFocused,
        isPaneFocused: isFocused,
        onFocusPane: onComposerFocus,
      }),
    [isFocused, onComposerFocus],
  );

  // STE: Composer renders as a sibling below the stream. Grid tiles hide it
  // with showComposer; scroll-up keeps full transcript height for reading.
  const composerBlock = showComposer ? (
    <View style={composerContainerStyle}>
      {beforeComposer}
      {isArchived ? (
        <ArchivedAgentCallout serverId={serverId} agentId={agentId} />
      ) : (
        <Composer
          agentId={agentId}
          serverId={serverId}
          isPaneFocused={isFocused}
          textSource={agentDraft.textSource}
          onChangeText={agentDraft.editText}
          textReplacement={agentDraft.textReplacement}
          attachments={agentDraft.attachments}
          onChangeAttachments={agentDraft.setAttachments}
          cwd={composerCwd}
          clearDraft={agentDraft.clear}
          submitButtonTestID={submitButtonTestID}
          onAttentionInputFocus={onComposerFocus}
        />
      )}
    </View>
  ) : null;

  return (
    <PaneFocusProvider value={paneFocus}>
      <View style={styles.streamArea}>
        <AgentStreamView
          agentId={agentId}
          serverId={serverId}
          context={streamContext}
          streamItems={visibleStreamItems}
          streamHead={visibleStreamHead}
          pendingPermissions={pendingPermissions}
          pendingMessageSubmissions={pendingMessageSubmissions}
          turnPresentation={turnPresentation}
          isAuthoritativeHistoryReady={isAuthoritativeHistoryReady}
          toast={toast}
          onOpenWorkspaceFile={handleOpenWorkspaceFile}
          historyPagination={historyPagination}
          chrome={chrome}
        />
      </View>
      {composerBlock}
    </PaneFocusProvider>
  );
}

const styles = StyleSheet.create({
  streamArea: {
    flex: 1,
    minHeight: 0,
  },
});
