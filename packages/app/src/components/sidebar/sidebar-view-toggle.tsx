import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Bot, FolderKanban } from "lucide-react-native";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useSidebarViewStore, type SidebarViewMode } from "@/stores/sidebar-view-store";

export function SidebarViewToggle(): ReactElement {
  const { t } = useTranslation();
  const viewMode = useSidebarViewStore((state) => state.viewMode);
  const setViewMode = useSidebarViewStore((state) => state.setViewMode);

  const options = useMemo<SegmentedControlOption<SidebarViewMode>[]>(
    () => [
      {
        value: "workspaces",
        label: t("sidebar.view.workspaces"),
        icon: ({ color, size }) => <FolderKanban color={color} size={size} />,
        testID: "sidebar-view-toggle-workspaces",
      },
      {
        value: "agents",
        label: t("sidebar.view.agents"),
        icon: ({ color, size }) => <Bot color={color} size={size} />,
        testID: "sidebar-view-toggle-agents",
      },
    ],
    [t],
  );

  return (
    <SegmentedControl
      size="xs"
      hideLabels
      value={viewMode}
      onValueChange={setViewMode}
      options={options}
      testID="sidebar-view-toggle"
    />
  );
}
