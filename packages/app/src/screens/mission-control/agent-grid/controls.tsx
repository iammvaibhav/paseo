import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import {
  isToolbarLabelTriggerHighlighted,
  ToolbarLabelTriggerIcon,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
} from "@/components/ui/toolbar-label-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AgentGridDirection } from "./layout";
import { AGENT_GRID_VISIBLE_COUNT_OPTIONS, useAgentGridStore } from "./store";

const ThemedChevronDown = withUnistyles(ChevronDown);

const DIRECTION_OPTIONS: SegmentedControlOption<AgentGridDirection>[] = [
  {
    value: "horizontal",
    label: "Horizontal",
    testID: "mission-control-agent-grid-direction-horizontal",
  },
  { value: "vertical", label: "Vertical", testID: "mission-control-agent-grid-direction-vertical" },
];

function countLabel(count: number): string {
  return `${count} per screen`;
}

/**
 * Header controls for the Agent Grid: scroll direction, and on desktop the
 * tiles-per-screen count. A phone always shows one tile, so it gets no count.
 */
export function AgentGridControls(): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const { visibleCount, direction, setVisibleCount, setDirection } = useAgentGridStore(
    useShallow((state) => ({
      visibleCount: state.visibleCount,
      direction: state.direction,
      setVisibleCount: state.setVisibleCount,
      setDirection: state.setDirection,
    })),
  );
  const countHandlers = useMemo(() => {
    const handlers: Record<number, () => void> = {};
    for (const count of AGENT_GRID_VISIBLE_COUNT_OPTIONS) {
      handlers[count] = () => setVisibleCount(count);
    }
    return handlers;
  }, [setVisibleCount]);

  return (
    <View style={styles.row}>
      <SegmentedControl<AgentGridDirection>
        options={DIRECTION_OPTIONS}
        value={direction}
        onValueChange={setDirection}
        size="sm"
        testID="mission-control-agent-grid-direction"
      />
      {isCompact ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            style={toolbarLabelTriggerStyle}
            accessibilityRole="button"
            accessibilityLabel="Tiles per screen"
            testID="mission-control-agent-grid-count"
          >
            {(state) => {
              const highlighted = isToolbarLabelTriggerHighlighted(state);
              return (
                <>
                  <Text style={toolbarLabelTriggerTextStyle(highlighted)} numberOfLines={1}>
                    {countLabel(visibleCount)}
                  </Text>
                  <ToolbarLabelTriggerIcon>
                    <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
                  </ToolbarLabelTriggerIcon>
                </>
              );
            }}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={180}>
            {AGENT_GRID_VISIBLE_COUNT_OPTIONS.map((count) => (
              <DropdownMenuItem
                key={count}
                selected={count === visibleCount}
                onSelect={countHandlers[count]}
                testID={`mission-control-agent-grid-count-${count}`}
              >
                {countLabel(count)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
