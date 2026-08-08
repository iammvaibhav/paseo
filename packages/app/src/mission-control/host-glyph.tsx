import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";

const WHITE_TEXT = { color: "#ffffff" } as const;
const FALLBACK_LAYOUT = { alignItems: "center", justifyContent: "center" } as const;

export interface HostGlyphProps {
  serverId: string;
  /** Host alias/label; its first character becomes the initial. */
  label: string;
  /** Per-host emoji override (host settings); honored when set. */
  emoji?: string | null;
  /** Glyph diameter. Rows draw at 16; the inspector header can go larger. */
  size?: number;
  testID?: string;
}

/**
 * A host's face on the Mission Control board: a small avatar whose accent is
 * derived deterministically from the serverId (identity color table), showing
 * the host alias initial — or a per-host emoji override when the user set one.
 * Tooltip carries the full host name; the glyph itself never renders text wide
 * enough to crowd a row.
 *
 * Identity badge per docs/design.md §13: fill from the fixed ten-color table,
 * white letter on top, geometry (size/radius) owned here so every row and the
 * inspector header draw the same shape.
 */
export function HostGlyph({ serverId, label, emoji, size = 16, testID }: HostGlyphProps) {
  const glyphStyle = useMemo(
    () => [
      FALLBACK_LAYOUT,
      { width: size, height: size, borderRadius: size / 2 },
      { backgroundColor: identityColor(deriveIdentityColorName(serverId)) },
    ],
    [serverId, size],
  );
  const textStyle = useMemo(
    () => [WHITE_TEXT, { fontSize: Math.round(size * (emoji ? 0.62 : 0.55)), lineHeight: size }],
    [emoji, size],
  );
  const displayName = label.trim().length > 0 ? label : serverId;
  const glyph = (
    <View style={glyphStyle} testID={testID} accessibilityLabel={displayName}>
      <Text style={textStyle} numberOfLines={1} selectable={false}>
        {emoji && emoji.trim().length > 0 ? emoji : displayName.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View collapsable={false}>{glyph}</View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{displayName}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
