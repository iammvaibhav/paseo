import { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";

interface UnavailableProviderCalloutProps {
  onContinueWithAnotherProvider: () => void;
}

export function UnavailableProviderCallout({
  onContinueWithAnotherProvider,
}: UnavailableProviderCalloutProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({ mode: "translate" });

  const containerStyle = useMemo(
    () => [styles.container, { paddingBottom: insets.bottom }, keyboardAnimatedStyle],
    [insets.bottom, keyboardAnimatedStyle],
  );

  const handleContinue = useCallback(() => {
    onContinueWithAnotherProvider();
  }, [onContinueWithAnotherProvider]);

  return (
    <Animated.View style={containerStyle}>
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          <View style={styles.calloutStack}>
            <View style={styles.callout}>
              <View style={styles.copy}>
                <Text style={styles.calloutText}>
                  {t("agentPanel.providerUnavailable.callout")}
                </Text>
                <Text style={styles.detailText}>{t("agentPanel.providerUnavailable.detail")}</Text>
              </View>
              <Button size="sm" variant="secondary" onPress={handleContinue}>
                {t("agentPanel.providerUnavailable.continueWithAnotherProvider")}
              </Button>
            </View>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexDirection: "column",
    position: "relative",
  },
  inputAreaContainer: {
    position: "relative",
    minHeight: FOOTER_HEIGHT,
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[4],
      md: theme.spacing[6],
    },
  },
  calloutStack: {
    gap: theme.spacing[2],
  },
  copy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  calloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  detailText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
})) as unknown as Record<string, object>;
