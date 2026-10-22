import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMissionControlActive } from "@/screens/mission-control/focus-context";
import { PanelRightClose, PanelRightOpen, Plus, RotateCw } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { MenuHeader } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { MissionControlBoard } from "@/screens/mission-control/board";
import { MissionControlInspector } from "@/screens/mission-control/inspector";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { MissionControlAgentGrid } from "@/screens/mission-control/agent-grid/grid";
import {
  useAgentGridStore,
  type MissionControlView,
} from "@/screens/mission-control/agent-grid/store";
import { useGridNewAgentAction } from "@/hooks/use-grid-new-agent-action";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { scrollAgentGridToOrigin } from "@/screens/mission-control/agent-grid/grid-glow";
import { buildAgentGridItems } from "@/screens/mission-control/agent-grid/items";
import { InspectorRail } from "@/mission-control/inspector-rail";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useShallow } from "zustand/react/shallow";
import { useIsCompactFormFactor } from "@/constants/layout";

const VIEW_OPTIONS: SegmentedControlOption<MissionControlView>[] = [
  { value: "board", label: "Board", testID: "mission-control-view-board" },
  { value: "grid", label: "Agent Grid", testID: "mission-control-view-grid" },
];

const ThemedPlus = withUnistyles(Plus);
const ThemedPanelRightClose = withUnistyles(PanelRightClose);
const ThemedPanelRightOpen = withUnistyles(PanelRightOpen);
const ThemedRotateCw = withUnistyles(RotateCw);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface MissionControlHeaderActionsProps {
  view: MissionControlView;
  onViewChange: (view: MissionControlView) => void;
  isGridView: boolean;
  isCompact: boolean;
  inspectorOpen: boolean;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
  onRefreshGrid: () => void;
  onNewAgent: () => void;
}

function MissionControlHeaderActions({
  view,
  onViewChange,
  isGridView,
  isCompact,
  inspectorOpen,
  inspectorCollapsed,
  onToggleInspector,
  onRefreshGrid,
  onNewAgent,
}: MissionControlHeaderActionsProps): ReactElement {
  const toggleState = useMemo(() => ({ expanded: !inspectorCollapsed }), [inspectorCollapsed]);
  return (
    <View style={styles.headerActions}>
      <SegmentedControl<MissionControlView>
        options={VIEW_OPTIONS}
        value={view}
        onValueChange={onViewChange}
        size="sm"
        testID="mission-control-view-toggle"
      />
      {isGridView ? (
        <>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedRotateCw}
            onPress={onRefreshGrid}
            testID="mission-control-grid-refresh"
          >
            Refresh
          </Button>
          <Button
            variant="default"
            size="sm"
            leftIcon={ThemedPlus}
            onPress={onNewAgent}
            testID="mission-control-new-agent"
          >
            New agent
          </Button>
        </>
      ) : null}
      {!isGridView && !isCompact && inspectorOpen ? (
        <HeaderToggleButton
          onPress={onToggleInspector}
          tooltipLabel={inspectorCollapsed ? "Expand inspector" : "Collapse inspector"}
          tooltipKeys={[]}
          tooltipSide="bottom"
          accessibilityRole="button"
          accessibilityLabel={inspectorCollapsed ? "Expand inspector" : "Collapse inspector"}
          accessibilityState={toggleState}
          testID="mission-control-inspector-collapse-toggle"
        >
          {({ hovered, pressed }) => {
            const iconProps = hovered || pressed ? foregroundMapping : foregroundMutedMapping;
            return inspectorCollapsed ? (
              <ThemedPanelRightOpen size={16} uniProps={iconProps} />
            ) : (
              <ThemedPanelRightClose size={16} uniProps={iconProps} />
            );
          }}
        </HeaderToggleButton>
      ) : null}
    </View>
  );
}

/**
 * Mission Control: the fleet board (every host's agents by lifecycle bucket,
 * with the agent inspector) and the Agent Grid. The Commander that used to run
 * the fleet from a thread here is a role now (OPERATING.md), held by a bot that
 * talks to the fleet MCP tools.
 */
export function MissionControlScreen(): ReactElement {
  const isFocused = useMissionControlActive();
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const { view, setView } = useAgentGridStore(
    useShallow((state) => ({ view: state.view, setView: state.setView })),
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const { config: missionControlConfig } = useMissionControlCentralConfig();
  const hideAgentNames = missionControlConfig?.hideAgentNames === true;
  // The inspector needs a v3 daemon; the first host decides, like the board's own fetches.
  const inspectorEnabled = useHostFeature(hosts[0]?.serverId ?? null, "missionControlV3");
  const inspectorTarget = useInspectorStore((state) => state.target);
  const inspectorOpen = inspectorEnabled && inspectorTarget !== null;
  const isGridView = view === "grid";

  const handleNewAgent = useCallback(() => {
    useAgentGridStore.getState().setDraft({
      id: crypto.randomUUID(),
      serverId: null,
      workspaceId: null,
      projectKey: null,
    });
  }, []);

  const { rows } = useMissionControlLifecycle({ enabled: isFocused });

  const handleRefreshGrid = useCallback(() => {
    const nextKeys = buildAgentGridItems(rows).map((item) => item.key);
    const keySet = new Set(nextKeys);
    const store = useAgentGridStore.getState();
    store.clearDraft();
    store.setPinSlot(null);
    if (store.glowKey && !keySet.has(store.glowKey)) {
      store.setGlow(null);
    }
    if (store.activeKey && !keySet.has(store.activeKey)) {
      store.setActiveKey(null);
    }
    scrollAgentGridToOrigin();
    store.enterGrid(nextKeys);
  }, [rows]);

  useGridNewAgentAction({ isGridView, isFocused, onNewAgent: handleNewAgent });

  const handleToggleInspector = useCallback(() => {
    setInspectorCollapsed((current) => !current);
  }, []);

  const headerRightContent = useMemo(
    () => (
      <MissionControlHeaderActions
        view={view}
        onViewChange={setView}
        isGridView={isGridView}
        isCompact={isCompact}
        inspectorOpen={inspectorOpen}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={handleToggleInspector}
        onRefreshGrid={handleRefreshGrid}
        onNewAgent={handleNewAgent}
      />
    ),
    [
      handleNewAgent,
      handleRefreshGrid,
      handleToggleInspector,
      inspectorCollapsed,
      inspectorOpen,
      isCompact,
      isGridView,
      setView,
      view,
    ],
  );

  const header = useMemo(
    () => <MenuHeader title="Mission Control" rightContent={headerRightContent} />,
    [headerRightContent],
  );

  if (isCompact && inspectorOpen && !isGridView) {
    return (
      <View style={styles.container}>
        <MissionControlInspector target={inspectorTarget} isFocused={isFocused} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      {isGridView ? (
        <View style={styles.body}>
          <MissionControlAgentGrid isFocused={isFocused} />
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.boardColumn}>
            <MissionControlBoard hideAgentNames={hideAgentNames} testID="mission-control-board" />
          </View>
          {inspectorOpen && !inspectorCollapsed ? (
            <InspectorRail key="inspector-rail" flexFill={false}>
              <MissionControlInspector target={inspectorTarget} isFocused={isFocused} />
            </InspectorRail>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    flexDirection: "row",
  },
  boardColumn: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
