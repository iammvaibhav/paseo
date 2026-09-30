import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TicketColumnStateType } from "@getpaseo/protocol/tickets/types";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { StatusIcon } from "./status-icon";

const ThemedPlus = withUnistyles(Plus);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ColumnHeader({
  name,
  stateType,
  count,
  onAdd,
}: {
  name: string;
  stateType: TicketColumnStateType;
  count: number;
  onAdd?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const addLabel = t("tickets.board.addToColumn", { column: name });
  const addButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
      iconButtonChromeStyle({ size: "small", compact: isCompact, state: { hovered, pressed } }),
    [isCompact],
  );
  const glyphSize = iconButtonChromeGlyphSize("small", isCompact);

  return (
    <View style={styles.header}>
      <View style={styles.title}>
        <StatusIcon stateType={stateType} />
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.count}>{count}</Text>
      </View>
      {onAdd ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={addLabel}
              hitSlop={isCompact ? 6 : 4}
              onPress={onAdd}
              style={addButtonStyle}
              testID={`tickets-column-add-${name}`}
            >
              {({ hovered, pressed }) => (
                <ThemedPlus
                  size={glyphSize}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent>{addLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: theme.spacing[8],
  },
  title: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    flexShrink: 1,
  },
  name: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
