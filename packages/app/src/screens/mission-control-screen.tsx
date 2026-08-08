import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { MoreVertical, PanelLeftClose, PanelLeftOpen, Square } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
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
import type { UserComposerAttachment } from "@/attachments/types";
import { MissionControlBoard } from "@/screens/mission-control/board";
import {
  MissionControlThread,
  type MissionControlCommander,
} from "@/screens/mission-control/thread";
import { MissionControlInspector } from "@/screens/mission-control/inspector";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { BoardRail } from "@/mission-control/board-rail";
import { MissionControlModeToggle } from "@/mission-control/mode-toggle";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { useAggregatedMissionControlEvents } from "@/hooks/use-aggregated-mission-control-events";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { useShallow } from "zustand/react/shallow";
import {
  launchCommander,
  loadCommanderHostServerId,
  saveCommanderHostServerId,
} from "@/mission-control/launch";
import { isCommanderAgent } from "@/mission-control/labels";
import { useIsCompactFormFactor } from "@/constants/layout";

type CompactPanel = "thread" | "board";

const VERBOSE_STORAGE_KEY = "@paseo:mission-control-verbose";
const THREAD_STRIP_WIDTH = 40;

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPanelLeftClose = withUnistyles(PanelLeftClose);
const ThemedPanelLeftOpen = withUnistyles(PanelLeftOpen);
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
  for (const agent of agents.values()) {
    if (isCommanderAgent(agent.labels)) {
      return { agentId: agent.id, archived: Boolean(agent.archivedAt) };
    }
  }
  for (const agent of details.values()) {
    if (isCommanderAgent(agent.labels)) {
      return { agentId: agent.id, archived: Boolean(agent.archivedAt) };
    }
  }
  return null;
}

export function MissionControlScreen(): ReactElement {
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const { events, isLoadingOlder, hasOlderEvents, loadOlderEvents } =
    useAggregatedMissionControlEvents();
  const [commanderHostServerId, setCommanderHostServerId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [recreatingArchivedId, setRecreatingArchivedId] = useState<string | null>(null);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>("thread");
  const [draftText, setDraftText] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<UserComposerAttachment[]>([]);
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const toast = useToast();
  const { config: missionControlConfig } = useMissionControlCentralConfig();
  const hideAgentNames = missionControlConfig?.hideAgentNames === true;

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(VERBOSE_STORAGE_KEY)
      .then((value) => {
        if (!cancelled) {
          setVerbose(value === "1");
        }
        return value;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("Failed to load verbose preference", error);
        }
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleVerbose = useCallback(() => {
    setVerbose((current) => !current);
  }, []);

  // Persist the per-device verbose toggle; the initial hydration read must not
  // write the value straight back.
  const verboseInitializedRef = useRef(false);
  useEffect(() => {
    if (!verboseInitializedRef.current) {
      verboseInitializedRef.current = true;
      return;
    }
    void AsyncStorage.setItem(VERBOSE_STORAGE_KEY, verbose ? "1" : "0").catch(() => undefined);
  }, [verbose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadCommanderHostServerId();
      if (cancelled) {
        return;
      }
      setCommanderHostServerId((current) => current ?? saved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedServerId =
    commanderHostServerId && hosts.some((host) => host.serverId === commanderHostServerId)
      ? commanderHostServerId
      : null;

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

  const handleSelectHost = useCallback((serverId: string) => {
    setCommanderHostServerId(serverId);
    setStartError(null);
    void saveCommanderHostServerId(serverId);
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

  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      hosts.map((host) => ({
        id: host.serverId,
        label: host.label,
        value: host.serverId,
      })),
    [hosts],
  );
  const selectedHostDisplay = useMemo(() => {
    const host = hosts.find((item) => item.serverId === selectedServerId);
    return host ? { label: host.label } : null;
  }, [hosts, selectedServerId]);

  const clearDraft = useCallback(() => {
    setDraftText("");
    setDraftAttachments([]);
  }, []);

  const commanderRef = useMemo<MissionControlCommander | null>(
    () =>
      selectedServerId && commander && !commander.archived
        ? { serverId: selectedServerId, agentId: commander.agentId }
        : null,
    [commander, selectedServerId],
  );

  const handleStopCommander = useCallback(() => {
    if (!commanderRef) {
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
  }, [commanderRef, toast]);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings/mission-control");
  }, []);

  const inspectorTarget = useInspectorStore((state) => state.target);

  const composerCwd = commanderAgent?.cwd ?? "~";
  const composerContainerStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  const threadColumn = (() => {
    if (!selectedServerId) {
      return (
        <View style={styles.centerState} testID="mission-control-no-host">
          <Text style={styles.centerStateTitle}>Select a host for the Commander</Text>
          <Text style={styles.centerStateHint}>
            The Commander lives on one host; pick it in the header to start.
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
              isFocused={isFocused}
              verbose={verbose}
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
              value={draftText}
              onChangeText={setDraftText}
              attachments={draftAttachments}
              onChangeAttachments={setDraftAttachments}
              cwd={composerCwd}
              clearDraft={clearDraft}
              submitButtonTestID="mission-control-composer-submit"
            />
          </View>
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

  const hostPicker = useMemo(
    () => (
      <SelectField<string>
        label="Commander host"
        value={selectedServerId ?? null}
        selectedDisplay={selectedHostDisplay}
        options={hostOptions}
        onChange={handleSelectHost}
        placeholder="Select host"
        emptyText="No hosts found"
        field={false}
        size="sm"
        triggerTestID="mission-control-host-picker"
      />
    ),
    [handleSelectHost, hostOptions, selectedHostDisplay, selectedServerId],
  );

  const handleCollapseThread = useCallback(() => {
    setThreadCollapsed((current) => !current);
  }, []);
  const collapseToggleState = useMemo(() => ({ expanded: !threadCollapsed }), [threadCollapsed]);

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
        {v3Enabled && commanderRef ? (
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
        {hostPicker}
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
      collapseToggleState,
      commanderRef,
      handleCollapseThread,
      handleOpenSettings,
      handleStopCommander,
      handleToggleVerbose,
      hostPicker,
      isCompact,
      threadCollapsed,
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
          <View style={styles.inspectorRail}>
            <MissionControlInspector target={inspectorTarget} isFocused={isFocused} />
          </View>
        ) : null}
        <BoardRail>
          <MissionControlBoard
            hideAgentNames={hideAgentNames}
            testID="mission-control-board-rail"
          />
        </BoardRail>
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
  inspectorRail: {
    width: 400,
    minWidth: 0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
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
