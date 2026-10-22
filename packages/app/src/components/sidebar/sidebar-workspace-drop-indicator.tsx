import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FolderPlus } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedFolderPlus = withUnistyles(FolderPlus);
const primaryColorMapping = (theme: Theme) => ({ color: theme.colors.primary });

/**
 * Covers a sidebar workspace row while an agent tab is dragged over it. The
 * row itself cannot show the state: the drag lives in the workspace's
 * `DndContext`, and the sidebar sits outside it.
 */
export function SidebarWorkspaceAgentDropIndicator({ workspaceKey }: { workspaceKey: string }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.dropIndicator}
      pointerEvents="none"
      testID={`sidebar-workspace-drop-indicator-${workspaceKey}`}
    >
      <ThemedFolderPlus size={14} uniProps={primaryColorMapping} />
      <Text style={styles.dropIndicatorText}>{t("sidebar.workspace.actions.dropToMoveAgent")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dropIndicator: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
    borderStyle: "dashed",
    backgroundColor: theme.colors.surfaceSidebarHover,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    zIndex: 10,
  },
  dropIndicatorText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
}));
