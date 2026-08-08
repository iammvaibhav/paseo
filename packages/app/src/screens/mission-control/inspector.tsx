import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpRight } from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { Composer } from "@/composer";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import type { UserComposerAttachment } from "@/attachments/types";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostBadges } from "@/hosts/use-host-badges";
import { HostBadge } from "@/hosts/host-badge";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { createWorkspaceFileTabTarget, type WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useInspectorStore, type InspectorTarget } from "./inspector-store";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_PERMISSION_LIST: PendingPermission[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

const VIEWED_TIMELINE_SOURCE_ID = "mission-control-inspector";
const INSPECTOR_HEADER_MIN_HEIGHT = 48;

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const arrowUpRightMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface MissionControlInspectorProps {
  target: InspectorTarget;
  /** False when the owning screen lost navigation focus while staying mounted. */
  isFocused: boolean;
}

/**
 * The embedded agent view inside Mission Control. Shows one agent's live
 * stream with an in-place composer. Clicking a board row or feed card swaps
 * the target here — the inspector never navigates on its own; the only
 * navigation affordance is "Open in workspace".
 */
export function MissionControlInspector({
  target,
  isFocused,
}: MissionControlInspectorProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { serverId, agentId } = target;

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
  const hostBadges = useHostBadges({ enabled: true });
  const hostBadge = hostBadges.get(serverId) ?? null;

  // Register the inspected agent as viewed so the timeline stays synced (tail
  // fetch on first sight, catch-up while visible) — same bridge the thread
  // uses for the Commander.
  useEffect(() => {
    if (!viewedTimelineSync) {
      return;
    }
    viewedTimelineSync.replaceVisibleAgentIds(VIEWED_TIMELINE_SOURCE_ID, [agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds(VIEWED_TIMELINE_SOURCE_ID, []);
  }, [agentId, viewedTimelineSync]);

  // Presence: while the inspector is actually visible, the inspected agent is
  // this client's focused agent (heartbeat + proposal presence gate).
  useEffect(() => {
    if (!isFocused) {
      return;
    }
    setFocusedAgentId(serverId, agentId);
    return () => setFocusedAgentId(serverId, null);
  }, [agentId, isFocused, serverId, setFocusedAgentId]);

  const [draftText, setDraftText] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<UserComposerAttachment[]>([]);
  // A swap to a different agent is a fresh context: drop the previous draft.
  useEffect(() => {
    setDraftText("");
    setDraftAttachments([]);
  }, [agentId, serverId]);
  const clearDraft = useCallback(() => {
    setDraftText("");
    setDraftAttachments([]);
  }, []);

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

  const handleOpenInWorkspace = useCallback(() => {
    void openAgentFromHistory({
      serverId,
      agentId,
      workspaceId: agent?.workspaceId ?? null,
      archived: agent ? Boolean(agent.archivedAt) : true,
    });
  }, [agent, agentId, serverId]);

  const closeInspector = useInspectorStore((state) => state.closeInspector);

  const primaryLabel = agent?.name ?? agent?.title ?? agentId;
  const secondaryLabel = agent?.name && agent?.title ? agent.title : null;
  const isArchived = agent ? Boolean(agent.archivedAt) : false;
  const composerCwd = agent?.cwd ?? "~";
  const composerContainerStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  const openInWorkspaceTrailing = useMemo(
    () => <ThemedArrowUpRight size={14} uniProps={arrowUpRightMutedMapping} />,
    [],
  );
  const openInWorkspaceButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="xs"
        trailing={openInWorkspaceTrailing}
        onPress={handleOpenInWorkspace}
        testID="mission-control-inspector-open-in-workspace"
      >
        Open in workspace
      </Button>
    ),
    [handleOpenInWorkspace, openInWorkspaceTrailing],
  );

  const headerTitleAccessory = useMemo(
    () =>
      hostBadge ? (
        <View style={styles.headerBadgeSlot}>
          <HostBadge badge={hostBadge} />
        </View>
      ) : null,
    [hostBadge],
  );

  const header = isCompact ? (
    <BackHeader
      title={primaryLabel}
      titleAccessory={headerTitleAccessory}
      rightContent={openInWorkspaceButton}
      onBack={closeInspector}
    />
  ) : (
    <View style={styles.header}>
      <View style={styles.headerIdentity}>
        <Text style={styles.headerName} numberOfLines={1}>
          {primaryLabel}
        </Text>
        {secondaryLabel ? (
          <Text style={styles.headerTitle} numberOfLines={1}>
            {secondaryLabel}
          </Text>
        ) : null}
      </View>
      {hostBadge ? <HostBadge badge={hostBadge} /> : null}
      {openInWorkspaceButton}
    </View>
  );

  return (
    <View style={styles.container} testID="mission-control-inspector">
      {header}
      <View style={styles.streamArea}>
        <AgentStreamView
          agentId={agentId}
          serverId={serverId}
          context={streamContext}
          streamItems={streamItems}
          streamHead={streamHead}
          pendingPermissions={pendingPermissions}
          pendingMessageSubmissions={pendingMessageSubmissions}
          turnPresentation={turnPresentation}
          isAuthoritativeHistoryReady={isAuthoritativeHistoryReady}
          toast={toast}
          onOpenWorkspaceFile={handleOpenWorkspaceFile}
          historyPagination={historyPagination}
        />
      </View>
      <View style={composerContainerStyle}>
        {isArchived ? (
          <ArchivedAgentCallout serverId={serverId} agentId={agentId} />
        ) : (
          <Composer
            agentId={agentId}
            serverId={serverId}
            isPaneFocused={isFocused}
            value={draftText}
            onChangeText={setDraftText}
            attachments={draftAttachments}
            onChangeAttachments={setDraftAttachments}
            cwd={composerCwd}
            clearDraft={clearDraft}
            submitButtonTestID="mission-control-inspector-composer-submit"
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: INSPECTOR_HEADER_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerIdentity: {
    flex: 1,
    minWidth: 0,
  },
  headerName: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  headerTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  headerBadgeSlot: {
    marginLeft: theme.spacing[2],
  },
  streamArea: {
    flex: 1,
    minHeight: 0,
  },
}));
