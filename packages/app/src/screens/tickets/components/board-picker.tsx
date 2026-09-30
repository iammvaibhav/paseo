import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TicketBoard } from "@getpaseo/protocol/tickets/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { MenuTriggerState } from "@/components/ui/menu";
import { ICON_SIZE } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const PICKER_MIN_WIDTH = 240;

function triggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  return [styles.trigger, hovered || pressed || open ? styles.triggerHighlighted : null];
}

/** Picks one board, or every board (`null`, the all-projects view). Archived boards are hidden. */
export function BoardPicker({
  boards,
  value,
  onChange,
}: {
  boards: readonly TicketBoard[];
  value: string | null;
  onChange: (boardId: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const activeBoards = boards.filter((board) => board.archivedAt === null);
  const current = value === null ? null : boards.find((board) => board.id === value);
  const label = current ? current.name : t("tickets.common.allProjects");
  const selectAll = useCallback(() => onChange(null), [onChange]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("tickets.board.boardPicker")}
        testID="tickets-board-picker"
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.chevron}>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        minWidth={PICKER_MIN_WIDTH}
        testID="tickets-board-picker-menu"
      >
        <DropdownMenuItem selected={value === null} onSelect={selectAll} testID="tickets-board-all">
          {t("tickets.common.allProjects")}
        </DropdownMenuItem>
        {activeBoards.length > 0 ? <DropdownMenuSeparator /> : null}
        {activeBoards.map((board) => (
          <BoardPickerItem
            key={board.id}
            board={board}
            selected={board.id === value}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BoardPickerItem({
  board,
  selected,
  onChange,
}: {
  board: TicketBoard;
  selected: boolean;
  onChange: (boardId: string | null) => void;
}): ReactElement {
  const select = useCallback(() => onChange(board.id), [board.id, onChange]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={board.key}
      onSelect={select}
      testID={`tickets-board-${board.key}`}
    >
      {board.name}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerHighlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  label: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  chevron: {
    flexShrink: 0,
  },
}));
