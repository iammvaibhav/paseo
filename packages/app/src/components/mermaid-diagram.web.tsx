import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type MermaidApi from "mermaid";
import { stripTerminalFenceNewline } from "@/components/mermaid-fence";
import {
  createMermaidConfig,
  type MermaidDiagramAppearance,
} from "@/components/mermaid-diagram-config";
import type { Theme } from "@/styles/theme";

interface MermaidDiagramProps extends MermaidDiagramAppearance {
  code: string;
}

interface MermaidRenderState {
  svg: string | null;
  error: string | null;
}

let mermaidRenderSeq = 0;
let mermaidModulePromise: Promise<typeof MermaidApi> | null = null;

function loadMermaid(): Promise<typeof MermaidApi> {
  mermaidModulePromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidModulePromise;
}

function MermaidDiagramBase({
  code,
  colorScheme,
  backgroundColor,
  nodeBackgroundColor,
  nodeBorderColor,
  clusterBackgroundColor,
  foregroundColor,
  mutedColor,
  fontFamily,
}: MermaidDiagramProps) {
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const [state, setState] = useState<MermaidRenderState>({ svg: null, error: null });
  const svgHtml = useMemo(() => (state.svg ? { __html: state.svg } : null), [state.svg]);
  const config = useMemo(
    () =>
      createMermaidConfig({
        colorScheme,
        backgroundColor,
        nodeBackgroundColor,
        nodeBorderColor,
        clusterBackgroundColor,
        foregroundColor,
        mutedColor,
        fontFamily,
      }),
    [
      backgroundColor,
      clusterBackgroundColor,
      colorScheme,
      fontFamily,
      foregroundColor,
      mutedColor,
      nodeBackgroundColor,
      nodeBorderColor,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const renderId = `paseo-mermaid-${++mermaidRenderSeq}`;

    async function renderDiagram() {
      try {
        const mermaid = await loadMermaid();
        // Measure against the fonts we will actually paint with, or every label
        // box comes out too narrow and clips. See mermaid-diagram-config.ts.
        await document.fonts.ready;
        if (cancelled) {
          return;
        }
        mermaid.initialize(config);

        // Mermaid mutates the DOM while rendering; keep cleanup idempotent.
        const { svg } = await mermaid.render(renderId, renderedCode);
        if (!cancelled) {
          setState({ svg, error: null });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to render Mermaid diagram";
        setState({ svg: null, error: message });
      } finally {
        // mermaid.render injects temporary nodes by id; remove leftovers.
        document.getElementById(renderId)?.remove();
        document.getElementById(`d${renderId}`)?.remove();
      }
    }

    setState({ svg: null, error: null });
    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [config, renderedCode]);

  if (state.error) {
    return (
      <View style={styles.container} accessibilityRole="image" accessibilityLabel="Mermaid diagram">
        <Text style={styles.label}>mermaid</Text>
        <Text style={styles.error}>{state.error}</Text>
        <Text style={styles.source} selectable>
          {renderedCode}
        </Text>
      </View>
    );
  }

  if (!state.svg || !svgHtml) {
    return (
      <View style={styles.container} accessibilityRole="image" accessibilityLabel="Mermaid diagram">
        <Text style={styles.label}>mermaid</Text>
        <Text style={styles.loading}>Rendering diagram…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityRole="image" accessibilityLabel="Mermaid diagram">
      <div
        style={svgHostStyle}
        // Mermaid returns trusted SVG markup for the local diagram source.
        dangerouslySetInnerHTML={svgHtml}
      />
    </View>
  );
}

const svgHostStyle: React.CSSProperties = {
  display: "block",
  lineHeight: 0,
  overflowX: "auto",
  width: "100%",
};

const mermaidThemeMapping = (theme: Theme): Partial<MermaidDiagramProps> => ({
  colorScheme: theme.colorScheme,
  backgroundColor: theme.colors.surface2,
  nodeBackgroundColor: theme.colors.surface3,
  nodeBorderColor: theme.colors.surface4,
  clusterBackgroundColor: theme.colors.surface1,
  foregroundColor: theme.colors.foreground,
  mutedColor: theme.colors.foregroundMuted,
  fontFamily: theme.fontFamily.ui,
});

const ThemedMermaidDiagram = withUnistyles(MermaidDiagramBase);

export function MermaidDiagram({ code }: { code: string }) {
  return <ThemedMermaidDiagram code={code} uniProps={mermaidThemeMapping} />;
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
  loading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  source: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: Math.round(theme.fontSize.code * 1.45),
  },
}));
