import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { TFunction } from "i18next";
import { SquarePen } from "lucide-react-native";
import React, {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { shallow, useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useAgentStreamTail } from "@/agent-stream/use-agent-stream-tail";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { SidebarCallout } from "@/components/sidebar-callout";
import { UnavailableProviderCallout } from "@/components/unavailable-provider-callout";
import { ComposerDock } from "@/composer/dock";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { RetainedChatContent } from "./retained-chat-content";
import { Composer } from "@/composer";
import { AgentCommandsProvider } from "@/agent-commands";
import {
  useComposerEditingSession,
  useComposerFullscreen,
  type ComposerEditingSession,
} from "@/composer/editing-session";
import {
  resolveComposerTrackControlClearance,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import {
  RewindCommandCenterRegistration,
  RewindComposerRestoreProvider,
} from "@/components/rewind";
import { useAgentDescriptor } from "@/agent-presentation";
import {
  useToastHost,
  type DismissToastById,
  type ToastApi,
  type ToastState,
} from "@/components/toast-host";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAgentAttentionClear } from "@/hooks/use-agent-attention-clear";
import { useAgentInputDraft, type AgentInputDraft } from "@/composer/draft/input-draft";
import {
  type AgentScreenAgent,
  type AgentScreenContinuity,
  type AgentScreenMissingState,
  type AgentScreenViewState,
  useAgentScreenStateMachine,
  type AgentScreenReadySyncState,
} from "@/hooks/use-agent-screen-state-machine";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { reconcileMissingAgentStateWithPresentAgent } from "@/panels/agent-panel-load-state";
import { TimelineSyncStatus } from "@/timeline/sync-status";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { PaneSubtitle } from "@/panels/pane-subtitle";
import { definePanel } from "@/panels/panel-registry";
import { RenderProfile } from "@/utils/render-profiler";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
  useHostRuntimeLastError,
  useHosts,
} from "@/runtime/host-runtime";
import {
  deriveRouteBottomAnchorIntent,
  deriveRouteBottomAnchorRequest,
} from "@/screens/agent/agent-ready-screen-bottom-anchor";
import { WorkspaceDraftComposer } from "@/composer/draft/workspace-tab";
import { type DraftConversation, useDraftTimeline } from "@/composer/draft/timeline";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { AgentTracks } from "@/panels/agent-tracks";
import { OverlayDismissalScope } from "@/components/ui/overlay-dismissal";
import { ParentAgentCallout, useParentAgentId } from "@/subagents/parent";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import {
  selectAgentTimelineState,
  selectAgentTimelineTurnPresentation,
  type Agent,
  useSessionStore,
} from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { useSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { ViewedTimelineStatus, ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import { normalizeAgentSnapshot, resolveSessionAgent } from "@/utils/agent-snapshots";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import { storeFetchedAgentDetail } from "@/utils/hydrate-fetched-agent";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { buildDraftAgentSetup, type ClientSlashCommand } from "@/client-slash-commands";

interface ChatAgentStateShape {
  serverId: string | null;
  id: string | null;
  provider?: Agent["provider"];
  status: Agent["status"] | null;
  cwd: string | null;
  workspaceId?: string;
  capabilities?: Agent["capabilities"];
  currentModeId?: Agent["currentModeId"];
  model?: Agent["model"];
  thinkingOptionId?: Agent["thinkingOptionId"];
  runtimeInfo?: Agent["runtimeInfo"];
  options?: Agent["options"];
  controls?: Agent["controls"];
  lastError?: Agent["lastError"] | null;
}

interface ChatAgentSelectedState extends ChatAgentStateShape {
  archivedAt: Date | null;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"] | null;
  providerUnavailable: boolean;
  /** Live agent labels (e.g. paseo.commander-adopted-at for Commander-managed workers). */
  labels: Record<string, string>;
}

function readViewedTimelineError(input: {
  agentId: string | undefined;
  status: ViewedTimelineStatus;
  sync: ViewedTimelineUiBridge | null;
}): string | null {
  if (!input.agentId || input.status !== "error" || !input.sync) return null;
  return input.sync.getAgentTimelineError(input.agentId);
}

const EMPTY_CHAT_AGENT_STATE: ChatAgentSelectedState = {
  serverId: null,
  id: null,
  status: null,
  cwd: null,
  lastError: null,
  archivedAt: null,
  requiresAttention: false,
  attentionReason: null,
  providerUnavailable: false,
  labels: {},
};

function selectChatAgentState(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): ChatAgentSelectedState {
  const agent = resolveSessionAgent(state.sessions[serverId], agentId);
  if (!agent) return EMPTY_CHAT_AGENT_STATE;
  return {
    serverId: agent.serverId,
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    model: agent.model,
    thinkingOptionId:
      agent.effectiveThinkingOptionId ??
      agent.runtimeInfo?.thinkingOptionId ??
      agent.thinkingOptionId,
    runtimeInfo: agent.runtimeInfo,
    options: agent.options,
    controls: agent.controls,
    lastError: agent.lastError ?? null,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    providerUnavailable: agent.providerUnavailable === true,
    labels: agent.labels ?? {},
  };
}

function buildChatAgentFromState(
  state: ChatAgentStateShape,
  projectPlacement: Agent["projectPlacement"] | null,
): AgentScreenAgent | null {
  if (!state.serverId || !state.id || !state.status || !state.cwd) {
    return null;
  }
  return {
    serverId: state.serverId,
    id: state.id,
    provider: state.provider,
    status: state.status,
    cwd: state.cwd,
    workspaceId: state.workspaceId,
    capabilities: state.capabilities,
    currentModeId: state.currentModeId,
    model: state.model,
    thinkingOptionId: state.thinkingOptionId,
    runtimeInfo: state.runtimeInfo,
    options: state.options,
    controls: state.controls,
    lastError: state.lastError ?? null,
    projectPlacement,
  };
}

function AgentLoadErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="agent-load-error">
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
        <Text style={styles.statusText}>{message}</Text>
        <View style={styles.errorAction}>
          <Button variant="secondary" onPress={onRetry} testID="agent-load-error-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/** A draft has no agent to wait for; an agent shows its loading and error states until ready. */
function renderConversationNonReadyView(args: {
  draft: DraftConversation | null;
  agentId: string | undefined;
  cwd: string | null;
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
  onRetryLoad: () => void;
}): React.ReactElement | null {
  if (args.draft) {
    return null;
  }
  const nonReadyView = renderChatAgentNonReadyView(args);
  if (nonReadyView) {
    return nonReadyView;
  }
  invariant(args.agentId, "agent id is defined when agent content is ready");
  invariant(args.effectiveAgent, "effectiveAgent is defined when the non-ready view is absent");
  invariant(args.cwd, "agent cwd is defined when agent content is ready");
  return null;
}

function renderChatAgentNonReadyView(args: {
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
  onRetryLoad: () => void;
}): React.ReactElement | null {
  const { viewState, effectiveAgent, t, onRetryLoad } = args;
  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }
  if (viewState.tag === "error") {
    return <AgentLoadErrorView message={viewState.message} onRetry={onRetryLoad} />;
  }
  if (viewState.tag === "boot" || !effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }
  return null;
}

type ConversationTarget = Extract<WorkspaceTabTarget, { kind: "agent" } | { kind: "draft" }>;

/** The agent a conversation shows; a draft has none until its first prompt creates one. */
function resolveConversationAgentId(target: ConversationTarget): string | undefined {
  return target.kind === "agent" ? target.agentId.trim() || undefined : undefined;
}

/**
 * Drafts and agents render through one chain so the timeline stays mounted when the draft's
 * first prompt creates the agent and the tab retargets. The agent gates are idle for a draft.
 */
export function AgentConversationPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(
    target.kind === "agent" || target.kind === "draft",
    "AgentConversationPanel requires an agent or draft target",
  );

  return (
    <RetainedChatContent>
      <AgentPanelContent
        serverId={serverId}
        workspaceId={workspaceId}
        target={target}
        isPaneFocused={isInteractive}
        onOpenWorkspaceFile={openFileInWorkspace}
      />
    </RetainedChatContent>
  );
}

export const agentPanelRegistration = definePanel("agent", {
  component: AgentConversationPanel,
  useDescriptor: useAgentDescriptor,
});

export function useDraftPanelDescriptor(
  target: { kind: "draft"; draftId: string },
  context: { serverId: string },
) {
  const createDescriptorState = useCreateFlowStore(
    useShallow((state) => {
      const pending = state.pendingByDraftId[target.draftId];
      if (pending?.serverId !== context.serverId || pending.lifecycle !== "active") {
        return {
          isCreating: false,
          pendingPrompt: null,
        };
      }
      return {
        isCreating: true,
        pendingPrompt: pending.text,
      };
    }),
  );

  return buildDraftPanelDescriptor({
    ...createDescriptorState,
    icon: SquarePen,
  });
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_MESSAGE_SUBMISSIONS = [] as const;
const EMPTY_PENDING_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_PENDING_PERMISSION_LIST: PendingPermission[] = [];

type RouteBottomAnchorRequest = ReturnType<typeof deriveRouteBottomAnchorRequest>;

function findActiveCreateHandoff(input: {
  pendingByDraftId: ReturnType<typeof useCreateFlowStore.getState>["pendingByDraftId"];
  serverId: string;
  agentId?: string;
}): boolean {
  if (!input.agentId) {
    return false;
  }
  return Object.values(input.pendingByDraftId).some(
    (pending) =>
      pending.lifecycle === "sent" &&
      pending.serverId === input.serverId &&
      pending.agentId === input.agentId,
  );
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

type AgentLookupState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "not_found"; message: string }
  | { tag: "error"; message: string };

function AgentPanelContent({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const resolvedAgentId = resolveConversationAgentId(target);
  const resolvedServerId = serverId.trim() || undefined;
  const daemons = useHosts();
  const runtimeServerId = resolvedServerId ?? "";
  const runtimeClient = useHostRuntimeClient(runtimeServerId);
  const runtimeIsConnected = useHostRuntimeIsConnected(runtimeServerId);
  const runtimeConnectionStatus = useHostRuntimeConnectionStatus(runtimeServerId);
  const runtimeLastError = useHostRuntimeLastError(runtimeServerId);
  const hasCachedAgent = useSessionStore((state) => {
    if (!resolvedServerId || !resolvedAgentId) return false;
    const session = state.sessions[resolvedServerId];
    return Boolean(
      session?.agents.has(resolvedAgentId) || session?.agentDetails.has(resolvedAgentId),
    );
  });

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? (daemons.find((entry) => entry.serverId === connectionServerId) ?? null)
    : null;
  const serverLabel =
    daemon?.label ?? connectionServerId ?? t("agentPanel.unavailable.selectedHost");
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    isUnknownDaemon && runtimeConnectionStatus === "connecting"
      ? "offline"
      : runtimeConnectionStatus;
  const lastConnectionError = runtimeLastError;

  if (target.kind === "agent" && (!resolvedServerId || (!runtimeClient && !hasCachedAgent))) {
    return (
      <AgentSessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
        t={t}
      />
    );
  }

  return (
    <AgentPanelBody
      serverId={resolvedServerId ?? serverId}
      workspaceId={workspaceId}
      target={target}
      isPaneFocused={isPaneFocused}
      client={runtimeClient}
      isConnected={runtimeIsConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function AgentPanelBody({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const agentId = resolveConversationAgentId(target);
  const { isArchivingAgent: _isArchivingAgent } = useArchiveAgent();
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const [lookupState, setLookupState] = useState<AgentLookupState>({ tag: "idle" });
  const lookupAttemptTokenRef = useRef(0);
  const retryAgentLookup = useCallback(() => setLookupState({ tag: "idle" }), []);

  useEffect(() => {
    lookupAttemptTokenRef.current += 1;
    setLookupState({ tag: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.id) {
      if (lookupState.tag !== "idle") {
        setLookupState({ tag: "idle" });
      }
      return;
    }
    if (!client || !isConnected || !hasSession) {
      return;
    }
    if (lookupState.tag === "loading" || lookupState.tag === "not_found") {
      return;
    }

    setLookupState({ tag: "loading" });
    const attemptToken = ++lookupAttemptTokenRef.current;

    client
      .fetchAgent({ agentId })
      .then((result) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        if (!result) {
          setLookupState({
            tag: "not_found",
            message: `Agent not found: ${agentId}`,
          });
          return;
        }

        storeFetchedAgentDetail({ serverId, result });
        setLookupState({ tag: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setLookupState({ tag: "not_found", message });
          return;
        }
        setLookupState({ tag: "error", message });
      });
  }, [agentId, agentState.id, client, hasSession, isConnected, lookupState.tag, serverId]);

  if (lookupState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }

  if (lookupState.tag === "error") {
    return <AgentLoadErrorView message={lookupState.message} onRetry={retryAgentLookup} />;
  }

  const agent: AgentScreenAgent | null =
    agentState.serverId && agentState.id && agentState.status && agentState.cwd
      ? {
          serverId: agentState.serverId,
          id: agentState.id,
          provider: agentState.provider,
          status: agentState.status,
          cwd: agentState.cwd,
          workspaceId: agentState.workspaceId,
          capabilities: agentState.capabilities,
          currentModeId: agentState.currentModeId,
          model: agentState.model,
          thinkingOptionId: agentState.thinkingOptionId,
          runtimeInfo: agentState.runtimeInfo,
          options: agentState.options,
          controls: agentState.controls,
          lastError: agentState.lastError ?? null,
          projectPlacement,
        }
      : null;

  if (target.kind === "agent" && !agent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }

  return (
    <ChatAgentContent
      serverId={serverId}
      workspaceId={workspaceId}
      target={target}
      isPaneFocused={isPaneFocused}
      client={client}
      isConnected={isConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function ChatAgentContent({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const { tabId } = usePaneContext();
  const agentId = resolveConversationAgentId(target);
  const isPaneVisible = useRetainedPanelActive();
  const { api: toastApi, toast: toastState, dismiss: dismissToast } = useToastHost();
  const { isArchivingAgent } = useArchiveAgent();
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const initAttemptTokenRef = useRef(0);
  const routeBottomAnchorRequestRef = useRef<{
    routeKey: string;
    reason: "initial-entry" | "resume";
  } | null>(null);
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const isInitializingFromMap = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.initializingAgents?.get(agentId) ?? false) : false,
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0,
  );
  const replicaTimelineStatus = useSessionStore((state) =>
    agentId
      ? selectAgentTimelineState(state.sessions[serverId], agentId).status
      : ("cold" as const),
  );
  const hasAppliedAuthoritativeHistory = replicaTimelineStatus === "synced";
  const agentHistorySyncGeneration = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.agentHistorySyncGeneration?.get(agentId) ?? -1) : -1,
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const subscribeToVisibilityCatchUp = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTimelineStatus = useCallback((): ViewedTimelineStatus => {
    if (!agentId) return "ready";
    // Until the owner is published nothing has confirmed this chat, so its check has not begun.
    return viewedTimelineSync?.getAgentTimelineStatus(agentId) ?? "checking";
  }, [agentId, viewedTimelineSync]);
  const timelineStatus = useSyncExternalStore(
    subscribeToVisibilityCatchUp,
    readTimelineStatus,
    readTimelineStatus,
  );
  const visibilityCatchUpStatus = isPaneVisible ? timelineStatus : "ready";
  const visibilityCatchUpError = readViewedTimelineError({
    agentId,
    status: visibilityCatchUpStatus,
    sync: viewedTimelineSync,
  });
  const hasActiveCreateHandoff = useCreateFlowStore((state) =>
    findActiveCreateHandoff({ pendingByDraftId: state.pendingByDraftId, serverId, agentId }),
  );
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });

  const hasHydratedHistoryBefore =
    hasAppliedAuthoritativeHistory || replicaTimelineStatus === "painted";

  const focusRequest = useWorkspaceLayoutStore((state) => {
    const request = state.focusRequest;
    return request?.workspaceKey === `${serverId}:${workspaceId}` && request.tabId === tabId
      ? request
      : null;
  });
  const reportAttentionError = useCallback(
    (error: unknown) => {
      toastApi.error(toErrorMessage(error));
    },
    [toastApi],
  );
  const attentionController = useAgentAttentionClear({
    agentId,
    client,
    isConnected,
    isAgentDataReady: agentHistorySyncGeneration === historySyncGeneration,
    requiresAttention: agentState.requiresAttention,
    attentionReason: agentState.attentionReason,
    isScreenFocused: isPaneFocused,
    focusRequest,
    onError: reportAttentionError,
  });
  const isArchivingCurrentAgent = Boolean(agentId && isArchivingAgent({ serverId, agentId }));

  const isInitializing = agentId ? isInitializingFromMap : false;
  const isHistorySyncing = useMemo(() => {
    if (!agentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, agentId);
    return Boolean(getInitDeferred(initKey));
  }, [agentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!agentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, agentId, historySyncGeneration]);

  const agent = useMemo<AgentScreenAgent | null>(
    () => buildChatAgentFromState(agentState, projectPlacement),
    [agentState, projectPlacement],
  );
  const continuity = useMemo<AgentScreenContinuity>(() => {
    if (!hasActiveCreateHandoff || !agentId) {
      return { kind: "none" };
    }
    return {
      kind: "optimistic-create",
      agent: {
        serverId,
        id: agentId,
        status: "running",
        cwd: agent?.cwd ?? ".",
        projectPlacement: agent?.projectPlacement ?? null,
      },
    };
  }, [agent, agentId, hasActiveCreateHandoff, serverId]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${agentId ?? ""}`,
    input: {
      agent: agent ?? null,
      isArchived: agentState.archivedAt !== null,
      missingAgentState,
      isConnected,
      isArchivingCurrentAgent,
      isHistorySyncing,
      needsAuthoritativeSync,
      visibilityCatchUpStatus,
      visibilityCatchUpError,
      continuity,
      hasHydratedHistoryBefore,
    },
  });

  const effectiveAgent = viewState.tag === "ready" ? viewState.agent : null;
  const routeEntryKey = agentId ? `${serverId}:${agentId}` : null;
  routeBottomAnchorRequestRef.current = deriveRouteBottomAnchorIntent({
    cachedIntent: routeBottomAnchorRequestRef.current,
    routeKey: routeEntryKey,
    hasAppliedAuthoritativeHistoryAtEntry: hasAppliedAuthoritativeHistory,
  });
  const routeBottomAnchorRequest = useMemo(
    () =>
      deriveRouteBottomAnchorRequest({
        intent: routeBottomAnchorRequestRef.current,
        effectiveAgentId: effectiveAgent?.id ?? null,
      }),
    [effectiveAgent?.id],
  );

  const handleComposerHeightChange = useCallback(
    (_height: number) => {
      if (!agentId) {
        return;
      }
      streamViewRef.current?.prepareForViewportChange();
    },
    [agentId],
  );

  const handleMessageSent = useCallback(() => {
    if (!agentId) {
      return;
    }
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [agentId]);

  const retryAgentLoad = useCallback(() => {
    setMissingAgentState({ kind: "idle" });
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  const retryTimelineSync = useCallback(() => {
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  useEffect(() => {
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.archivedAt) {
      return;
    }
    if (agentState.id && hasAppliedAuthoritativeHistory) {
      if (
        missingAgentState.kind === "resolving" ||
        missingAgentState.kind === "not_found" ||
        missingAgentState.kind === "error"
      ) {
        setMissingAgentState(reconcileMissingAgentStateWithPresentAgent);
      }
      return;
    }
    if (
      !client ||
      !viewedTimelineSync ||
      !isPaneVisible ||
      !isConnected ||
      !hasSession ||
      visibilityCatchUpStatus !== "ready"
    ) {
      return;
    }
    if (
      missingAgentState.kind === "resolving" ||
      missingAgentState.kind === "not_found" ||
      missingAgentState.kind === "error"
    ) {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    Promise.resolve()
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentSession = useSessionStore.getState().sessions[serverId];
        const currentAgent =
          currentSession?.agents.get(agentId) ?? currentSession?.agentDetails.get(agentId);
        if (!currentAgent) {
          const result = await client.fetchAgent({ agentId });
          if (attemptToken !== initAttemptTokenRef.current) {
            return;
          }
          if (!result) {
            setMissingAgentState({
              kind: "not_found",
              message: `Agent not found: ${agentId}`,
            });
            return;
          }
          storeFetchedAgentDetail({ serverId, result });
        }
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setMissingAgentState({ kind: "not_found", message });
          return;
        }
        setMissingAgentState({ kind: "error", message });
      });
  }, [
    agentState.id,
    agentState.archivedAt,
    hasAppliedAuthoritativeHistory,
    agentId,
    client,
    hasSession,
    isConnected,
    isPaneVisible,
    missingAgentState.kind,
    serverId,
    viewedTimelineSync,
    visibilityCatchUpStatus,
  ]);

  const draft = useMemo<DraftConversation | null>(
    () =>
      target.kind === "draft"
        ? {
            tabId,
            workspaceId,
            draftId: target.draftId,
            setup: target.setup,
            ...(target.forkSource ? { forkSource: target.forkSource } : {}),
          }
        : null,
    [tabId, target, workspaceId],
  );
  const nonReadyView = renderConversationNonReadyView({
    draft,
    agentId,
    cwd: agentState.cwd,
    viewState,
    effectiveAgent,
    t,
    onRetryLoad: retryAgentLoad,
  });
  if (nonReadyView) return nonReadyView;
  const showHistorySyncOverlay =
    viewState.tag === "ready" &&
    viewState.sync.status === "catching_up" &&
    viewState.sync.ui === "overlay";
  const showHistorySyncError = viewState.tag === "ready" && viewState.sync.status === "sync_error";
  const isRetryingHistorySync =
    viewState.tag === "ready" &&
    viewState.sync.status === "sync_error" &&
    viewState.sync.isRetrying;

  return (
    <ChatAgentReadyContent
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId ?? tabId}
      draft={draft}
      isPaneFocused={isPaneFocused}
      isArchivingCurrentAgent={isArchivingCurrentAgent}
      agentState={agentState}
      effectiveAgent={effectiveAgent}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
      hasCachedHistory={replicaTimelineStatus === "painted"}
      toastApi={toastApi}
      toast={toastState}
      dismiss={dismissToast}
      streamViewRef={streamViewRef}
      handleComposerHeightChange={handleComposerHeightChange}
      handleMessageSent={handleMessageSent}
      timelineSync={isPaneVisible && viewState.tag === "ready" ? viewState.sync : null}
      showHistorySyncOverlay={showHistorySyncOverlay}
      showHistorySyncError={showHistorySyncError}
      isRetryingHistorySync={isRetryingHistorySync}
      cwd={agentState.cwd ?? ""}
      retryTimelineSync={retryTimelineSync}
      onAttentionInputFocus={attentionController.clearOnInputFocus}
      onAttentionPromptSend={attentionController.clearOnPromptSend}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

const ChatAgentReadyContent = memo(function ChatAgentReadyContent({
  serverId,
  workspaceId,
  agentId,
  draft,
  isPaneFocused,
  isArchivingCurrentAgent,
  agentState,
  effectiveAgent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  hasCachedHistory,
  toastApi,
  toast,
  dismiss,
  streamViewRef,
  handleComposerHeightChange,
  handleMessageSent,
  timelineSync,
  showHistorySyncOverlay,
  showHistorySyncError,
  isRetryingHistorySync,
  retryTimelineSync,
  cwd,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  /** The agent's id, or the tab id while a draft has no agent yet. */
  agentId: string;
  draft: DraftConversation | null;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  agentState: ChatAgentSelectedState;
  effectiveAgent: AgentScreenAgent | null;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  hasCachedHistory: boolean;
  toastApi: ToastApi;
  toast: ToastState | null;
  dismiss: DismissToastById;
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  handleComposerHeightChange: (height: number) => void;
  handleMessageSent: () => void;
  timelineSync: AgentScreenReadySyncState | null;
  showHistorySyncOverlay: boolean;
  showHistorySyncError: boolean;
  isRetryingHistorySync: boolean;
  retryTimelineSync: () => void;
  cwd: string;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  // The workspace sheet is for looking; Open as tab brings the agent back with its composer.
  const paneHost = usePaneContext().host;
  const showsComposer = draft !== null || paneHost !== "sheet";
  // The dock lays out fullscreen for the same session the composer edits in.
  const composerEditingSession = useComposerEditingSession("chat");
  const isComposerFullscreen = useComposerFullscreen(composerEditingSession);

  const hasActiveComposer = !agentState.archivedAt && !isArchivingCurrentAgent;
  const focusRestoredComposer = useStableEvent(() => {
    if (isPaneFocused && showsComposer && hasActiveComposer) {
      composerEditingSession.focus();
    }
  });
  const handleRewindComplete = useCallback(
    (restoredComposerText: boolean) => {
      streamViewRef.current?.scrollToBottom("rewind");
      if (restoredComposerText) {
        // Defer focus so the editor can apply the restored draft and the menu can start closing.
        requestAnimationFrame(focusRestoredComposer);
      }
    },
    [focusRestoredComposer, streamViewRef],
  );
  const hasAgentComposer = showsComposer && hasActiveComposer && !draft;
  const parentAgentId = useParentAgentId(serverId, agentId);
  // With a composer the parent is a pill above it; without one, the box takes the composer's place.
  const parentPillAgentId = showsComposer ? parentAgentId : null;

  const rawAgentInputDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId,
    }),
  });
  // Stabilize the agentInputDraft object identity so that memo(AgentComposerSection) can bail out
  // when only toast state changes (which does not affect any draft field).
  const {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  } = rawAgentInputDraft;
  const agentInputDraft = useMemo(
    (): AgentInputDraft => ({
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    }),
    [
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    ],
  );
  const parentCallout = parentAgentId ? (
    <ParentAgentCallout serverId={serverId} parentAgentId={parentAgentId} />
  ) : null;
  const agentComposerSection = showsComposer ? (
    <RenderProfile id={`AgentComposerSection:${agentId}`}>
      <AgentComposerSection
        agentId={agentId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        isArchivingCurrentAgent={isArchivingCurrentAgent}
        archivedAt={agentState.archivedAt}
        providerUnavailable={agentState.providerUnavailable}
        cwd={cwd}
        isSubmitLoading={false}
        agentInputDraft={agentInputDraft}
        editingSession={composerEditingSession}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={handleComposerHeightChange}
        onMessageSent={handleMessageSent}
      />
    </RenderProfile>
  ) : (
    parentCallout
  );
  const composerSection = draft ? (
    <DraftComposerSection
      serverId={serverId}
      draft={draft}
      isPaneFocused={isPaneFocused}
      editingSession={composerEditingSession}
    />
  ) : (
    agentComposerSection
  );
  const handleAttentionInteraction = useCallback(() => {
    onAttentionInputFocus();
    return false;
  }, [onAttentionInputFocus]);
  const streamContent = (
    <View
      style={animatedStaticStyles.content}
      onStartShouldSetResponderCapture={handleAttentionInteraction}
    >
      {showsComposer ? null : <SheetAgentFacts serverId={serverId} agentId={agentId} />}
      <RenderProfile id={`AgentStreamSection:${agentId}`}>
        <AgentStreamSection
          streamViewRef={streamViewRef}
          serverId={serverId}
          agentId={agentId}
          agent={effectiveAgent}
          draft={draft}
          routeBottomAnchorRequest={routeBottomAnchorRequest}
          hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
          isInitialHistoryLoading={
            routeBottomAnchorRequest?.reason === "initial-entry" &&
            !hasCachedHistory &&
            !showHistorySyncError
          }
          revealInitialHistory={hasCachedHistory || showHistorySyncError}
          hasActiveComposer={hasActiveComposer}
          toast={toastApi}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </RenderProfile>
      {hasActiveComposer && !draft ? (
        <AgentTracks
          serverId={serverId}
          agentId={agentId}
          workspaceId={workspaceId}
          parentAgentId={parentPillAgentId}
        />
      ) : null}
    </View>
  );

  const dockContent = (
    <View style={styles.contentContainer}>
      {streamContent}

      <ChatDockCallouts
        providerUnavailable={agentState.providerUnavailable}
        showHistorySyncError={showHistorySyncError}
        isRetryingHistorySync={isRetryingHistorySync}
        retryTimelineSync={retryTimelineSync}
      />
    </View>
  );

  const dockOverlay = (
    <>
      {showHistorySyncOverlay ? (
        <View style={styles.historySyncOverlay} testID="agent-history-overlay">
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      ) : null}

      <TimelineSyncStatus sync={timelineSync} toast={toast} onDismiss={dismiss} />
    </>
  );

  const dock = (
    <ChatSurface disabled={isArchivingCurrentAgent} fullscreen={isComposerFullscreen}>
      {dockContent}
      {composerSection}
      {dockOverlay}
    </ChatSurface>
  );

  const content = (
    <RewindComposerRestoreProvider
      textSource={agentInputDraft.textSource}
      setText={agentInputDraft.replaceText}
      onRewindComplete={handleRewindComplete}
    >
      {hasAgentComposer ? (
        <RewindCommandCenterRegistration
          serverId={serverId}
          agentId={agentId}
          capabilities={agentState.capabilities}
          timelineSync={timelineSync}
          enabled={isPaneFocused}
        />
      ) : null}
      <View style={styles.root}>
        {dock}

        {isArchivingCurrentAgent ? (
          <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
            <ThemedLoadingSpinner size="large" uniProps={foregroundColorMapping} />
            <Text style={styles.archivingTitle}>{t("agentPanel.states.archivingTitle")}</Text>
            <Text style={styles.archivingSubtitle}>{t("agentPanel.states.archivingSubtitle")}</Text>
          </View>
        ) : null}
      </View>
    </RewindComposerRestoreProvider>
  );
  return wrapAgentCommandProvider({
    enabled: hasAgentComposer,
    serverId,
    agentId,
    editingSession: composerEditingSession,
    children: content,
  });
});

/** Callouts under the chat stream: an unavailable provider, and history that failed to sync. */
function ChatDockCallouts({
  providerUnavailable,
  showHistorySyncError,
  isRetryingHistorySync,
  retryTimelineSync,
}: {
  providerUnavailable: boolean;
  showHistorySyncError: boolean;
  isRetryingHistorySync: boolean;
  retryTimelineSync: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {providerUnavailable ? (
        <SidebarCallout
          title={t("agentPanel.providerUnavailable.callout")}
          description={t("agentPanel.providerUnavailable.detail")}
          variant="default"
          testID="agent-provider-unavailable-banner"
        />
      ) : null}

      {showHistorySyncError ? (
        <TimelineSyncErrorCallout isRetrying={isRetryingHistorySync} onRetry={retryTimelineSync} />
      ) : null}
    </>
  );
}

function wrapAgentCommandProvider({
  enabled,
  serverId,
  agentId,
  editingSession,
  children,
}: {
  enabled: boolean;
  serverId: string;
  agentId: string;
  editingSession: ComposerEditingSession;
  children: ReactNode;
}) {
  return (
    <AgentCommandsProvider
      serverId={serverId}
      agentId={agentId}
      editingSession={editingSession}
      enabled={enabled}
    >
      {children}
    </AgentCommandsProvider>
  );
}

function ChatSurface({
  children,
  disabled,
  fullscreen,
}: {
  children: [ReactNode, ReactNode, ReactNode];
  disabled: boolean;
  fullscreen: boolean;
}) {
  // The tracks above the composer open their pages from outside it, so focusing the composer
  // closes everything the chat opened.
  return (
    <OverlayDismissalScope>
      <FileDropZone style={styles.container} disabled={disabled}>
        <ComposerDock fullscreen={fullscreen}>{children}</ComposerDock>
      </FileDropZone>
    </OverlayDismissalScope>
  );
}

function TimelineSyncErrorCallout({
  isRetrying,
  onRetry,
}: {
  isRetrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.timelineSyncCalloutRail}>
      <View style={styles.timelineSyncCalloutContent}>
        <View style={styles.timelineSyncCallout} testID="agent-timeline-sync-error">
          <Text style={styles.timelineSyncCalloutText}>
            {t("agentPanel.states.timelineSyncFailed")}
          </Text>
          <Button
            variant="secondary"
            onPress={onRetry}
            disabled={isRetrying}
            testID="agent-timeline-sync-retry"
          >
            {isRetrying ? t("agentPanel.states.timelineSyncRetrying") : t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/**
 * What the composer's controls and context meter would show, as one line, for an agent shown
 * without its composer.
 */
function SheetAgentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return text ? <PaneSubtitle text={text} testID="agent-pane-subtitle" /> : null;
}

const AgentStreamSection = memo(function AgentStreamSection({
  streamViewRef,
  serverId,
  agentId,
  agent,
  draft,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  isInitialHistoryLoading,
  revealInitialHistory,
  hasActiveComposer,
  toast,
  onOpenWorkspaceFile,
}: {
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  serverId: string;
  agentId?: string;
  agent: AgentScreenAgent | null;
  draft: DraftConversation | null;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  isInitialHistoryLoading: boolean;
  revealInitialHistory: boolean;
  hasActiveComposer: boolean;
  toast: ReturnType<typeof useToastHost>["api"];
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const isCompactFormFactor = useIsCompactFormFactor();
  // The track bar's space is reserved whenever the bar is mounted, pills or not: pills come and go
  // every turn, and the transcript must not jump with them.
  const bottomOverlayTailClearance = hasActiveComposer
    ? resolveComposerTrackTailClearance(isCompactFormFactor)
    : 0;
  const bottomOverlayControlClearance = hasActiveComposer
    ? resolveComposerTrackControlClearance(isCompactFormFactor)
    : 0;
  const streamItemsRaw = useAgentStreamTail(serverId, agentId);
  const pendingMessageSubmissions = useSessionStore(
    useShallow((state) =>
      agentId
        ? getActiveMessageSubmissions(state.sessions[serverId]?.messageSubmissions.get(agentId))
        : EMPTY_MESSAGE_SUBMISSIONS,
    ),
  );
  const turnPresentation = useSessionStore(
    useShallow((state) =>
      agentId
        ? selectAgentTimelineTurnPresentation(state.sessions[serverId], agentId)
        : { isActive: false, isCancelling: false, startedAt: null, turnId: null },
    ),
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const pendingPermissionList = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const allPendingPermissions = state.sessions[serverId]?.pendingPermissions;
      if (!allPendingPermissions) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const filtered: PendingPermission[] = [];
      for (const permission of allPendingPermissions.values()) {
        if (permission.agentId === agentId) {
          filtered.push(permission);
        }
      }
      return filtered.length > 0 ? filtered : EMPTY_PENDING_PERMISSION_LIST;
    },
    shallow,
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) {
      return EMPTY_PENDING_PERMISSIONS;
    }
    return new Map(pendingPermissionList.map((permission) => [permission.key, permission]));
  }, [pendingPermissionList]);
  // A draft's timeline exists only while its first prompt creates the agent. The created agent's
  // timeline then replaces this input in the same mounted view.
  const draftTimeline = useDraftTimeline({ serverId, draft });

  const selectionAskConfig = useMemo(
    () =>
      agentId && agent
        ? {
            serverId,
            sourceAgentId: agent.id,
            cwd: agent.cwd,
            workspaceId: agent.workspaceId ?? null,
            projectKey: agent.projectPlacement?.projectKey ?? null,
            defaultProvider: agent.provider ?? null,
            defaultModel: agent.model ?? null,
            defaultThinkingOptionId:
              agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null,
          }
        : null,
    [agent, agentId, serverId],
  );

  if (draftTimeline) {
    return (
      <AgentStreamView
        ref={streamViewRef}
        agentId={draftTimeline.agent.id}
        serverId={serverId}
        context={draftTimeline.agent}
        streamItems={draftTimeline.streamItems}
        pendingPermissions={EMPTY_PENDING_PERMISSIONS}
        bottomOverlayTailClearance={bottomOverlayTailClearance}
        bottomOverlayControlClearance={bottomOverlayControlClearance}
        toast={toast}
        pendingMessageSubmissions={draftTimeline.pendingMessageSubmissions}
        turnPresentation={draftTimeline.turnPresentation}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    );
  }
  if (!agent) {
    return null;
  }
  return (
    <AgentStreamView
      ref={streamViewRef}
      agentId={agent.id}
      serverId={serverId}
      context={agent}
      streamItems={streamItems}
      pendingPermissions={pendingPermissions}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      isAuthoritativeHistoryReady={hasAppliedAuthoritativeHistory}
      isInitialHistoryLoading={isInitialHistoryLoading}
      revealInitialHistory={revealInitialHistory}
      bottomOverlayTailClearance={bottomOverlayTailClearance}
      bottomOverlayControlClearance={bottomOverlayControlClearance}
      toast={toast}
      pendingMessageSubmissions={pendingMessageSubmissions}
      turnPresentation={turnPresentation}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      selectionAsk={selectionAskConfig}
    />
  );
});

/** The draft's composer, which creates the agent and retargets this tab to it. */
function DraftComposerSection({
  serverId,
  draft,
  isPaneFocused,
  editingSession,
}: {
  serverId: string;
  draft: DraftConversation;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
}) {
  const { openImportSheet, retargetCurrentTab } = usePaneContext();
  const handleCreated = useCallback(
    (agentSnapshot: Parameters<typeof normalizeAgentSnapshot>[0]) => {
      const normalized = normalizeAgentSnapshot(agentSnapshot, serverId);
      const agent = applyLegacyDaemonWorkspaceOwnership({ serverId, agent: normalized });
      getHostRuntimeStore().acceptAgentSnapshot(serverId, agent);
      retargetCurrentTab({ kind: "agent", agentId: agentSnapshot.id });
    },
    [retargetCurrentTab, serverId],
  );

  return (
    <WorkspaceDraftComposer
      serverId={serverId}
      workspaceId={draft.workspaceId}
      tabId={draft.tabId}
      draftId={draft.draftId}
      initialSetup={draft.setup}
      forkSource={draft.forkSource}
      isPaneFocused={isPaneFocused}
      editingSession={editingSession}
      onCreated={handleCreated}
      onOpenImportSheet={openImportSheet}
    />
  );
}

const AgentComposerSection = memo(function AgentComposerSection({
  agentId,
  serverId,
  isPaneFocused,
  isArchivingCurrentAgent,
  archivedAt,
  providerUnavailable,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
}: {
  agentId?: string;
  serverId: string;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  archivedAt: Date | null;
  providerUnavailable: boolean;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  const { workspaceId, retargetCurrentTab } = usePaneContext();

  const handleContinueWithAnotherProvider = useCallback(() => {
    if (!agentId || !workspaceId) {
      return;
    }
    // Open a fresh draft in the same workspace with no provider preselected so
    // the user can pick a currently available provider/model.
    retargetCurrentTab({
      kind: "draft",
      draftId: generateDraftId(),
    });
  }, [agentId, retargetCurrentTab, workspaceId]);

  if (!agentId) {
    return null;
  }
  if (providerUnavailable) {
    return (
      <UnavailableProviderCallout
        onContinueWithAnotherProvider={handleContinueWithAnotherProvider}
      />
    );
  }
  if (archivedAt) {
    return <ArchivedAgentCallout serverId={serverId} agentId={agentId} />;
  }
  if (isArchivingCurrentAgent) {
    return null;
  }

  return (
    <ActiveAgentComposer
      agentId={agentId}
      serverId={serverId}
      isPaneFocused={isPaneFocused}
      cwd={cwd}
      isSubmitLoading={isSubmitLoading}
      agentInputDraft={agentInputDraft}
      editingSession={editingSession}
      onAttentionInputFocus={onAttentionInputFocus}
      onAttentionPromptSend={onAttentionPromptSend}
      onComposerHeightChange={onComposerHeightChange}
      onMessageSent={onMessageSent}
    />
  );
});

function ActiveAgentComposer({
  agentId,
  serverId,
  isPaneFocused,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
}: {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_CONTENT_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const paneContext = usePaneContext();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const { workspaceId, tabId, retargetCurrentTab } = paneContext;
  const { archiveAgent } = useArchiveAgent();
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd,
    workspaceId,
  });
  const attachmentScopeKeys = useMemo(
    () => [workspaceAttachmentScopeKey],
    [workspaceAttachmentScopeKey],
  );
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceChanges({
        isCompact: isCompactFormFactor,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        preferences: openInSidePane,
      });
    },
    [isCompactFormFactor, openInSidePane, serverId, workspaceId],
  );

  const handleClientSlashCommand = useCallback(
    async (command: ClientSlashCommand) => {
      const agent = resolveSessionAgent(useSessionStore.getState().sessions[serverId], agentId);
      if (!agent) {
        throw new Error("Agent not found");
      }

      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (workspaceKey) {
        unpinWorkspaceAgent(workspaceKey, agentId);
        hideWorkspaceAgent(workspaceKey, agentId);
      }

      if (command.kind === "replace-agent-with-draft") {
        retargetCurrentTab({
          kind: "draft",
          draftId: generateDraftId(),
          setup: buildDraftAgentSetup(agent),
        });
      } else if (workspaceKey) {
        closeWorkspaceTab(workspaceKey, tabId);
      }

      // System-owned agents (Commander, verifiers, machinery) are never
      // archivable from any UI surface — `/exit` and `/clear` close the tab but
      // leave it running so Mission Control can keep talking to them.
      if (!isSystemOwnedAgentLabels(agent.labels)) {
        await archiveAgent({ serverId, agentId });
      }
    },
    [
      agentId,
      archiveAgent,
      closeWorkspaceTab,
      hideWorkspaceAgent,
      retargetCurrentTab,
      serverId,
      tabId,
      unpinWorkspaceAgent,
      workspaceId,
    ],
  );
  const voice = useVoiceOptional();
  const { settings: appSettings } = useAppSettings();
  const toast = useToast();
  const toastErrorRef = useRef(toast.error);
  toastErrorRef.current = toast.error;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const pendingVoiceCreate = useCreateFlowStore((state) => {
    const pending = Object.values(state.pendingByDraftId).find(
      (entry) =>
        entry.startVoiceMode === true &&
        entry.serverId === serverId &&
        entry.agentId === agentId &&
        (entry.lifecycle === "sent" || entry.lifecycle === "active"),
    );
    return pending ?? null;
  });
  const pendingVoiceCreateKey = pendingVoiceCreate
    ? `${pendingVoiceCreate.draftId}:${pendingVoiceCreate.clientMessageId}`
    : null;
  const startedVoiceCreateKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingVoiceCreate || !pendingVoiceCreateKey || !voice || !isConnected) {
      return;
    }
    if (voice.isVoiceSwitching) {
      return;
    }
    if (voice.isVoiceModeForAgent(serverId, agentId)) {
      useCreateFlowStore.getState().clear({ draftId: pendingVoiceCreate.draftId });
      return;
    }
    if (startedVoiceCreateKeyRef.current === pendingVoiceCreateKey) {
      return;
    }
    startedVoiceCreateKeyRef.current = pendingVoiceCreateKey;

    void voice
      .startVoice(serverId, agentId, {
        // Realtime voice predates the Steer send behavior; Steer maps to
        // Interrupt (spoken input starts its own run).
        sendBehavior: appSettings.sendBehavior === "steer" ? "interrupt" : appSettings.sendBehavior,
      })
      .then(() => {
        useCreateFlowStore.getState().clear({ draftId: pendingVoiceCreate.draftId });
        return undefined;
      })
      .catch((error) => {
        startedVoiceCreateKeyRef.current = null;
        const message = toErrorMessage(error).trim();
        if (message.length > 0) {
          toastErrorRef.current(message);
        }
      });
  }, [
    agentId,
    appSettings.sendBehavior,
    isConnected,
    pendingVoiceCreate,
    pendingVoiceCreateKey,
    serverId,
    voice,
  ]);

  return (
    <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
      <Composer
        agentId={agentId}
        serverId={serverId}
        workspaceId={workspaceId}
        blurOnSubmit={isNative}
        isPaneFocused={isPaneFocused}
        textSource={agentInputDraft.textSource}
        onChangeText={agentInputDraft.editText}
        textReplacement={agentInputDraft.textReplacement}
        attachments={agentInputDraft.attachments}
        attachmentScopeKeys={attachmentScopeKeys}
        onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
        onChangeAttachments={agentInputDraft.setAttachments}
        cwd={cwd}
        clearDraft={agentInputDraft.clear}
        editingSession={editingSession}
        autoFocus
        autoFocusKey={String(agentInputDraft.attachmentFocusRequestId)}
        isSubmitLoading={isSubmitLoading}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={onComposerHeightChange}
        onMessageSent={onMessageSent}
        onClientSlashCommand={handleClientSlashCommand}
        isCompactLayout={isCompactComposerLayout}
      />
    </View>
  );
}

function AgentSessionUnavailableState({
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
  t,
}: {
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
  t: TFunction;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            {t("agentPanel.unavailable.unknownHost", { serverLabel })}
          </Text>
          <Text style={styles.statusText}>{t("agentPanel.unavailable.addHost")}</Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";
  const isPreparingSession = connectionStatus === "online";

  return (
    <View style={styles.container}>
      <View style={styles.centerState}>
        {isConnecting || isPreparingSession ? (
          <>
            <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
            <Text style={styles.loadingText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.preparingSession", { serverLabel })
                : t("agentPanel.unavailable.connecting", { serverLabel })}
            </Text>
            <Text style={styles.statusText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.showSoon")
                : t("agentPanel.unavailable.showWhenOnline")}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              {t("agentPanel.unavailable.reconnectingTo", { serverLabel })}
            </Text>
            <Text style={styles.offlineDescription}>
              {t("agentPanel.unavailable.showAgainWhenReachable")}
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const animatedStaticStyles = RNStyleSheet.create({
  content: {
    flex: 1,
  },
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surfacePane,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfacePane,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
    ...(isWeb ? { userSelect: "none" as const } : {}),
  },
  timelineSyncCalloutRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  timelineSyncCalloutContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  timelineSyncCallout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  timelineSyncCalloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  historySyncOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
  },
  archivingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 10, 14, 0.86)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    gap: theme.spacing[3],
    zIndex: 50,
  },
  archivingTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  archivingSubtitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorAction: {
    marginTop: theme.spacing[4],
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  offlineTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  offlineDescription: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  offlineDetails: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
