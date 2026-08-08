import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { LucideIcon } from "lucide-react-native";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SidebarHeaderRowBadgeSegment {
  /** Count shown in the pill; zero-count segments are omitted entirely. */
  count: number;
  /** Accessibility label for the segment. */
  label: string;
  testID: string;
  /**
   * Status-token family for the chip (spec: same tokens as the board
   * buckets — needs-you = attention, ready-for-review = success).
   */
  tone: "attention" | "success";
}

type SidebarHeaderRowVariant = "header" | "compact";

interface SidebarHeaderRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a workspace-row-height row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   */
  variant?: SidebarHeaderRowVariant;
  shortcutKeys?: ShortcutKey[][] | null;
  /** Optional count pills rendered right-aligned (e.g. Mission Control's
   * working / ready-for-review split). Zero-count segments are omitted;
   * both segments show when both are nonzero. */
  badgeSegments?: readonly SidebarHeaderRowBadgeSegment[];
}

export function SidebarHeaderRow({
  icon: Icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  badgeSegments,
}: SidebarHeaderRowProps) {
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);

  const containerStyle = useMemo(
    () => (variant === "compact" ? styles.containerCompact : styles.container),
    [variant],
  );

  const buttonStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      variant === "compact" && styles.buttonCompact,
      (Boolean(hovered) || isActive) && styles.buttonHovered,
    ],
    [isActive, variant],
  );

  const renderChildren = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => {
      const isHighlighted = Boolean(state.hovered) || isActive;
      return (
        <>
          <ThemedIcon
            size={ICON_SIZE.sm}
            uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
          />
          <SidebarHeaderRowLabel label={label} isHighlighted={isHighlighted} />
          {shortcutKeys && Boolean(state.hovered) ? (
            <Shortcut chord={shortcutKeys} style={styles.shortcut} />
          ) : null}
          {badgeSegments && badgeSegments.some((segment) => segment.count > 0) ? (
            <View style={styles.countBadges}>
              {badgeSegments
                .filter((segment) => segment.count > 0)
                .map((segment) => (
                  <View
                    key={segment.testID}
                    style={[
                      styles.countBadge,
                      segment.tone === "attention"
                        ? styles.countBadgeAttention
                        : styles.countBadgeSuccess,
                    ]}
                    accessibilityLabel={`${segment.count} ${segment.label}`}
                    testID={segment.testID}
                  >
                    <Text style={styles.countBadgeText}>{segment.count}</Text>
                  </View>
                ))}
            </View>
          ) : null}
        </>
      );
    },
    [ThemedIcon, badgeSegments, isActive, label, shortcutKeys],
  );

  return (
    <View style={containerStyle}>
      <Pressable
        onPress={onPress}
        testID={testID}
        nativeID={nativeID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={buttonStyle}
      >
        {renderChildren}
      </Pressable>
    </View>
  );
}

function SidebarHeaderRowLabel({
  label,
  isHighlighted,
}: {
  label: string;
  isHighlighted: boolean;
}) {
  const labelStyle = useMemo(
    () => [styles.label, isHighlighted && styles.labelHighlighted],
    [isHighlighted],
  );
  return <Text style={labelStyle}>{label}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Match the sidebar workspace-row shape (height, padding, radius) so the
    // compact header entries sit tight against the workspace list below.
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  // Compact header entries (New workspace / History) sit tighter than the
  // workspace-row shape the base button mirrors.
  buttonCompact: {
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the workspace list below (base button uses a wider spacing[3]).
    paddingHorizontal: theme.spacing[2],
  },
  buttonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  shortcut: {
    marginLeft: "auto",
  },
  countBadges: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  countBadge: {
    width: theme.spacing[4],
    height: theme.spacing[4],
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadgeAttention: {
    backgroundColor: theme.colors.statusDanger,
  },
  countBadgeSuccess: {
    backgroundColor: theme.colors.statusSuccess,
  },
  countBadgeText: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.spacing[4],
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.white,
  },
}));
