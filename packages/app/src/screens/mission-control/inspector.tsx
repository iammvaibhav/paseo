import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpRight, Archive, X } from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostGlyph } from "@/components/host-glyph";
import { useHosts } from "@/runtime/host-runtime";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { createWorkspaceFileTabTarget, type WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { useWorkspaceOpenState } from "@/mission-control/workspace-open-state";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useAggregatedMissionControlEvents } from "@/hooks/use-aggregated-mission-control-events";
import { ProposalCard } from "@/screens/mission-control/proposal-card";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import { filterMissionControlInspectorStream } from "./inspector-stream-filter";
import { useInspectorStore, type InspectorTarget } from "./inspector-store";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_PERMISSION_LIST: PendingPermission[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

const VIEWED_TIMELINE_SOURCE_ID = "mission-control-inspector";
const INSPECTOR_HEADER_MIN_HEIGHT = 48;

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedX = withUnistyles(X);
const ThemedArchive = withUnistyles(Archive);
const arrowUpRightMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// Hoisted so the header button never takes a fresh JSX element as a prop
// (react-perf: no JSX literals in prop position).
const CLOSE_INSPECTOR_ICON = <ThemedX size={14} uniProps={arrowUpRightMutedMapping} />;

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
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [verbose] = useMissionControlVerbose();
  const { serverId, agentId } = target;

  const agent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (!session) {
      return null;
    }
    return resolveSessionAgent(session, agentId);
  });

  const { isArchived: workspaceIsArchived, isArchivedOrMissing: workspaceArchivedOrMissing } =
    useWorkspaceOpenState(serverId, agent?.workspaceId);

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
  const hosts = useHosts();
  const hostLabel = useMemo(
    () => hosts.find((host) => host.serverId === serverId)?.label?.trim() || serverId,
    [hosts, serverId],
  );

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

  // Inspector composer draft (spec "Composer drafts"): keyed by the inspected
  // agent via the shared draft store, so text survives navigation — and a
  // target swap loads that agent's own saved draft (live bug: raw useState
  // reset the draft on every navigation and agent swap).
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

  const handleOpenInWorkspace = useCallback(() => {
    if (workspaceArchivedOrMissing) {
      return;
    }
    void openAgentFromHistory({
      serverId,
      agentId,
      workspaceId: agent?.workspaceId ?? null,
      archived: agent ? Boolean(agent.archivedAt) : true,
    });
  }, [agent, agentId, serverId, workspaceArchivedOrMissing]);

  const closeInspector = useInspectorStore((state) => state.closeInspector);

  const primaryLabel = agent?.name ?? agent?.title ?? agentId;
  const secondaryLabel = agent?.name && agent?.title ? agent.title : null;
  const isArchived = agent ? Boolean(agent.archivedAt) : false;
  // Archived banner state: the agent itself is archived, or its workspace is
  // in the archived ("done") bucket. A workspace that merely is NOT listed on
  // this host is unavailable (often a wrong-host lookup), not archived — it
  // must never label the agent Archived.
  const showArchivedBanner = isArchived || workspaceIsArchived;
  const composerCwd = agent?.cwd ?? "~";
  const composerContainerStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  // Pending approval cards for THIS verifier's exchange (verifier-origin
  // proposals awaiting Approve/Edit/Deny): shown above the verifier's thread
  // so the audit conversation and its gate are visible together.
  const { events: missionControlEvents } = useAggregatedMissionControlEvents();
  const pendingExchangeCards = useMemo(
    () =>
      missionControlEvents.filter(
        (event) =>
          event.kind === "proposal" &&
          event.proposal?.status === "pending" &&
          event.proposal.verifierAgentId === agentId,
      ),
    [agentId, missionControlEvents],
  );

  const openInWorkspaceTrailing = useMemo(
    () => <ThemedArrowUpRight size={14} uniProps={arrowUpRightMutedMapping} />,
    [],
  );
  // Why "Open in workspace" is disabled: the workspace is archived ("done"),
  // or the host's synced directory simply no longer lists it (unavailable).
  // Distinct copy — an absent workspace is not an archived one.
  const openInWorkspaceBlockedReason = useMemo(
    () =>
      workspaceIsArchived
        ? t("missionControl.inspector.workspaceArchived")
        : t("missionControl.inspector.workspaceUnavailable"),
    [t, workspaceIsArchived],
  );
  // Archived workspace: navigating would dead-end on the missing-workspace
  // redirect, so the affordance degrades — disabled with an explanation
  // (tooltip on web) instead of firing a dead route.
  const openInWorkspaceButton = useMemo(() => {
    const button = (
      <Button
        variant="ghost"
        size="xs"
        trailing={openInWorkspaceTrailing}
        onPress={handleOpenInWorkspace}
        disabled={workspaceArchivedOrMissing}
        testID="mission-control-inspector-open-in-workspace"
      >
        Open in workspace
      </Button>
    );
    if (!workspaceArchivedOrMissing) {
      return button;
    }
    return (
      <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View collapsable={false}>{button}</View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" offset={8}>
          <Text style={styles.openTooltipText}>{openInWorkspaceBlockedReason}</Text>
        </TooltipContent>
      </Tooltip>
    );
  }, [
    handleOpenInWorkspace,
    openInWorkspaceBlockedReason,
    openInWorkspaceTrailing,
    workspaceArchivedOrMissing,
  ]);

  // Desktop close: the inspector is an embedded pane, not a navigation — the X
  // clears the inspected agent (target → null unmounts the pane). Width prefs
  // are owned by the resizable rail and are untouched; the focused-agent
  // heartbeat cleanup on unmount stops reporting this agent. Compact has its
  // own BackHeader back button (same action).
  const closeInspectorButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="xs"
        leftIcon={CLOSE_INSPECTOR_ICON}
        onPress={closeInspector}
        testID="mission-control-inspector-close"
        accessibilityLabel="Close inspector"
      />
    ),
    [closeInspector],
  );

  const headerTitleAccessory = useMemo(
    () => (
      <View style={styles.headerBadgeSlot}>
        <HostGlyph serverId={serverId} label={hostLabel} size={20} />
      </View>
    ),
    [hostLabel, serverId],
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
      <HostGlyph serverId={serverId} label={hostLabel} size={20} />
      {openInWorkspaceButton}
      {closeInspectorButton}
    </View>
  );

  return (
    <View style={styles.container} testID="mission-control-inspector">
      {header}
      {showArchivedBanner ? (
        <View style={styles.archivedBanner} testID="mission-control-inspector-archived-banner">
          <ThemedArchive size={12} uniProps={arrowUpRightMutedMapping} />
          <Text style={styles.archivedBannerText}>
            {t("missionControl.inspector.archivedBanner")}
          </Text>
        </View>
      ) : null}
      {pendingExchangeCards.length > 0 ? (
        <View style={styles.pendingCards} testID="mission-control-inspector-pending-exchange">
          {pendingExchangeCards.map((event) =>
            event.proposal ? (
              <ProposalCard key={event.id} proposal={event.proposal} event={event} />
            ) : null,
          )}
        </View>
      ) : null}
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
            value={agentDraft.text}
            onChangeText={agentDraft.setText}
            attachments={agentDraft.attachments}
            onChangeAttachments={agentDraft.setAttachments}
            cwd={composerCwd}
            clearDraft={agentDraft.clear}
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
  archivedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  archivedBannerText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  openTooltipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    maxWidth: 220,
  },
  streamArea: {
    flex: 1,
    minHeight: 0,
  },
  pendingCards: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    maxHeight: 180,
  },
}));
