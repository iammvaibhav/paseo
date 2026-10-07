import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { PageThemeTokens } from "@getpaseo/protocol/page/theme";
import { buildPageThemeTokens } from "@/components/page-frame/page-theme";
import type { Theme } from "@/styles/theme";
import type { ChartFenceLanguage } from "./interactive-chart-fence";
import { mountChart, type ChartMount } from "./interactive-chart-engines.web";
import { useChartDataResolver } from "./chart-data-context";

interface InteractiveChartProps {
  code: string;
  language: ChartFenceLanguage;
  /**
   * The chart theme as JSON: a string compares by value, so the chart redraws only when a
   * color actually changes, not on every theme recompute.
   */
  themeJson?: string;
}

interface ChartRenderState {
  error: string | null;
  ready: boolean;
}

function parseChartSpec(code: string): Record<string, unknown> | null {
  try {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function InteractiveChartBase({ code, language, themeJson }: InteractiveChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ChartRenderState>({ error: null, ready: false });
  const spec = useMemo(() => parseChartSpec(code), [code]);
  const tokens = useMemo(
    () => (themeJson ? (JSON.parse(themeJson) as PageThemeTokens) : null),
    [themeJson],
  );
  const resolveData = useChartDataResolver();

  useEffect(() => {
    if (!spec) {
      setState({ error: "Chart block is not a valid JSON object", ready: false });
      return;
    }
    if (!tokens) return;
    const chartTokens = tokens;

    let cancelled = false;
    let mounted: ChartMount | null = null;
    let observer: ResizeObserver | null = null;

    setState({ error: null, ready: false });

    async function drawChart() {
      try {
        const host = hostRef.current;
        if (!host) return;

        const chart = await mountChart({
          host,
          spec: spec as Record<string, unknown>,
          language,
          tokens: chartTokens,
          resolveData,
        });

        // An unmount during the await still has to release the engine.
        if (cancelled) {
          chart.dispose();
          return;
        }

        mounted = chart;
        observer = new ResizeObserver(() => chart.resize());
        observer.observe(host);
        setState({ error: null, ready: true });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to render chart";
        setState({ error: message, ready: false });
      }
    }

    void drawChart();

    return () => {
      cancelled = true;
      observer?.disconnect();
      mounted?.dispose();
    };
  }, [spec, language, tokens, resolveData]);

  if (state.error) {
    return (
      <View style={styles.container} accessibilityRole="image" accessibilityLabel="Chart">
        <Text style={styles.label}>{language}</Text>
        <Text style={styles.error}>{state.error}</Text>
        <Text style={styles.source} selectable>
          {code}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityRole="image" accessibilityLabel="Chart">
      <Text style={styles.label}>{language}</Text>
      {state.ready ? null : <Text style={styles.loading}>Rendering chart…</Text>}
      <div ref={hostRef} style={chartHostStyle} />
    </View>
  );
}

const chartHostStyle: React.CSSProperties = {
  display: "block",
  height: 360,
  width: "100%",
};

const chartThemeMapping = (theme: Theme): Partial<InteractiveChartProps> => ({
  themeJson: JSON.stringify(buildPageThemeTokens(theme)),
});

const ThemedInteractiveChart = withUnistyles(InteractiveChartBase);

export function InteractiveChart({
  code,
  language,
}: {
  code: string;
  language: ChartFenceLanguage;
}) {
  return <ThemedInteractiveChart code={code} language={language} uniProps={chartThemeMapping} />;
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
