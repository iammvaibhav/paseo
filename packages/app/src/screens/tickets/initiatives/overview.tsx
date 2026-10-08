import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  Initiative,
  TicketColumnStateType,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { RunChip } from "../components/run-chip";
import { StatusIcon } from "../components/status-icon";
import { TicketKey } from "../components/ticket-key";
import { ProgressMeter } from "./properties";
import { deriveSchedule, formatCalendarDate } from "./schedule";
import { TICKET_STATE_TYPES, type ActiveTicket } from "./ticket-groups";

interface InitiativeOverviewProps {
  initiative: Initiative;
  stateCounts: Record<TicketColumnStateType, number>;
  /** Column state of each ticket id, for the status glyph of an active-work row. */
  stateByTicketId: ReadonlyMap<string, TicketColumnStateType>;
  activeWork: readonly ActiveTicket[];
  onOpenTicket: (ticket: TicketSummary) => void;
}

/** The reading view of one initiative: what it is for, how far it got, what runs now. */
export function InitiativeOverview({
  initiative,
  stateCounts,
  stateByTicketId,
  activeWork,
  onOpenTicket,
}: InitiativeOverviewProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const description = initiative.description.trim();

  return (
    <View style={styles.column}>
      <Text
        style={description ? styles.description : styles.descriptionEmpty}
        selectable={description.length > 0}
        testID="initiative-description"
      >
        {description || t("tickets.initiatives.detail.noDescription")}
      </Text>

      <View style={isCompact ? styles.stack : styles.pair}>
        <View style={styles.pairItem}>
          <SettingsSection title={t("tickets.initiatives.detail.progressHeading")} flush>
            <StateBreakdown counts={stateCounts} />
          </SettingsSection>
        </View>
        <View style={styles.pairItem}>
          <SettingsSection title={t("tickets.initiatives.detail.timelineHeading")} flush>
            <Timeline initiative={initiative} />
          </SettingsSection>
        </View>
      </View>

      <SettingsSection title={t("tickets.initiatives.detail.activeWork")} flush>
        <View style={settingsStyles.card} testID="initiative-active-work">
          {activeWork.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={styles.muted}>{t("tickets.initiatives.detail.noActiveWork")}</Text>
            </View>
          ) : (
            activeWork.map((entry, index) => (
              <ActiveWorkRow
                key={entry.ticket.id}
                entry={entry}
                stateType={stateByTicketId.get(entry.ticket.id) ?? null}
                isFirst={index === 0}
                onOpenTicket={onOpenTicket}
              />
            ))
          )}
        </View>
      </SettingsSection>
    </View>
  );
}

function StateBreakdown({
  counts,
}: {
  counts: Record<TicketColumnStateType, number>;
}): ReactElement {
  const { t } = useTranslation();
  const total = TICKET_STATE_TYPES.reduce((sum, stateType) => sum + counts[stateType], 0);
  if (total === 0) {
    return (
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <Text style={styles.muted}>{t("tickets.initiatives.detail.noTickets")}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={settingsStyles.card} testID="initiative-state-breakdown">
      {TICKET_STATE_TYPES.map((stateType, index) => (
        <View
          key={stateType}
          style={[settingsStyles.row, styles.denseRow, index > 0 && settingsStyles.rowBorder]}
        >
          <View style={styles.rowLabel}>
            <StatusIcon stateType={stateType} />
            <Text style={styles.label}>{t(`tickets.common.stateType.${stateType}`)}</Text>
          </View>
          <Text style={styles.value}>{counts[stateType]}</Text>
        </View>
      ))}
    </View>
  );
}

function Timeline({ initiative }: { initiative: Initiative }): ReactElement {
  const { t } = useTranslation();
  const now = new Date();
  const schedule = deriveSchedule(initiative, now);
  const start = initiative.startDate ? formatCalendarDate(initiative.startDate, now) : null;
  const target = initiative.targetDate ? formatCalendarDate(initiative.targetDate, now) : null;

  let remaining: string | null = null;
  if (schedule.daysLeft !== null) {
    if (schedule.daysLeft < 0) {
      remaining = t("tickets.initiatives.detail.overdue", { count: -schedule.daysLeft });
    } else if (schedule.daysLeft === 0) {
      remaining = t("tickets.initiatives.detail.dueToday");
    } else {
      remaining = t("tickets.initiatives.detail.daysLeft", { count: schedule.daysLeft });
    }
  }
  const isOverdue = schedule.daysLeft !== null && schedule.daysLeft < 0;

  return (
    <View style={settingsStyles.card} testID="initiative-timeline">
      <View style={[settingsStyles.row, styles.denseRow]}>
        <Text style={styles.label}>{t("tickets.initiatives.detail.start")}</Text>
        <Text style={styles.value}>{start ?? "—"}</Text>
      </View>
      <View style={[settingsStyles.row, styles.denseRow, settingsStyles.rowBorder]}>
        <Text style={styles.label}>{t("tickets.initiatives.detail.target")}</Text>
        <Text style={styles.value}>{target ?? "—"}</Text>
      </View>
      {remaining ? (
        <View style={[settingsStyles.row, styles.denseRow, settingsStyles.rowBorder]}>
          <Text style={styles.label}>{t("tickets.initiatives.detail.remaining")}</Text>
          <Text style={isOverdue ? styles.valueDanger : styles.value}>{remaining}</Text>
        </View>
      ) : null}
      <View style={[settingsStyles.row, styles.meters, settingsStyles.rowBorder]}>
        {schedule.elapsed === null ? (
          <Text style={styles.muted}>{t("tickets.initiatives.detail.setTargetDate")}</Text>
        ) : (
          <>
            <Meter
              label={t("tickets.initiatives.detail.timeElapsed")}
              fraction={schedule.elapsed}
            />
            <Meter label={t("tickets.initiatives.detail.workDone")} fraction={schedule.workDone} />
          </>
        )}
      </View>
    </View>
  );
}

function Meter({ label, fraction }: { label: string; fraction: number }): ReactElement {
  return (
    <View style={styles.meter}>
      <View style={styles.meterLabels}>
        <Text style={styles.muted}>{label}</Text>
        <Text style={styles.meterPercent}>{`${Math.round(fraction * 100)}%`}</Text>
      </View>
      <ProgressMeter fraction={fraction} wide />
    </View>
  );
}

interface ActiveWorkRowProps {
  entry: ActiveTicket;
  stateType: TicketColumnStateType | null;
  isFirst: boolean;
  onOpenTicket: (ticket: TicketSummary) => void;
}

function ActiveWorkRow({
  entry,
  stateType,
  isFirst,
  onOpenTicket,
}: ActiveWorkRowProps): ReactElement {
  const { t } = useTranslation();
  const { ticket, run } = entry;
  const handlePress = useCallback(() => onOpenTicket(ticket), [onOpenTicket, ticket]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      styles.activeRow,
      !isFirst && settingsStyles.rowBorder,
      (hovered || pressed) && styles.rowHighlighted,
    ],
    [isFirst],
  );
  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("tickets.board.openTicket", { key: ticket.key })}
      testID={`initiative-active-${ticket.key}`}
    >
      {stateType ? <StatusIcon stateType={stateType} /> : null}
      <TicketKey ticketKey={ticket.key} />
      <Text style={styles.activeTitle} numberOfLines={1}>
        {ticket.title}
      </Text>
      <RunChip run={run} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    gap: theme.spacing[8],
  },
  description: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.6),
  },
  descriptionEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  pair: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  stack: {
    gap: theme.spacing[8],
  },
  pairItem: {
    flex: 1,
    minWidth: 0,
  },
  denseRow: {
    paddingVertical: theme.spacing[3],
  },
  rowLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  valueDanger: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  meters: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  meter: {
    gap: theme.spacing[1.5],
  },
  meterLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  meterPercent: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  activeRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surface2,
  },
  activeTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
