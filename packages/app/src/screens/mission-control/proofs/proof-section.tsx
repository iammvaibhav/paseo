import React, { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Collapsed-by-default proof section. The header is an inner Pressable so the
 * surrounding feed card can stay pressable (Inspector open): the toggle
 * stops propagation on web, and the nested responder wins on native.
 */
export function ProofSection({ header, body }: { header: string; body: ReactNode }): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const handleToggle = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    setExpanded((current) => !current);
  }, []);

  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const headerStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.header, pressed && styles.headerPressed],
    [],
  );

  return (
    <View style={styles.section}>
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={header}
        style={headerStyle}
        testID={`mission-control-proof-section-${header.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {expanded ? (
          <ThemedChevronDown size={14} uniProps={iconMutedMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={iconMutedMapping} />
        )}
        <Text style={styles.headerText}>{header}</Text>
      </Pressable>
      {expanded ? <View style={styles.body}>{body}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginTop: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[1],
    alignSelf: "flex-start",
  },
  headerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  headerText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  body: {
    marginTop: theme.spacing[2],
  },
}));
