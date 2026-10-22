import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface MathViewProps {
  tex: string;
  display?: boolean;
  color?: string;
}

export function MathView({ tex, display = false }: MathViewProps) {
  if (display) {
    return (
      <View style={styles.blockContainer}>
        <Text style={styles.mathText} selectable>
          {tex}
        </Text>
      </View>
    );
  }
  return (
    <Text style={styles.mathText} selectable>
      {tex}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  blockContainer: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginVertical: theme.spacing[1],
  },
  mathText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
