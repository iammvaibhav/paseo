import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ChartFenceLanguage } from "./interactive-chart-fence";

/**
 * Native has no DOM host for the chart engines, so the spec is shown as source
 * rather than pulling a WebView per chart into the timeline.
 */
export function InteractiveChart({
  code,
  language,
}: {
  code: string;
  language: ChartFenceLanguage;
}) {
  return (
    <View style={styles.container} accessibilityRole="image" accessibilityLabel="Chart">
      <Text style={styles.label}>{language}</Text>
      <Text style={styles.source} selectable>
        {code}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    marginVertical: theme.spacing[3],
    overflow: "hidden",
    padding: theme.spacing[3],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
  source: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: Math.round(theme.fontSize.code * 1.45),
  },
}));
