import type { ReactElement } from "react";
import { Circle, CircleCheck, CircleDashed, CircleDot, CircleX } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { TicketColumnStateType } from "@getpaseo/protocol/tickets/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";

type StateColorToken =
  | "foregroundMuted"
  | "foregroundExtraMuted"
  | "statusWarning"
  | "statusSuccess";

/** One color per column state type; initiative status dots use the same family. */
export const TICKET_STATE_COLOR_TOKEN: Record<TicketColumnStateType, StateColorToken> = {
  backlog: "foregroundMuted",
  unstarted: "foregroundMuted",
  started: "statusWarning",
  completed: "statusSuccess",
  canceled: "foregroundExtraMuted",
};

const STATE_ICONS = {
  backlog: withUnistyles(CircleDashed),
  unstarted: withUnistyles(Circle),
  started: withUnistyles(CircleDot),
  completed: withUnistyles(CircleCheck),
  canceled: withUnistyles(CircleX),
} as const;

const STATE_COLOR_MAPPINGS: Record<TicketColumnStateType, (theme: Theme) => { color: string }> = {
  backlog: (theme) => ({ color: theme.colors[TICKET_STATE_COLOR_TOKEN.backlog] }),
  unstarted: (theme) => ({ color: theme.colors[TICKET_STATE_COLOR_TOKEN.unstarted] }),
  started: (theme) => ({ color: theme.colors[TICKET_STATE_COLOR_TOKEN.started] }),
  completed: (theme) => ({ color: theme.colors[TICKET_STATE_COLOR_TOKEN.completed] }),
  canceled: (theme) => ({ color: theme.colors[TICKET_STATE_COLOR_TOKEN.canceled] }),
};

export function StatusIcon({
  stateType,
  size = ICON_SIZE.sm,
}: {
  stateType: TicketColumnStateType;
  size?: number;
}): ReactElement {
  const Icon = STATE_ICONS[stateType];
  return <Icon size={size} uniProps={STATE_COLOR_MAPPINGS[stateType]} />;
}
