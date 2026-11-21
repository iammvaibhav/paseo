import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { ArrowUpToLine } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

interface JumpToUserMessageButtonProps {
  onPress: () => void;
  testID?: string;
}

const ThemedArrowUpToLine = withUnistyles(ArrowUpToLine);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const JumpToUserMessageButton = memo(function JumpToUserMessageButton({
  onPress,
  testID = "jump-to-user-message-button",
}: JumpToUserMessageButtonProps) {
  const { t } = useTranslation();

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.actions.jumpToUserMessage")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  const triggerStyle = useCallback(() => styles.trigger, []);

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        accessibilityLabel={t("message.actions.jumpToUserMessage")}
        accessibilityRole="button"
        onPress={onPress}
        style={triggerStyle}
        testID={testID}
      >
        {({ hovered }) => (
          <View style={styles.triggerSlot} collapsable={false}>
            <ThemedArrowUpToLine
              size={16}
              uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          </View>
        )}
      </TooltipTrigger>
      {tooltipContent}
    </Tooltip>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
