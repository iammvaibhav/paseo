import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { CalendarDays, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  Initiative,
  InitiativeStatus,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { MenuTriggerState } from "@/components/ui/menu";
import {
  isToolbarLabelTriggerHighlighted,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
  type ToolbarLabelTriggerState,
} from "@/components/ui/toolbar-label-trigger";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { InitiativePriorityMenu, InitiativeStatusMenu, ProgressMeter } from "./properties";
import { formatCalendarDate, initiativeProgress } from "./schedule";

const ThemedCalendarDays = withUnistyles(CalendarDays);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const editLeading = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const deleteLeading = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;
const calendarGlyph = <ThemedCalendarDays size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const MENU_WIDTH = 220;

interface InitiativeActionsMenuProps {
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

/** The kebab of the detail header: edit and delete. */
export function InitiativeActionsMenu({
  deleting,
  onEdit,
  onDelete,
}: InitiativeActionsMenuProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const glyphSize = iconButtonChromeGlyphSize("small", isCompact);
  const triggerStyle = useCallback(
    (state: MenuTriggerState) =>
      iconButtonChromeStyle({ size: "small", compact: isCompact, state }),
    [isCompact],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        disabled={deleting}
        hitSlop={8}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("tickets.initiatives.detail.actions")}
        testID="initiative-actions"
      >
        {({ hovered }: MenuTriggerState) =>
          deleting ? (
            <ThemedLoadingSpinner size={glyphSize} uniProps={mutedIconColorMapping} />
          ) : (
            <ThemedMoreVertical
              size={glyphSize}
              uniProps={hovered ? foregroundColorMapping : mutedIconColorMapping}
            />
          )
        }
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={MENU_WIDTH}>
        <DropdownMenuItem leading={editLeading} onSelect={onEdit} testID="initiative-action-edit">
          {t("tickets.initiatives.detail.edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          onSelect={onDelete}
          testID="initiative-action-delete"
        >
          {t("tickets.initiatives.detail.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface InitiativePropertiesBarProps {
  initiative: Initiative;
  /** The status and priority to show. They lead the stored values while a change is saved. */
  status: InitiativeStatus;
  priority: TicketPriority | null;
  pending: boolean;
  boardName: string | null;
  onStatusChange: (status: InitiativeStatus) => void;
  onPriorityChange: (priority: TicketPriority | null) => void;
  onEditDates: () => void;
}

/** The inline properties under the detail header, with the done/total progress. */
export function InitiativePropertiesBar({
  initiative,
  status,
  priority,
  pending,
  boardName,
  onStatusChange,
  onPriorityChange,
  onEditDates,
}: InitiativePropertiesBarProps): ReactElement {
  const { t } = useTranslation();
  const target = initiative.targetDate
    ? formatCalendarDate(initiative.targetDate, new Date())
    : null;
  const targetLabel = target
    ? t("tickets.initiatives.targetDate", { date: target })
    : t("tickets.initiatives.noTargetDate");
  const progressLabel = t("tickets.initiatives.progress", {
    done: initiative.doneTicketCount,
    total: initiative.ticketCount,
  });

  return (
    <View style={styles.bar} testID="initiative-properties">
      <View style={styles.controls}>
        <InitiativeStatusMenu status={status} pending={pending} onChange={onStatusChange} />
        <InitiativePriorityMenu priority={priority} pending={pending} onChange={onPriorityChange} />
        <Pressable
          style={toolbarLabelTriggerStyle}
          onPress={onEditDates}
          accessibilityRole="button"
          accessibilityLabel={targetLabel}
          testID="initiative-target-date"
        >
          {(state: ToolbarLabelTriggerState) => (
            <>
              {calendarGlyph}
              <Text
                style={toolbarLabelTriggerTextStyle(isToolbarLabelTriggerHighlighted(state))}
                numberOfLines={1}
              >
                {targetLabel}
              </Text>
            </>
          )}
        </Pressable>
        {boardName ? (
          <Text style={styles.board} numberOfLines={1}>
            {boardName}
          </Text>
        ) : null}
      </View>
      <View style={styles.progress} accessible accessibilityLabel={progressLabel}>
        <ProgressMeter fraction={initiativeProgress(initiative)} />
        <Text style={styles.progressCount}>
          {`${initiative.doneTicketCount}/${initiative.ticketCount}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    rowGap: theme.spacing[2],
    columnGap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
  },
  board: {
    flexShrink: 1,
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  progressCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
