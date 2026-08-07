import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { MenuHeader } from "@/components/headers/menu-header";
import { Composer } from "@/composer";
import type { UserComposerAttachment } from "@/attachments/types";
import { MissionControlBoard } from "@/screens/mission-control/board";
import {
  MissionControlThread,
  type MissionControlCommander,
} from "@/screens/mission-control/thread";
import { useAggregatedMissionControlEvents } from "@/hooks/use-aggregated-mission-control-events";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useShallow } from "zustand/react/shallow";
import {
  isCommanderAgent,
  launchCommander,
  loadCommanderHostServerId,
  saveCommanderHostServerId,
} from "@/mission-control/launch";
import { useIsCompactFormFactor } from "@/constants/layout";

type CompactPanel = "thread" | "board";

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
  const isFocused = useIsFocused();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const { events } = useAggregatedMissionControlEvents();
  const [commanderHostServerId, setCommanderHostServerId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [recreatingArchivedId, setRecreatingArchivedId] = useState<string | null>(null);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>("thread");
  const [draftText, setDraftText] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<UserComposerAttachment[]>([]);

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

  const startCommander = useCallback(async (serverId: string) => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error("Host is not connected");
    }
    await launchCommander({ client, serverId });
  }, []);

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
            <MissionControlThread events={events} commander={commanderRef} />
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

  const header = <MenuHeader title="Mission Control" rightContent={hostPicker} />;

  if (isCompact) {
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
            <MissionControlBoard testID="mission-control-board-panel" />
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.desktopBody}>
        <View style={styles.threadColumn}>{threadColumn}</View>
        <View style={styles.boardRail}>
          <MissionControlBoard testID="mission-control-board-rail" />
        </View>
      </View>
    </View>
  );
}

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
  boardRail: {
    width: 300,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
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
