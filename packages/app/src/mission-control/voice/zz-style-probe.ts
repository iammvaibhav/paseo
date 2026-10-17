import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

export const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    position: "absolute",
    zIndex: 10,
    backgroundColor: theme.colors.surface1,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    maxHeight: 320,
  },
  entry: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  buttonEnd: { marginLeft: "auto" },
  buttonLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  transcript: { flexGrow: 0, maxHeight: 150 },
}));
