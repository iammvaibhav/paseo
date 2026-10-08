import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  SectionList,
  Text,
  View,
  type PressableStateCallbackType,
  type SectionListData,
  type SectionListRenderItemInfo,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TicketColumn, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { SPACING } from "@/styles/theme";
import type { BoardLane } from "./board-model";
import { AssigneeAvatar } from "./components/assignee-avatar";
import { ColumnHeader } from "./components/column-header";
import { PriorityIcon } from "./components/priority-icon";
import { RunChip } from "./components/run-chip";
import { StatusIcon } from "./components/status-icon";
import { TicketKey } from "./components/ticket-key";

// Theme-free: SectionList's content container is not the tracked style prop.
const LIST_CONTENT_STYLE = {
  paddingHorizontal: SPACING[3],
  paddingBottom: SPACING[6],
} as const;
const ROW_AVATAR_SIZE = 18;

interface LaneSection {
  lane: BoardLane;
  data: TicketSummary[];
}

export interface BoardListProps {
  lanes: readonly BoardLane[];
  columnById: ReadonlyMap<string, TicketColumn>;
  boardNameById: ReadonlyMap<string, string> | null;
  onOpenTicket: (ticket: TicketSummary) => void;
  onAddToLane: ((lane: BoardLane) => void) | null;
}

function ticketKeyExtractor(ticket: TicketSummary): string {
  return ticket.id;
}

export function BoardList({
  lanes,
  columnById,
  boardNameById,
  onOpenTicket,
  onAddToLane,
}: BoardListProps): ReactElement {
  const sections = useMemo<LaneSection[]>(
    () => lanes.map((lane) => ({ lane, data: lane.tickets })),
    [lanes],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<TicketSummary, LaneSection> }) => (
      <LaneSectionHeader lane={section.lane} onAddToLane={onAddToLane} />
    ),
    [onAddToLane],
  );

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<TicketSummary, LaneSection>) => (
      <TicketRow
        ticket={item}
        column={columnById.get(item.columnId) ?? null}
        boardName={boardNameById?.get(item.boardId) ?? null}
        onPress={onOpenTicket}
      />
    ),
    [boardNameById, columnById, onOpenTicket],
  );

  return (
    <SectionList
      sections={sections}
      keyExtractor={ticketKeyExtractor}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={LIST_CONTENT_STYLE}
      style={styles.list}
      initialNumToRender={24}
      testID="tickets-board-list"
    />
  );
}

function LaneSectionHeader({
  lane,
  onAddToLane,
}: {
  lane: BoardLane;
  onAddToLane: ((lane: BoardLane) => void) | null;
}): ReactElement {
  const add = useCallback(() => onAddToLane?.(lane), [lane, onAddToLane]);
  return (
    <View style={styles.sectionHeader}>
      <ColumnHeader
        name={lane.name}
        stateType={lane.stateType}
        count={lane.tickets.length}
        onAdd={onAddToLane ? add : undefined}
      />
    </View>
  );
}

function rowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, hovered || pressed ? styles.rowHighlighted : null];
}

const TicketRow = memo(function TicketRow({
  ticket,
  column,
  boardName,
  onPress,
}: {
  ticket: TicketSummary;
  column: TicketColumn | null;
  boardName: string | null;
  onPress: (ticket: TicketSummary) => void;
}): ReactElement {
  const { t } = useTranslation();
  const press = useCallback(() => onPress(ticket), [onPress, ticket]);
  const updatedAt = useMemo(() => new Date(ticket.updatedAt), [ticket.updatedAt]);
  const updated = useCompactTimeAgo(updatedAt);
  const run = ticket.latestRun && !ticket.latestRun.archived ? ticket.latestRun : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("tickets.board.openTicket", { key: ticket.key })}
      onPress={press}
      style={rowStyle}
      testID={`ticket-row-${ticket.key}`}
    >
      <View style={styles.rowLeading}>
        <PriorityIcon priority={ticket.priority} />
      </View>
      <TicketKey ticketKey={ticket.key} />
      {column ? <StatusIcon stateType={column.stateType} /> : null}
      <Text style={styles.title} numberOfLines={1}>
        {ticket.title}
      </Text>
      {ticket.openBlockerCount > 0 ? (
        <Text style={styles.blocked} numberOfLines={1}>
          {t("tickets.common.blocked")}
        </Text>
      ) : null}
      {ticket.subtaskCount > 0 ? (
        <Text style={styles.meta}>{`${ticket.subtaskDoneCount}/${ticket.subtaskCount}`}</Text>
      ) : null}
      {boardName ? (
        <Text style={styles.meta} numberOfLines={1}>
          {boardName}
        </Text>
      ) : null}
      {run ? (
        <View style={styles.run}>
          <RunChip run={run} />
        </View>
      ) : null}
      <AssigneeAvatar assignee={ticket.assignee} size={ROW_AVATAR_SIZE} />
      <Text style={styles.updated}>{updated}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  sectionHeader: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: theme.spacing[8] + theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  // Reserves the priority slot so keys line up whether a ticket has one or not.
  rowLeading: {
    width: theme.iconSize.sm,
    alignItems: "center",
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  blocked: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  meta: {
    flexShrink: 0,
    maxWidth: 160,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  run: {
    flexShrink: 1,
    maxWidth: 180,
  },
  updated: {
    minWidth: theme.spacing[8],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
