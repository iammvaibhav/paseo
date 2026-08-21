import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMissionControlActive } from "@/screens/mission-control/focus-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
} from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MenuHeader } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { confirmDialog } from "@/utils/confirm-dialog";
import { MissionControlBoard } from "@/screens/mission-control/board";
import {
  MissionControlThread,
  type MissionControlCommander,
} from "@/screens/mission-control/thread";
import { MissionControlInspector } from "@/screens/mission-control/inspector";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { BoardRail } from "@/mission-control/board-rail";
import { InspectorRail } from "@/mission-control/inspector-rail";
import { MissionControlModeToggle } from "@/mission-control/mode-toggle";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import {
  resolveCommanderServerId,
  useHostInfoByServerId,
} from "@/screens/mission-control/commander-host";
import { useClearViewPoint } from "@/mission-control/clear-view";
import { useAggregatedMissionControlEvents } from "@/hooks/use-aggregated-mission-control-events";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { useShallow } from "zustand/react/shallow";
import { launchCommander } from "@/mission-control/launch";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "@/mission-control/labels";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { isWeb } from "@/constants/platform";
import {
  CommanderVoicePanel,
  normalizeVoiceNodeUrl,
  resolveComposerVoiceVariant,
} from "@/mission-control/voice";

type CompactPanel = "thread" | "board";

const THREAD_STRIP_WIDTH = 40;

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPanelLeftClose = withUnistyles(PanelLeftClose);
const ThemedPanelLeftOpen = withUnistyles(PanelLeftOpen);
const ThemedPanelRightClose = withUnistyles(PanelRightClose);
const ThemedPanelRightOpen = withUnistyles(PanelRightOpen);
const ThemedSquare = withUnistyles(Square);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function findCommander(
  agents: ReadonlyMap<
    string,
    { id: string; labels: Record<string, string>; archivedAt?: Date | null }
  >,
  details: ReadonlyMap<
    string,
    { id: string; labels: Record<string, string>; archivedAt?: Date | null }
  >,
): { agentId: string; archived: boolean } | null {
  // The thread targets THE Commander: value "commander" on the
  // `paseo.mission-control` key — never a verifier (which carries the same
  // key with value "verifier"), so findCommander can't adopt machinery.
  const isCommander = (labels: Record<string, string>) =>
    labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE;
  for (const agent of agents.values()) {
    if (isCommander(agent.labels)) {
      return { agentId: agent.id, archived: Boolean(agent.archivedAt) };
    }
  }
  for (const agent of details.values()) {
    if (isCommander(agent.labels)) {
      return { agentId: agent.id, archived: Boolean(agent.archivedAt) };
    }
  }
  return null;
}

// Board + inspector collapse state adds a few branches past the default cap.
// eslint-disable-next-line complexity -- MC desktop split layout
export function MissionControlScreen(): ReactElement {
  const { t } = useTranslation();
  const isFocused = useMissionControlActive();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const { events, isLoadingOlder, hasOlderEvents, loadOlderEvents } =
    useAggregatedMissionControlEvents();
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [recreatingArchivedId, setRecreatingArchivedId] = useState<string | null>(null);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>("thread");
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const { boardRailCollapsed, toggleBoardRailCollapsed } = usePanelStore(
    useShallow((state) => ({
      boardRailCollapsed: state.boardRailCollapsed,
      toggleBoardRailCollapsed: state.toggleBoardRailCollapsed,
    })),
  );
  // One per-device verbose flag, shared with the agent chat's machinery
  // placeholder rendering (useMissionControlVerbose). The hook's second
  // return is the toggle (same semantics as the previous local handler).
  const [verbose, handleToggleVerbose] = useMissionControlVerbose();
  const [resettingCommander, setResettingCommander] = useState(false);
  const toast = useToast();
  const { config: missionControlConfig } = useMissionControlCentralConfig();
  const hideAgentNames = missionControlConfig?.hideAgentNames === true;
  // M9 Commander Voice: the composer's voice button becomes Commander Voice
  // only on web/Electron with a voice node configured (empty = hidden; stock
  // voice button remains). The panel connects straight to the voice node.
  const voiceNodeUrl = missionControlConfig?.voiceNodeUrl ?? null;
  const composerVoiceVariant = resolveComposerVoiceVariant({ isWeb, voiceNodeUrl });
  const [isCommanderVoiceOpen, setIsCommanderVoiceOpen] = useState(false);
  const { clearPointTs, setClearViewPoint } = useClearViewPoint();
  const hostInfoByServerId = useHostInfoByServerId();

  // The Commander lives ONLY on the host designated in the central config:
  // designation is required, never defaulted (live incident: null commanderHost
  // made every host boot-ensure its own Commander). No designation → no host is
  // selected and the empty state points at Mission Control settings. The
  // central value is the daemon hostname, missionControl.hostAlias, or host
  // label, so resolve it to a connected host by serverId first, then by the
  // host's server_info hostname/alias.
  const centralCommanderHost = missionControlConfig?.commanderHost ?? null;
  const selectedServerId = useMemo(
    () => resolveCommanderServerId(centralCommanderHost, hosts, hostInfoByServerId),
    [centralCommanderHost, hostInfoByServerId, hosts],
  );

  // v3 feature gate: the split view (collapsible thread + inspector) exists
  // only when the commander host advertises missionControlV3. One gate, here.
  const v3Enabled = useHostFeature(selectedServerId, "missionControlV3");

  const commanderSearchSpace = useSessionStore(
    useShallow((state) => {
      if (!selectedServerId) {
        return null;
      }
      const session = state.sessions[selectedServerId];
      if (!session) {
        return null;
      }
      return { agents: session.agents, details: session.agentDetails };
    }),
  );

  const commander = useMemo(
    () =>
      commanderSearchSpace
        ? findCommander(commanderSearchSpace.agents, commanderSearchSpace.details)
        : null,
    [commanderSearchSpace],
  );

  const commanderAgent = useSessionStore((state) => {
    if (!selectedServerId || !commander) {
      return null;
    }
    return state.sessions[selectedServerId]?.agents.get(commander.agentId) ?? null;
  });

  const handleOpenCommanderVoice = useCallback(() => {
    setIsCommanderVoiceOpen(true);
  }, []);

  const handleCloseCommanderVoice = useCallback(() => {
    setIsCommanderVoiceOpen(false);
  }, []);

  const startCommander = useCallback(
    async (serverId: string) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      await launchCommander({ client, serverId });
    },
    [t],
  );

  const handleStartCommander = useCallback(async () => {
    if (!selectedServerId) {
      return;
    }
    setIsStarting(true);
    setStartError(null);
    try {
      await startCommander(selectedServerId);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  }, [selectedServerId, startCommander]);

  // The Commander is durable; if the stored one was archived, recreate it.
  useEffect(() => {
    if (!isFocused || !selectedServerId || !commander || !commander.archived) {
      return;
    }
    if (recreatingArchivedId === commander.agentId) {
      return;
    }
    setRecreatingArchivedId(commander.agentId);
    setIsStarting(true);
    setStartError(null);
    void startCommander(selectedServerId)
      .catch((error: unknown) => {
        setStartError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsStarting(false));
  }, [commander, isFocused, recreatingArchivedId, selectedServerId, startCommander]);

  const commanderRef = useMemo<MissionControlCommander | null>(
    () =>
      selectedServerId && commander && !commander.archived
        ? { serverId: selectedServerId, agentId: commander.agentId }
        : null,
    [commander, selectedServerId],
  );

  // Stop is only meaningful while the Commander agent is actually running.
  // Lifecycle status lives on the session store's agent entry; the selector
  // is narrow so the header only re-renders when the status changes.
  const commanderStatus = useSessionStore((state) => {
    if (!commanderRef) {
      return null;
    }
    return state.sessions[commanderRef.serverId]?.agents.get(commanderRef.agentId)?.status ?? null;
  });

  // Commander composer draft (spec "Composer drafts"): keyed by the commander
  // agent via the shared draft store, so text survives navigation like every
  // workspace tab (live bug: raw useState lost the draft on route changes).
  const commanderDraftKey = commanderRef
    ? buildDraftStoreKey({ serverId: commanderRef.serverId, agentId: commanderRef.agentId })
    : "mission-control:no-commander";
  const commanderDraft = useAgentInputDraft({ draftKey: commanderDraftKey });

  const handleStopCommander = useCallback(() => {
    // No-op unless the Commander agent is actually running: an idle or
    // archived agent has no turn to cancel.
    if (!commanderRef || commanderStatus !== "running") {
      return;
    }
    const client = getHostRuntimeStore().getClient(commanderRef.serverId);
    if (!client) {
      return;
    }
    void client.cancelAgent(commanderRef.agentId).catch((error: unknown) => {
      console.error("[MissionControl] Failed to cancel Commander turn:", error);
      toast.show("Unable to stop Commander", {
        durationMs: 2200,
        testID: "mission-control-stop-failed-toast",
      });
    });
  }, [commanderRef, commanderStatus, toast]);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings/mission-control");
  }, []);

  const handleClearView = useCallback(() => {
    // Per-device clear point (spec): the thread renders from this moment;
    // older cards stay in the store behind the thread's "Show earlier"
    // affordance. Does not touch the Commander.
    setClearViewPoint(Date.now());
  }, [setClearViewPoint]);

  const handleResetCommander = useCallback(() => {
    if (!commanderRef || resettingCommander) {
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: "Reset Commander?",
        message:
          "The current Commander is archived and a fresh one starts with a new context pack. The old conversation stays in History.",
        confirmLabel: "Reset",
        destructive: true,
      });
      if (!confirmed || !commanderRef) {
        return;
      }
      const client = getHostRuntimeStore().getClient(commanderRef.serverId);
      if (!client) {
        return;
      }
      setResettingCommander(true);
      // Guard the auto-recreate effect against the archive-then-spawn window:
      // while this agentId is marked as being replaced, the effect must not
      // launch a second Commander. The guard stays set — it only ever blocks
      // re-creating the archived commander this reset replaced.
      setRecreatingArchivedId(commanderRef.agentId);
      try {
        const result = await client.missionControlCommanderReset();
        if (!result.ok) {
          throw new Error(result.error ?? "Failed to reset Commander");
        }
        toast.show("Commander reset", { testID: "mission-control-reset-toast" });
      } catch (error) {
        console.error("[MissionControl] Failed to reset Commander:", error);
        toast.show("Unable to reset Commander", {
          durationMs: 2200,
          testID: "mission-control-reset-failed-toast",
        });
      } finally {
        setResettingCommander(false);
      }
    })();
  }, [commanderRef, resettingCommander, toast]);

  const inspectorTarget = useInspectorStore((state) => state.target);

  const composerCwd = commanderAgent?.cwd ?? "~";
  const composerContainerStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  const threadColumn = (() => {
    if (!selectedServerId) {
      return (
        <View style={styles.centerState} testID="mission-control-no-host">
          <Text style={styles.centerStateTitle}>No Commander host designated</Text>
          <Text style={styles.centerStateHint}>
            No host runs the fleet Commander until you pick one in Mission Control settings.
          </Text>
        </View>
      );
    }
    if (commanderRef) {
      return (
        <>
          <View style={styles.threadArea}>
            <MissionControlThread
              key={`${commanderRef.serverId}:${commanderRef.agentId}`}
              events={events}
              commander={commanderRef}
              verbose={verbose}
              clearPointTs={clearPointTs}
              onLoadOlder={loadOlderEvents}
              isLoadingOlder={isLoadingOlder}
              hasOlderEvents={hasOlderEvents}
            />
          </View>
          <View style={composerContainerStyle}>
            <Composer
              agentId={commanderRef.agentId}
              serverId={commanderRef.serverId}
              isPaneFocused={isFocused}
              value={commanderDraft.text}
              onChangeText={commanderDraft.editText}
              textReplacementKey={commanderDraft.textReplacementKey}
              attachments={commanderDraft.attachments}
              onChangeAttachments={commanderDraft.setAttachments}
              cwd={composerCwd}
              clearDraft={commanderDraft.clear}
              submitButtonTestID="mission-control-composer-submit"
              // M8 mailbox: the Commander thread delivers every message
              // immediately (idle run / busy steer-envelope) — the send-mode
              // selector stops applying here.
              mailboxDelivery
              voiceModeVariant={composerVoiceVariant}
              onCommanderVoicePress={
                composerVoiceVariant === "commander" ? handleOpenCommanderVoice : undefined
              }
            />
          </View>
          {isCommanderVoiceOpen && composerVoiceVariant === "commander" && voiceNodeUrl ? (
            <CommanderVoicePanel
              url={normalizeVoiceNodeUrl(voiceNodeUrl) ?? voiceNodeUrl}
              onClose={handleCloseCommanderVoice}
            />
          ) : null}
        </>
      );
    }
    return (
      <View style={styles.centerState} testID="mission-control-no-commander">
        <Text style={styles.centerStateTitle}>No Commander on this host</Text>
        <Text style={styles.centerStateHint}>
          Mission Control needs one durable Commander agent to route work across hosts.
        </Text>
        {startError ? <Text style={styles.startError}>{startError}</Text> : null}
        <Button
          variant="default"
          size="sm"
          onPress={handleStartCommander}
          disabled={isStarting}
          loading={isStarting}
          testID="mission-control-start-commander"
        >
          Start Commander
        </Button>
      </View>
    );
  })();

  const handleCollapseThread = useCallback(() => {
    setThreadCollapsed((current) => !current);
  }, []);
  const collapseToggleState = useMemo(() => ({ expanded: !threadCollapsed }), [threadCollapsed]);
  const boardCollapseToggleState = useMemo(
    () => ({ expanded: !boardRailCollapsed }),
    [boardRailCollapsed],
  );

  const headerRightContent = useMemo(
    () => (
      <View style={styles.headerActions}>
        {v3Enabled && !isCompact && commanderRef ? (
          <HeaderToggleButton
            onPress={handleCollapseThread}
            tooltipLabel={threadCollapsed ? "Expand Commander thread" : "Collapse Commander thread"}
            tooltipKeys={[]}
            tooltipSide="bottom"
            accessibilityRole="button"
            accessibilityLabel={
              threadCollapsed ? "Expand Commander thread" : "Collapse Commander thread"
            }
            accessibilityState={collapseToggleState}
            testID="mission-control-thread-collapse-toggle"
          >
            {({ hovered, pressed }) => {
              const iconProps = hovered || pressed ? foregroundMapping : foregroundMutedMapping;
              return threadCollapsed ? (
                <ThemedPanelLeftOpen size={16} uniProps={iconProps} />
              ) : (
                <ThemedPanelLeftClose size={16} uniProps={iconProps} />
              );
            }}
          </HeaderToggleButton>
        ) : null}
        {v3Enabled && !isCompact ? (
          <HeaderToggleButton
            onPress={toggleBoardRailCollapsed}
            tooltipLabel={boardRailCollapsed ? "Expand board" : "Collapse board"}
            tooltipKeys={[]}
            tooltipSide="bottom"
            accessibilityRole="button"
            accessibilityLabel={boardRailCollapsed ? "Expand board" : "Collapse board"}
            accessibilityState={boardCollapseToggleState}
            testID="mission-control-board-collapse-toggle"
          >
            {({ hovered, pressed }) => {
              const iconProps = hovered || pressed ? foregroundMapping : foregroundMutedMapping;
              return boardRailCollapsed ? (
                <ThemedPanelRightOpen size={16} uniProps={iconProps} />
              ) : (
                <ThemedPanelRightClose size={16} uniProps={iconProps} />
              );
            }}
          </HeaderToggleButton>
        ) : null}
        {v3Enabled && commanderRef && commanderStatus === "running" ? (
          <Button
            variant="ghost"
            size="xs"
            leftIcon={ThemedSquare}
            onPress={handleStopCommander}
            testID="mission-control-stop-commander"
            accessibilityLabel="Stop Commander"
          >
            Stop
          </Button>
        ) : null}
        {v3Enabled ? <MissionControlModeToggle size="sm" /> : null}
        {v3Enabled ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              style={overflowTriggerStyle}
              accessibilityLabel="Mission Control options"
              testID="mission-control-overflow-trigger"
            >
              <ThemedMoreVertical size={16} uniProps={foregroundMutedMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" minWidth={200}>
              <DropdownMenuItem
                selected={verbose}
                onSelect={handleToggleVerbose}
                testID="mission-control-verbose-toggle"
              >
                Verbose mode
              </DropdownMenuItem>
              {commanderRef ? (
                <>
                  <DropdownMenuItem onSelect={handleClearView} testID="mission-control-clear-view">
                    Clear view
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleResetCommander}
                    disabled={resettingCommander}
                    status={resettingCommander ? "pending" : undefined}
                    pendingLabel="Resetting..."
                    testID="mission-control-reset-commander"
                  >
                    Reset Commander
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleOpenSettings}
                testID="mission-control-settings-entry"
              >
                Mission Control settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </View>
    ),
    [
      boardCollapseToggleState,
      boardRailCollapsed,
      collapseToggleState,
      commanderRef,
      commanderStatus,
      handleClearView,
      handleCollapseThread,
      handleOpenSettings,
      handleResetCommander,
      handleStopCommander,
      handleToggleVerbose,
      isCompact,
      resettingCommander,
      threadCollapsed,
      toggleBoardRailCollapsed,
      verbose,
      v3Enabled,
    ],
  );

  const header = useMemo(
    () => <MenuHeader title="Mission Control" rightContent={headerRightContent} />,
    [headerRightContent],
  );

  const handleExpandThread = useCallback(() => {
    setThreadCollapsed(false);
  }, []);
  const threadStripStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.threadStrip,
      hovered && styles.threadStripHovered,
    ],
    [],
  );

  if (isCompact) {
    if (v3Enabled && inspectorTarget) {
      return (
        <View style={styles.container}>
          <MissionControlInspector target={inspectorTarget} isFocused={isFocused} />
        </View>
      );
    }
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.compactToggle}>
          <SegmentedControl<CompactPanel>
            options={[
              { value: "thread", label: "Thread", testID: "mission-control-panel-thread" },
              { value: "board", label: "Board", testID: "mission-control-panel-board" },
            ]}
            value={compactPanel}
            onValueChange={setCompactPanel}
            size="sm"
            testID="mission-control-panel-toggle"
          />
        </View>
        {compactPanel === "thread" ? (
          <View style={styles.threadColumn}>{threadColumn}</View>
        ) : (
          <View style={styles.threadColumn}>
            <MissionControlBoard
              hideAgentNames={hideAgentNames}
              testID="mission-control-board-panel"
            />
          </View>
        )}
      </View>
    );
  }

  // Collapsed thread: the strip replaces the column visually, but the thread
  // stays mounted (display:none) so expanding returns with zero movement —
  // same keep-alive contract as navigating away and back.
  const threadPane =
    v3Enabled && threadCollapsed ? (
      <>
        <Pressable
          onPress={handleExpandThread}
          style={threadStripStyle}
          accessibilityRole="button"
          accessibilityLabel="Expand Commander thread"
          testID="mission-control-thread-strip"
        >
          <Text style={styles.threadStripLabel}>Commander</Text>
        </Pressable>
        <View
          style={[styles.threadColumn, styles.threadColumnHidden]}
          pointerEvents="none"
          aria-hidden
        >
          {threadColumn}
        </View>
      </>
    ) : (
      <View style={styles.threadColumn}>{threadColumn}</View>
    );

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.desktopBody}>
        {threadPane}
        {v3Enabled && inspectorTarget ? (
          <InspectorRail flexFill={v3Enabled && threadCollapsed}>
            <MissionControlInspector target={inspectorTarget} isFocused={isFocused} />
          </InspectorRail>
        ) : null}
        {boardRailCollapsed ? null : (
          <BoardRail flexFill={v3Enabled && !inspectorTarget && threadCollapsed}>
            <MissionControlBoard
              hideAgentNames={hideAgentNames}
              testID="mission-control-board-rail"
            />
          </BoardRail>
        )}
      </View>
    </View>
  );
}

const overflowTriggerStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.overflowTrigger,
  pressed && styles.overflowTriggerPressed,
];

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  desktopBody: {
    flex: 1,
    flexDirection: "row",
  },
  threadColumn: {
    flex: 1,
    minWidth: 0,
  },
  threadColumnHidden: {
    display: "none",
  },
  threadStrip: {
    width: THREAD_STRIP_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    userSelect: "none",
  },
  threadStripHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  threadStripLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    transform: [{ rotate: "-90deg" }],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  overflowTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  overflowTriggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  compactToggle: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  threadArea: {
    flex: 1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  centerStateTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  centerStateHint: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  startError: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
}));
