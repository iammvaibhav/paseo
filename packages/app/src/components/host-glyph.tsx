import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { identityColor } from "@/styles/identity-colors";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import {
  hostGlyphStatusSignal,
  normalizeHostGlyphOverride,
  resolveHostGlyphPresentation,
} from "@/components/host-glyph-model";

const WHITE_TEXT = { color: "#ffffff" } as const;
const FALLBACK_LAYOUT = { alignItems: "center", justifyContent: "center" } as const;

export interface HostGlyphProps {
  serverId: string;
  /** Host alias/label; its first character becomes the default initial. */
  label: string;
  /**
   * Glyph diameter. "sm" is the dense metadata-chip size used by Mission
   * Control cards; numeric sizes remain available for established surfaces.
   */
  size?: number | "sm";
  testID?: string;
}

const SMALL_GLYPH_SIZE = 14;

/**
 * A host's face everywhere in the app — the Mission Control board, the sidebar
 * host picker, the inspector header. One shared chip so a host reads the same
 * in every surface (spec: "one identity everywhere").
 *
 * Identity badge per docs/design.md §13: fill from the fixed ten-color table,
 * white letter on top, geometry (size/radius) owned here so every row draws the
 * same shape. The color is deterministic from the serverId, or the per-host
 * override from host settings when the user set one (custom initials + color).
 * The override is read reactively from the daemon config, so every surface
 * picks up a change without callers re-wiring.
 *
 * The connection status the sidebar used to show as a dot moves onto the chip:
 * online is the full-color glyph, connecting/offline dim the fill and draw a
 * ring in the matching status token — nothing is lost by dropping the dot.
 * The tooltip carries the full host name.
 */
export function HostGlyph({ serverId, label, size = 16, testID }: HostGlyphProps) {
  const resolvedSize = size === "sm" ? SMALL_GLYPH_SIZE : size;
  const { config } = useDaemonConfig(serverId);
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);

  const { glyph, colorName } = useMemo(() => {
    const alias = config?.missionControl?.hostAlias?.trim() || null;
    const override = normalizeHostGlyphOverride(config?.missionControl?.hostGlyph);
    return resolveHostGlyphPresentation({ serverId, label: alias ?? label, override });
  }, [config?.missionControl?.hostAlias, config?.missionControl?.hostGlyph, label, serverId]);

  const signal = hostGlyphStatusSignal(connectionStatus);

  const glyphStyle = useMemo(
    () => [
      FALLBACK_LAYOUT,
      { width: resolvedSize, height: resolvedSize, borderRadius: resolvedSize / 2 },
      { backgroundColor: identityColor(colorName) },
      signal !== "none" && styles.dimmed,
    ],
    [colorName, resolvedSize, signal],
  );

  // Emoji render at roughly their font size while letters sit at ~0.55em, so a
  // single emoji scales up and a two-emoji chip scales down to avoid clipping.
  const glyphUnits = Array.from(glyph).length;
  const isEmoji = (glyph.codePointAt(0) ?? 0) > 0x2fff;
  let textScale = 0.55;
  if (isEmoji) {
    textScale = glyphUnits > 1 ? 0.5 : 0.62;
  }
  const textStyle = useMemo(
    () => [
      WHITE_TEXT,
      { fontSize: Math.round(resolvedSize * textScale), lineHeight: resolvedSize },
    ],
    [resolvedSize, textScale],
  );

  const displayName = label.trim().length > 0 ? label : serverId;
  const ring =
    signal === "none" ? null : (
      <View
        pointerEvents="none"
        style={[
          styles.statusRing,
          { borderRadius: resolvedSize / 2 },
          signal === "warning" ? styles.statusRingWarning : styles.statusRingDanger,
        ]}
      />
    );

  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View collapsable={false}>
          <View style={glyphStyle} testID={testID} accessibilityLabel={displayName}>
            <Text style={textStyle} numberOfLines={1} selectable={false}>
              {glyph}
            </Text>
          </View>
          {ring}
        </View>
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
  dimmed: {
    opacity: theme.opacity[50],
  },
  statusRing: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1.5,
  },
  statusRingWarning: {
    borderColor: theme.colors.statusWarning,
  },
  statusRingDanger: {
    borderColor: theme.colors.statusDanger,
  },
}));
