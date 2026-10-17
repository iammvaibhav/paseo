import { memo, useCallback, type ReactElement } from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react-native";
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const backIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import {
  requestAgentGridScroll,
  triggerAgentGridGlow,
} from "@/screens/mission-control/agent-grid/grid-glow";
import { buildMissionControlRoute } from "@/utils/host-routes";

export interface BackToGridButtonProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Header button shown at the far-left of workspace screens when navigated
 * from the Mission Control Agent Grid.
 *
 * Direct navigation to the workspace renders nothing.
 * Clicking returns to Mission Control grid view, focuses and glows the agent tile,
 * and clears the navigatedFromGrid store entry.
 */
export const BackToGridButton = memo(function BackToGridButton({
  style,
  testID = "workspace-back-to-grid",
}: BackToGridButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();

  const navigatedFromGrid = useAgentGridStore((state) => state.navigatedFromGrid);

  const handlePress = useCallback(() => {
    const store = useAgentGridStore.getState();
    const current = store.navigatedFromGrid;
    if (!current) {
      return;
    }

    const { serverId, agentId } = current;
    const key = `${serverId}:${agentId}`;

    if (typeof store.setView === "function") {
      store.setView("grid");
    }

    if (typeof store.setActiveKey === "function") {
      store.setActiveKey(key);
    }

    triggerAgentGridGlow(key, 3500);

    if (typeof store.setNavigatedFromGrid === "function") {
      store.setNavigatedFromGrid(null);
    }

    requestAgentGridScroll(key);
    router.push(buildMissionControlRoute());
  }, [router]);

  if (!navigatedFromGrid) {
    return null;
  }

  const label = t("common.actions.backToGrid", { defaultValue: "Back to grid" });

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={label}
      tooltipKeys={[]}
      tooltipSide="bottom"
      testID={testID}
      style={style}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <ThemedArrowLeft
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={backIconMapping}
      />
    </HeaderToggleButton>
  );
});
