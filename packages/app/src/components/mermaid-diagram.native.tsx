import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { stripTerminalFenceNewline } from "@/components/mermaid-fence";

interface MermaidDiagramProps {
  code: string;
}

// Native keeps the source readable. Full Mermaid SVG rendering is web-only
// (same split as MathView / KaTeX).
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const renderedCode = stripTerminalFenceNewline(code);
  return (
    <View style={styles.container} accessibilityRole="image" accessibilityLabel="Mermaid diagram">
      <Text style={styles.label}>mermaid</Text>
      <Text style={styles.source} selectable>
        {renderedCode}
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
