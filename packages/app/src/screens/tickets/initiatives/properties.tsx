import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { InitiativeStatus, TicketPriority } from "@getpaseo/protocol/tickets/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  isToolbarLabelTriggerHighlighted,
  ToolbarLabelTriggerIcon,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
  type ToolbarLabelTriggerState,
} from "@/components/ui/toolbar-label-trigger";
import { ICON_SIZE } from "@/styles/theme";
import { PriorityIcon, usePriorityLabel } from "../components/priority-icon";
import { StatusIcon } from "../components/status-icon";
import { INITIATIVE_STATUS_STATE, INITIATIVE_STATUSES, TICKET_PRIORITIES } from "./status";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const MENU_WIDTH = 200;

export function InitiativeStatusIcon({
  status,
  size = ICON_SIZE.sm,
}: {
  status: InitiativeStatus;
  size?: number;
}): ReactElement {
  return <StatusIcon stateType={INITIATIVE_STATUS_STATE[status]} size={size} />;
}

const STATUS_LEADING: Record<InitiativeStatus, ReactElement> = {
  proposed: <InitiativeStatusIcon status="proposed" />,
  planned: <InitiativeStatusIcon status="planned" />,
  active: <InitiativeStatusIcon status="active" />,
  completed: <InitiativeStatusIcon status="completed" />,
  canceled: <InitiativeStatusIcon status="canceled" />,
};

const PRIORITY_LEADING: Record<TicketPriority, ReactElement> = {
  urgent: <PriorityIcon priority="urgent" />,
  high: <PriorityIcon priority="high" />,
  medium: <PriorityIcon priority="medium" />,
  low: <PriorityIcon priority="low" />,
};

/** A thin done/total bar. `fraction` is 0..1. Without `wide` it keeps one width down a list. */
export function ProgressMeter({
  fraction,
  wide = false,
}: {
  fraction: number;
  wide?: boolean;
}): ReactElement {
  const fillStyle = useMemo(
    () => [styles.meterFill, { width: `${Math.round(fraction * 100)}%` as const }],
    [fraction],
  );
  return (
    <View style={[styles.meterTrack, wide ? styles.meterTrackWide : styles.meterTrackFixed]}>
      <View style={fillStyle} />
    </View>
  );
}

function TriggerChevron({ pending }: { pending: boolean }): ReactElement {
  return (
    <ToolbarLabelTriggerIcon>
      {pending ? (
        <ThemedLoadingSpinner size={ICON_SIZE.xs} uniProps={extraMutedIconColorMapping} />
      ) : (
        <ThemedChevronDown size={ICON_SIZE.xs} uniProps={extraMutedIconColorMapping} />
      )}
    </ToolbarLabelTriggerIcon>
  );
}

interface InitiativeStatusMenuProps {
  status: InitiativeStatus;
  pending: boolean;
  onChange: (status: InitiativeStatus) => void;
}

/** The inline status control of the detail header. */
export function InitiativeStatusMenu({
  status,
  pending,
  onChange,
}: InitiativeStatusMenuProps): ReactElement {
  const { t } = useTranslation();
  const label = t(`tickets.initiatives.status.${status}`);
  const handlers = useMemo<Record<InitiativeStatus, () => void>>(
    () => ({
      proposed: () => onChange("proposed"),
      planned: () => onChange("planned"),
      active: () => onChange("active"),
      completed: () => onChange("completed"),
      canceled: () => onChange("canceled"),
    }),
    [onChange],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={toolbarLabelTriggerStyle}
        disabled={pending}
        accessibilityRole="button"
        accessibilityLabel={t("tickets.initiatives.detail.statusPicker", { status: label })}
        testID="initiative-status-trigger"
      >
        {(state: ToolbarLabelTriggerState) => (
          <>
            {STATUS_LEADING[status]}
            <Text
              style={toolbarLabelTriggerTextStyle(isToolbarLabelTriggerHighlighted(state))}
              numberOfLines={1}
            >
              {label}
            </Text>
            <TriggerChevron pending={pending} />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={MENU_WIDTH}>
        {INITIATIVE_STATUSES.map((option) => (
          <DropdownMenuItem
            key={option}
            leading={STATUS_LEADING[option]}
            selected={option === status}
            onSelect={handlers[option]}
            testID={`initiative-status-option-${option}`}
          >
            {t(`tickets.initiatives.status.${option}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface InitiativePriorityMenuProps {
  priority: TicketPriority | null;
  pending: boolean;
  onChange: (priority: TicketPriority | null) => void;
}

/** The inline priority control of the detail header. */
export function InitiativePriorityMenu({
  priority,
  pending,
  onChange,
}: InitiativePriorityMenuProps): ReactElement {
  const { t } = useTranslation();
  const priorityLabel = usePriorityLabel();
  const label = priority ? priorityLabel(priority) : t("tickets.initiatives.noPriority");
  const handlers = useMemo<Record<TicketPriority | "none", () => void>>(
    () => ({
      urgent: () => onChange("urgent"),
      high: () => onChange("high"),
      medium: () => onChange("medium"),
      low: () => onChange("low"),
      none: () => onChange(null),
    }),
    [onChange],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={toolbarLabelTriggerStyle}
        disabled={pending}
        accessibilityRole="button"
        accessibilityLabel={t("tickets.initiatives.detail.priorityPicker", { priority: label })}
        testID="initiative-priority-trigger"
      >
        {(state: ToolbarLabelTriggerState) => (
          <>
            {priority ? PRIORITY_LEADING[priority] : null}
            <Text
              style={toolbarLabelTriggerTextStyle(isToolbarLabelTriggerHighlighted(state))}
              numberOfLines={1}
            >
              {label}
            </Text>
            <TriggerChevron pending={pending} />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={MENU_WIDTH}>
        {TICKET_PRIORITIES.map((option) => (
          <DropdownMenuItem
            key={option}
            leading={PRIORITY_LEADING[option]}
            selected={option === priority}
            onSelect={handlers[option]}
            testID={`initiative-priority-option-${option}`}
          >
            {priorityLabel(option)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          selected={priority === null}
          onSelect={handlers.none}
          testID="initiative-priority-option-none"
        >
          {t("tickets.initiatives.noPriority")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  meterTrack: {
    height: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  meterTrackFixed: {
    width: theme.spacing[16],
  },
  meterTrackWide: {
    flex: 1,
  },
  meterFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
