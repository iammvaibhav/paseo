import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clampPct } from "./format";
import type { UsageTone } from "./types";

function fillToneStyle(tone: UsageTone) {
  switch (tone) {
    case "warning":
      return styles.fillWarning;
    case "danger":
      return styles.fillDanger;
    default:
      return styles.fillOk;
  }
}

/**
 * A window's share as a bar, coloured by its tone. The caller sizes the track.
 */
export function UsageMeter({
  percent,
  tone,
  style,
}: {
  percent: number;
  tone: UsageTone;
  style?: StyleProp<ViewStyle>;
}) {
  const fillWidth = clampPct(percent);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, fillToneStyle(tone), { width: `${fillWidth}%` }],
    [fillWidth, tone],
  );
  return (
    <View style={[styles.track, style]}>
      <View style={fillStyle} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  // Follows the track, so a caller that sizes the track sizes the bar.
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  fillOk: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
