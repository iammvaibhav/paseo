import { useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { MenuHeader } from "@/components/headers/menu-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

import { WorkBoard } from "@/screens/work/board";
import { WorkPages } from "@/screens/work/pages";
import { WorkDrafts } from "@/screens/work/drafts";
import { WorkStickies } from "@/screens/work/stickies";
import { WorkInspector } from "@/screens/work/inspector";
import { WorkProjectRail } from "@/screens/work/project-rail";
import { useSelectedWorkProjectKey } from "@/screens/work/selection-store";
import { useWorkInspectorTarget } from "@/screens/work/inspector-store";

// Center view tabs. Labels come from i18n work.views.*
type WorkView = "board" | "pages" | "drafts" | "stickies";

function ActiveView({
  view,
  projectKey,
}: {
  view: WorkView;
  projectKey: string | null;
}): ReactElement {
  if (!projectKey) {
    return <EmptyProjectState />;
  }
  switch (view) {
    case "board":
      return <WorkBoard projectKey={projectKey} />;
    case "pages":
      return <WorkPages />;
    case "drafts":
      return <WorkDrafts />;
    case "stickies":
      return <WorkStickies />;
    default:
      return <WorkBoard projectKey={projectKey} />;
  }
}

function EmptyProjectState(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="work-empty-no-project">
      <Text style={styles.centerStateTitle}>{t("work.states.noProject")}</Text>
      <Text style={styles.centerStateHint}>{t("work.states.noProjectHint")}</Text>
    </View>
  );
}

export function WorkScreen(): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const selectedKey = useSelectedWorkProjectKey();
  const { target: inspectorTarget } = useWorkInspectorTarget();
  const [activeView, setActiveView] = useState<WorkView>("board");

  const viewOptions = useMemo(
    () => [
      { value: "board" as const, label: t("work.views.board"), testID: "work-view-tab-board" },
      { value: "pages" as const, label: t("work.views.pages"), testID: "work-view-tab-pages" },
      { value: "drafts" as const, label: t("work.views.drafts"), testID: "work-view-tab-drafts" },
      {
        value: "stickies" as const,
        label: t("work.views.stickies"),
        testID: "work-view-tab-stickies",
      },
    ],
    [t],
  );

  const header = useMemo(() => <MenuHeader title={t("work.screen.title")} />, [t]);

  // Compact: inspector takes full screen when an item is open — mirrors
  // mission-control-screen.tsx:577 inspector branch.
  if (isCompact) {
    if (inspectorTarget) {
      return (
        <View style={styles.container} testID="work-screen">
          <WorkInspector target={inspectorTarget} />
        </View>
      );
    }
    return (
      <View style={styles.container} testID="work-screen">
        {header}
        {/* Project picker instead of permanent rail on compact */}
        <View style={styles.compactRailWrap}>
          <WorkProjectRail compact />
        </View>
        <View style={styles.compactToggle}>
          <SegmentedControl<WorkView>
            options={viewOptions}
            value={activeView}
            onValueChange={setActiveView}
            size="sm"
            testID="work-view-tabs"
          />
        </View>
        <View style={styles.compactBody}>
          <ActiveView view={activeView} projectKey={selectedKey} />
        </View>
      </View>
    );
  }

  // Desktop: three regions — rail | center | inspector
  return (
    <View style={styles.container} testID="work-screen">
      {header}
      <View style={styles.desktopBody}>
        <View style={styles.railColumn} testID="work-project-rail-wrap">
          <WorkProjectRail />
        </View>
        <View style={styles.centerColumn}>
          <View style={styles.viewTabsRow}>
            <SegmentedControl<WorkView>
              options={viewOptions}
              value={activeView}
              onValueChange={setActiveView}
              size="sm"
              testID="work-view-tabs"
            />
          </View>
          <View style={styles.centerBody}>
            <ActiveView view={activeView} projectKey={selectedKey} />
          </View>
        </View>
        {inspectorTarget ? (
          <View style={styles.inspectorColumn} testID="work-inspector-rail">
            <WorkInspector target={inspectorTarget} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  desktopBody: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  railColumn: {
    width: 260,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  viewTabsRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  centerBody: {
    flex: 1,
    minHeight: 0,
  },
  inspectorColumn: {
    width: 380,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  compactToggle: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  compactPicker: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  compactPickerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  compactRailWrap: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    maxHeight: 220,
  },
  compactBody: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  centerStateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  centerStateHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
