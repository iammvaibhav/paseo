import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import type { TicketColumn, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { StatusIcon } from "@/screens/tickets/components/status-icon";
import { TicketKey } from "@/screens/tickets/components/ticket-key";
import { ICON_SIZE } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const REMOVE_ICON = <ThemedX size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;

interface TicketRefRowProps {
  ticket: TicketSummary;
  column: TicketColumn | null;
  onOpen: (ticket: TicketSummary) => void;
  onRemove?: (ticket: TicketSummary) => void;
  removeLabel?: string;
}

/** A related ticket: status, key and title. Press opens it; the X unlinks it. */
export function TicketRefRow({
  ticket,
  column,
  onOpen,
  onRemove,
  removeLabel,
}: TicketRefRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleOpen = useCallback(() => onOpen(ticket), [onOpen, ticket]);
  const handleRemove = useCallback(() => onRemove?.(ticket), [onRemove, ticket]);
  const showRemove = isHovered || isCompact || isNative;

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );

  return (
    <View
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={`${ticket.key} ${ticket.title}`}
        testID={`ticket-ref-${ticket.key}`}
      >
        {column ? <StatusIcon stateType={column.stateType} /> : null}
        <TicketKey ticketKey={ticket.key} />
        <Text style={styles.title} numberOfLines={1}>
          {ticket.title}
        </Text>
        {onRemove ? (
          <View style={showRemove ? styles.removeSlot : styles.removeSlotHidden}>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={REMOVE_ICON}
              onPress={handleRemove}
              accessibilityLabel={removeLabel}
              testID={`ticket-ref-remove-${ticket.key}`}
            />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
  },
  row: {
    minHeight: CONTROL_HEIGHTS.compact,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  removeSlot: {
    opacity: 1,
  },
  // Hidden with opacity, not unmounted, so hover never changes the row's layout.
  removeSlotHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
}));
