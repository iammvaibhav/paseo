import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Initiative } from "@getpaseo/protocol/tickets/types";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { PriorityIcon, usePriorityLabel } from "../components/priority-icon";
import { InitiativeStatusIcon, ProgressMeter } from "./properties";
import { formatCalendarDate, initiativeProgress } from "./schedule";
import type { InitiativeSection } from "./status";

const ThemedChevronRight = withUnistyles(ChevronRight);

interface InitiativesListProps {
  sections: readonly InitiativeSection[];
  /** Board names by id. Null when the list shows one board, so rows leave the name out. */
  boardNames: ReadonlyMap<string, string> | null;
  onOpen: (initiative: Initiative) => void;
}

/** Initiatives in one card per status, the work in flight first. */
export function InitiativesList({
  sections,
  boardNames,
  onOpen,
}: InitiativesListProps): ReactElement {
  return (
    <View testID="initiatives-list">
      {sections.map((section) => (
        <InitiativeListSection
          key={section.status}
          section={section}
          boardNames={boardNames}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

interface InitiativeListSectionProps extends Omit<InitiativesListProps, "sections"> {
  section: InitiativeSection;
}

function InitiativeListSection({
  section,
  boardNames,
  onOpen,
}: InitiativeListSectionProps): ReactElement {
  const { t } = useTranslation();
  const count = section.initiatives.length;
  const trailing = useMemo(() => <Text style={styles.sectionCount}>{count}</Text>, [count]);
  return (
    <SettingsSection
      title={t(`tickets.initiatives.status.${section.status}`)}
      trailing={trailing}
      testID={`initiatives-section-${section.status}`}
    >
      <View style={settingsStyles.card}>
        {section.initiatives.map((initiative, index) => (
          <InitiativeRow
            key={initiative.id}
            initiative={initiative}
            boardName={boardNames?.get(initiative.boardId) ?? null}
            isFirst={index === 0}
            onOpen={onOpen}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

interface InitiativeRowProps {
  initiative: Initiative;
  boardName: string | null;
  isFirst: boolean;
  onOpen: (initiative: Initiative) => void;
}

function InitiativeRow({
  initiative,
  boardName,
  isFirst,
  onOpen,
}: InitiativeRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const priorityLabel = usePriorityLabel();
  const handlePress = useCallback(() => onOpen(initiative), [initiative, onOpen]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      hovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isCompact, isFirst],
  );

  const target = initiative.targetDate
    ? formatCalendarDate(initiative.targetDate, new Date())
    : null;
  const priority = initiative.priority ? priorityLabel(initiative.priority) : null;
  const progressLabel = t("tickets.initiatives.progress", {
    done: initiative.doneTicketCount,
    total: initiative.ticketCount,
  });
  // Compact rows have no columns, so priority and target move into the second line.
  const compactMeta = [
    priority,
    target && t("tickets.initiatives.targetDate", { date: target }),
    boardName,
  ]
    .filter((part) => Boolean(part))
    .join(" · ");
  const desktopMeta = initiative.description.trim() || boardName;
  const secondLine = isCompact ? compactMeta : desktopMeta;
  const accessibilityLabel = `${t("tickets.initiatives.openInitiative", { title: initiative.title })}, ${progressLabel}`;

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`initiative-row-${initiative.id}`}
    >
      <View style={styles.leading}>
        <InitiativeStatusIcon status={initiative.status} />
      </View>
      <View style={styles.textGroup}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {initiative.title}
        </Text>
        {secondLine ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {secondLine}
          </Text>
        ) : null}
      </View>

      {isCompact ? null : (
        <>
          <View style={styles.priorityCell}>
            <PriorityIcon priority={initiative.priority} />
            <Text style={styles.cellText} numberOfLines={1}>
              {priority ?? t("tickets.initiatives.noPriority")}
            </Text>
          </View>
          <Text style={[styles.cellText, styles.targetCell]} numberOfLines={1}>
            {target ?? t("tickets.initiatives.noTargetDate")}
          </Text>
        </>
      )}

      <View style={styles.progressCell}>
        <ProgressMeter fraction={initiativeProgress(initiative)} />
        <Text style={styles.progressCount}>
          {`${initiative.doneTicketCount}/${initiative.ticketCount}`}
        </Text>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  leading: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  priorityCell: {
    width: theme.spacing[24],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  targetCell: {
    width: theme.spacing[24],
  },
  cellText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progressCell: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  progressCount: {
    minWidth: theme.spacing[8],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
