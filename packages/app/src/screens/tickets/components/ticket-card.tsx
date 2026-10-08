import { memo, useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Ban, ListTree, MessageSquare, Paperclip, Timer } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TicketColumn, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { StatusBadge } from "@/components/ui/status-badge";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import type { Theme } from "@/styles/theme";
import { AssigneeAvatar } from "./assignee-avatar";
import { PriorityIcon } from "./priority-icon";
import { RunChip } from "./run-chip";
import { StatusIcon } from "./status-icon";
import { TicketKey } from "./ticket-key";

const ThemedBan = withUnistyles(Ban);
const ThemedListTree = withUnistyles(ListTree);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedTimer = withUnistyles(Timer);
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const CHIP_ICON_SIZE = 10;
const TIMER_ICON = <ThemedTimer size={CHIP_ICON_SIZE} uniProps={mutedIconColorMapping} />;
const BAN_ICON = <ThemedBan size={CHIP_ICON_SIZE} uniProps={dangerColorMapping} />;
const LIST_TREE_ICON = <ThemedListTree size={CHIP_ICON_SIZE} uniProps={mutedIconColorMapping} />;
const MESSAGE_ICON = <ThemedMessageSquare size={CHIP_ICON_SIZE} uniProps={mutedIconColorMapping} />;
const PAPERCLIP_ICON = <ThemedPaperclip size={CHIP_ICON_SIZE} uniProps={mutedIconColorMapping} />;

export interface TicketCardProps {
  ticket: TicketSummary;
  column: TicketColumn | null;
  /** Shown as a chip in the all-projects view, where lanes mix boards. */
  boardName?: string | null;
  onPress: (ticket: TicketSummary) => void;
}

function cardStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.card, hovered || pressed ? styles.cardHighlighted : null];
}

export const TicketCard = memo(function TicketCard({
  ticket,
  column,
  boardName,
  onPress,
}: TicketCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const press = useCallback(() => onPress(ticket), [onPress, ticket]);
  const createdAt = useMemo(() => new Date(ticket.createdAt), [ticket.createdAt]);
  const age = useCompactTimeAgo(createdAt);
  const shortDate = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }),
    [i18n.language],
  );
  const createdUpdated = t("tickets.common.createdUpdated", {
    created: shortDate.format(createdAt),
    updated: shortDate.format(new Date(ticket.updatedAt)),
  });
  const isBlocked = ticket.openBlockerCount > 0;
  const run = ticket.latestRun && !ticket.latestRun.archived ? ticket.latestRun : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("tickets.board.openTicket", { key: ticket.key })}
      onPress={press}
      style={cardStyle}
      testID={`ticket-card-${ticket.key}`}
    >
      <View style={styles.topRow}>
        <View style={styles.keyRow}>
          <TicketKey ticketKey={ticket.key} />
          {boardName ? <Chip label={boardName} /> : null}
        </View>
        <PriorityIcon priority={ticket.priority} />
      </View>

      <View style={styles.titleRow}>
        {column ? (
          <View style={styles.statusIcon}>
            <StatusIcon stateType={column.stateType} />
          </View>
        ) : null}
        <Text style={styles.title} numberOfLines={2}>
          {ticket.title}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Chip label={age} accessibilityLabel={t("tickets.common.age", { age })} icon={TIMER_ICON} />
        {ticket.type ? <Chip label={ticket.type} /> : null}
        {isBlocked ? (
          <View
            accessible
            accessibilityLabel={t("tickets.common.blockedBy", { count: ticket.openBlockerCount })}
          >
            <StatusBadge label={t("tickets.common.blocked")} variant="error" leading={BAN_ICON} />
          </View>
        ) : null}
        {ticket.subtaskCount > 0 ? (
          <Chip
            label={`${ticket.subtaskDoneCount}/${ticket.subtaskCount}`}
            accessibilityLabel={t("tickets.common.subtaskProgress", {
              done: ticket.subtaskDoneCount,
              total: ticket.subtaskCount,
            })}
            icon={LIST_TREE_ICON}
          />
        ) : null}
        {ticket.commentCount > 0 ? (
          <Chip
            label={String(ticket.commentCount)}
            accessibilityLabel={t("tickets.common.comments", { count: ticket.commentCount })}
            icon={MESSAGE_ICON}
          />
        ) : null}
        {ticket.attachmentCount > 0 ? (
          <Chip
            label={String(ticket.attachmentCount)}
            accessibilityLabel={t("tickets.common.attachments", { count: ticket.attachmentCount })}
            icon={PAPERCLIP_ICON}
          />
        ) : null}
      </View>

      {run ? <RunChip run={run} /> : null}

      <View style={styles.footer}>
        <Text style={styles.dates} numberOfLines={1}>
          {createdUpdated}
        </Text>
        <AssigneeAvatar assignee={ticket.assignee} />
      </View>
    </Pressable>
  );
});

function Chip({
  label,
  icon,
  accessibilityLabel,
}: {
  label: string;
  icon?: ReactNode;
  accessibilityLabel?: string;
}): ReactElement {
  return (
    <View
      style={styles.chip}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {icon}
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  cardHighlighted: {
    backgroundColor: theme.colors.surface3,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    flexShrink: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
  },
  // Optical: centres the 14pt glyph on the first line of the title.
  statusIcon: {
    paddingTop: theme.spacing[0.5],
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: theme.spacing[6],
  },
  dates: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
