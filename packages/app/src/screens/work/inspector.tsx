import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Archive, ArrowUpRight, X } from "lucide-react-native";
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
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { createWorkspaceFileTabTarget, type WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { useWorkspaceOpenState } from "@/mission-control/workspace-open-state";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { ToastApi } from "@/components/toast-host";
import type { Theme } from "@/styles/theme";
import type { TFunction } from "i18next";
import type { WorkInspectorTarget } from "./inspector-store";
import { closeWorkInspector, useWorkInspectorTarget } from "./inspector-store";
import { useWorkItemDetail } from "@/data/work";
import { WorkDetail } from "./detail";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_PERMISSION_LIST: PendingPermission[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const VIEWED_TIMELINE_SOURCE_ID = "work-inspector";
const INSPECTOR_HEADER_MIN_HEIGHT = 48;

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedX = withUnistyles(X);
const ThemedArchive = withUnistyles(Archive);
const arrowUpRightMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const CLOSE_ICON = <ThemedX size={14} uniProps={arrowUpRightMutedMapping} />;

interface WorkInspectorProps {
  target?: WorkInspectorTarget | null;
  isFocused?: boolean;
}

export function WorkInspector({
  target: passedTarget,
  isFocused = true,
}: WorkInspectorProps): ReactElement | null {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { target: storeTarget } = useWorkInspectorTarget();
  const target = passedTarget !== undefined ? passedTarget : storeTarget;

  if (!target) return null;

  return (
    <WorkInspectorContent
      itemId={target.itemId}
      isFocused={isFocused}
      isCompact={isCompact}
      insetsBottom={insets.bottom}
      t={t}
      toast={toast}
    />
  );
}

function useInspectorAgentBindings(itemId: string): {
  agentId: string | null;
  serverId: string | null;
  hasAgent: boolean;
  agent: ReturnType<typeof resolveSessionAgent>;
} {
  const { detail } = useWorkItemDetail(itemId);
  const agentId = detail?.item.agentId ?? null;
  const serverId = detail?.item.agentHost ?? null;
  const hasAgent = Boolean(agentId && serverId);
  const agent = useSessionStore((state) => {
    if (!serverId || !agentId) return null;
    const session = state.sessions[serverId];
    if (!session) return null;
    return resolveSessionAgent(session, agentId);
  });
  return { agentId, serverId, hasAgent, agent };
}

function useInspectorStreamState(
  serverId: string | null,
  agentId: string | null,
): {
  streamItems: StreamItem[];
  streamHead: StreamItem[];
  turnPresentation: ReturnType<typeof selectAgentTurnPresentation> | null;
  pendingMessageSubmissions: ReturnType<typeof getActiveMessageSubmissions>;
  pendingPermissions: Map<string, PendingPermission>;
  isAuthoritativeHistoryReady: boolean;
} {
  const streamItems = useSessionStore(
    (state) =>
      (serverId && agentId ? state.sessions[serverId]?.agentStreamTail.get(agentId) : null) ??
      EMPTY_STREAM_ITEMS,
  );
  const streamHead = useSessionStore(
    (state) =>
      (serverId && agentId ? state.sessions[serverId]?.agentStreamHead.get(agentId) : null) ??
      EMPTY_STREAM_ITEMS,
  );
  const turnPresentation = useSessionStore(
    useShallow((state) =>
      serverId && agentId ? selectAgentTurnPresentation(state.sessions[serverId], agentId) : null,
    ),
  );
  const pendingMessageSubmissions = useSessionStore(
    useShallow((state) =>
      serverId && agentId
        ? getActiveMessageSubmissions(state.sessions[serverId]?.messageSubmissions.get(agentId))
        : [],
    ),
  );
  const pendingPermissionList = useSessionStore(
    useShallow((state) => {
      if (!serverId || !agentId) return EMPTY_PERMISSION_LIST;
      const allPending = state.sessions[serverId]?.pendingPermissions;
      if (!allPending) return EMPTY_PERMISSION_LIST;
      const filtered: PendingPermission[] = [];
      for (const permission of allPending.values()) {
        if (permission.agentId === agentId) filtered.push(permission);
      }
      return filtered.length > 0 ? filtered : EMPTY_PERMISSION_LIST;
    }),
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) return EMPTY_PERMISSIONS;
    return new Map(pendingPermissionList.map((p) => [p.key, p]));
  }, [pendingPermissionList]);
  const isAuthoritativeHistoryReady = useSessionStore((state) =>
    Boolean(
      serverId && agentId
        ? state.sessions[serverId]?.agentAuthoritativeHistoryApplied.get(agentId) === true
        : false,
    ),
  );
  return {
    streamItems,
    streamHead,
    turnPresentation,
    pendingMessageSubmissions,
    pendingPermissions,
    isAuthoritativeHistoryReady,
  };
}

function useInspectorEffects(
  agentId: string | null,
  serverId: string | null,
  isFocused: boolean,
): void {
  const viewedTimelineSync = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.viewedTimelineSync ?? null) : null,
  );
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);

  useEffect(() => {
    if (!viewedTimelineSync || !agentId) return;
    viewedTimelineSync.replaceVisibleAgentIds(VIEWED_TIMELINE_SOURCE_ID, [agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds(VIEWED_TIMELINE_SOURCE_ID, []);
  }, [agentId, viewedTimelineSync]);

  useEffect(() => {
    if (!isFocused || !serverId || !agentId) return;
    setFocusedAgentId(serverId, agentId);
    return () => setFocusedAgentId(serverId, null);
  }, [agentId, isFocused, serverId, setFocusedAgentId]);
}

interface WorkInspectorHeaderProps {
  itemId: string;
  serverId: string | null;
  agentId: string | null;
  hasAgent: boolean;
  isCompact: boolean;
  t: TFunction;
  workspaceArchivedOrMissing: boolean;
  workspaceIsArchived: boolean;
  onOpenInWorkspace: () => void;
}

function WorkInspectorHeader({
  itemId,
  serverId,
  hasAgent,
  isCompact,
  t,
  workspaceArchivedOrMissing,
  workspaceIsArchived,
  onOpenInWorkspace,
}: WorkInspectorHeaderProps): ReactElement {
  const { detail } = useWorkItemDetail(itemId);
  const hosts = useHosts();
  const hostLabel = useMemo(
    () => hosts.find((h) => h.serverId === serverId)?.label?.trim() || serverId || "",
    [hosts, serverId],
  );

  const openInWorkspaceTrailing = useMemo(
    () => <ThemedArrowUpRight size={14} uniProps={arrowUpRightMutedMapping} />,
    [],
  );
  const openInWorkspaceBlockedReason = useMemo(
    () =>
      workspaceIsArchived
        ? t("missionControl.inspector.workspaceArchived")
        : t("missionControl.inspector.workspaceUnavailable"),
    [t, workspaceIsArchived],
  );
  const openInWorkspaceButton = useMemo(() => {
    const button = (
      <Button
        variant="ghost"
        size="xs"
        trailing={openInWorkspaceTrailing}
        onPress={onOpenInWorkspace}
        disabled={workspaceArchivedOrMissing}
        testID="work-detail-open-workspace"
      >
        Open in workspace
      </Button>
    );
    if (!workspaceArchivedOrMissing) return button;
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
    onOpenInWorkspace,
    openInWorkspaceBlockedReason,
    openInWorkspaceTrailing,
    workspaceArchivedOrMissing,
  ]);

  const closeInspectorButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="xs"
        leftIcon={CLOSE_ICON}
        onPress={closeWorkInspector}
        testID="work-detail-close"
        accessibilityLabel="Close inspector"
      />
    ),
    [],
  );

  const headerTitleAccessory = useMemo(
    () =>
      serverId ? (
        <View style={styles.headerBadgeSlot}>
          <HostGlyph serverId={serverId} label={hostLabel} size={20} />
        </View>
      ) : null,
    [hostLabel, serverId],
  );

  const primaryLabel = detail?.item.humanKey ?? itemId;

  if (isCompact) {
    return (
      <BackHeader
        title={primaryLabel}
        titleAccessory={headerTitleAccessory}
        rightContent={openInWorkspaceButton}
        onBack={closeWorkInspector}
      />
    );
  }

  return (
    <View style={styles.header}>
      <View style={styles.headerIdentity}>
        <Text style={styles.headerName} numberOfLines={1}>
          {primaryLabel}
        </Text>
        {detail?.item.title ? (
          <Text style={styles.headerTitle} numberOfLines={1}>
            {detail.item.title}
          </Text>
        ) : null}
      </View>
      {serverId ? <HostGlyph serverId={serverId} label={hostLabel} size={20} /> : null}
      {hasAgent ? openInWorkspaceButton : null}
      {closeInspectorButton}
    </View>
  );
}

interface WorkInspectorAgentRegionProps {
  agentId: string;
  serverId: string;
  agent: ReturnType<typeof resolveSessionAgent>;
  isFocused: boolean;
  insetsBottom: number;
  toast: ToastApi;
}

function WorkInspectorAgentRegion({
  agentId,
  serverId,
  agent,
  isFocused,
  insetsBottom,
  toast,
}: WorkInspectorAgentRegionProps): ReactElement {
  const {
    streamItems,
    streamHead,
    turnPresentation,
    pendingMessageSubmissions,
    pendingPermissions,
    isAuthoritativeHistoryReady,
  } = useInspectorStreamState(serverId, agentId);

  const agentDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({
      serverId: serverId ?? "unknown",
      agentId: agentId ?? "unknown",
    }),
  });

  const olderHistory = useLoadOlderAgentHistory({
    serverId: serverId ?? "",
    agentId: agentId ?? "",
    toast,
  });
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
      serverId: serverId ?? "",
      id: agentId ?? "",
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
      if (!agent?.workspaceId || !serverId) return;
      navigateToWorkspace({
        serverId,
        workspaceId: agent.workspaceId,
        target: createWorkspaceFileTabTarget(request.location),
      });
    },
    [agent?.workspaceId, serverId],
  );

  const composerCwd = agent?.cwd ?? "~";
  const composerContainerStyle = useMemo(() => ({ paddingBottom: insetsBottom }), [insetsBottom]);
  const isArchived = agent ? Boolean(agent.archivedAt) : false;
  const fallbackTurnPresentation = useMemo(
    () => ({ isActive: false, isCancelling: false, startedAt: null, turnId: null }),
    [],
  );

  return (
    <>
      <View style={styles.streamArea}>
        <AgentStreamView
          agentId={agentId}
          serverId={serverId}
          context={streamContext}
          streamItems={streamItems}
          streamHead={streamHead}
          pendingPermissions={pendingPermissions}
          pendingMessageSubmissions={pendingMessageSubmissions ?? []}
          turnPresentation={turnPresentation ?? fallbackTurnPresentation}
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
            onChangeText={agentDraft.editText}
            textReplacementKey={agentDraft.textReplacementKey}
            attachments={agentDraft.attachments}
            onChangeAttachments={agentDraft.setAttachments}
            cwd={composerCwd}
            clearDraft={agentDraft.clear}
            submitButtonTestID="work-inspector-composer-submit"
          />
        )}
      </View>
    </>
  );
}

function WorkInspectorContent({
  itemId,
  isFocused,
  isCompact,
  insetsBottom,
  t,
  toast,
}: {
  itemId: string;
  isFocused: boolean;
  isCompact: boolean;
  insetsBottom: number;
  t: TFunction;
  toast: ToastApi;
}): ReactElement {
  const { agentId, serverId, hasAgent, agent } = useInspectorAgentBindings(itemId);
  const { isArchived: workspaceIsArchived, isArchivedOrMissing: workspaceArchivedOrMissing } =
    useWorkspaceOpenState(serverId, agent?.workspaceId);

  useInspectorEffects(agentId, serverId, isFocused);

  const handleOpenInWorkspace = useCallback(() => {
    if (workspaceArchivedOrMissing || !serverId || !agentId) return;
    void openAgentFromHistory({
      serverId,
      agentId,
      workspaceId: agent?.workspaceId ?? null,
      archived: agent ? Boolean(agent.archivedAt) : true,
    });
  }, [agent, agentId, serverId, workspaceArchivedOrMissing]);

  const showArchivedBanner = agent ? Boolean(agent.archivedAt) || workspaceIsArchived : false;

  return (
    <View style={styles.container} testID="work-inspector">
      <WorkInspectorHeader
        itemId={itemId}
        serverId={serverId}
        agentId={agentId}
        hasAgent={hasAgent}
        isCompact={isCompact}
        t={t}
        workspaceArchivedOrMissing={workspaceArchivedOrMissing}
        workspaceIsArchived={workspaceIsArchived}
        onOpenInWorkspace={handleOpenInWorkspace}
      />
      {showArchivedBanner ? (
        <View style={styles.archivedBanner} testID="work-inspector-archived-banner">
          <ThemedArchive size={12} uniProps={arrowUpRightMutedMapping} />
          <Text style={styles.archivedBannerText}>
            {t("missionControl.inspector.archivedBanner")}
          </Text>
        </View>
      ) : null}
      <View style={styles.detailArea}>
        <WorkDetail itemId={itemId} onClose={closeWorkInspector} />
      </View>
      {hasAgent && agentId && serverId ? (
        <WorkInspectorAgentRegion
          agentId={agentId}
          serverId={serverId}
          agent={agent}
          isFocused={isFocused}
          insetsBottom={insetsBottom}
          toast={toast}
        />
      ) : null}
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
  detailArea: {
    flex: 1,
    minHeight: 200,
  },
  streamArea: {
    flex: 1,
    minHeight: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));
