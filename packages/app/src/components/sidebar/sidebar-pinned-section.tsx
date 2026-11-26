import type { ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

/**
 * The sidebar's Pinned section: its heading, collapse state and spacing. The agent view and both
 * workspaces groupings render this one component, so switching views leaves the section exactly
 * where and how it was. Each view passes its own rows.
 */
export function SidebarPinnedSection({
  children,
  testID = "sidebar-pinned-section",
  headerTestID = "sidebar-pinned-section-header",
}: {
  children: ReactNode;
  testID?: string;
  headerTestID?: string;
}) {
  const { t } = useTranslation();
  const collapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const toggleCollapsed = useSidebarCollapsedSectionsStore((state) => state.togglePinnedCollapsed);
  return (
    <View style={styles.section} testID={testID}>
      <SidebarSectionHeader
        title={t("sidebar.pinned.title")}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        testID={headerTestID}
      />
      {collapsed ? null : children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[1],
  },
}));
