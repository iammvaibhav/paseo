import type { MermaidConfig } from "mermaid";

export interface MermaidDiagramAppearance {
  colorScheme?: "dark" | "light";
  /** Card surface the diagram sits on; also backs edge labels so lines don't run through them. */
  backgroundColor?: string;
  nodeBackgroundColor?: string;
  nodeBorderColor?: string;
  clusterBackgroundColor?: string;
  foregroundColor?: string;
  mutedColor?: string;
  fontFamily?: string;
}

/**
 * Mermaid measures every label in a throwaway container attached to `<body>` and
 * bakes those widths into the SVG as `foreignObject` bounds. We reinsert that SVG
 * deep in the react-native-web tree, where `Text` applies its own font stack while
 * `<body>` has none (Times). A relative family therefore resolves to a different
 * font at measure time than at paint time, the text outgrows its box, and the
 * browser clips it. Always hand mermaid a concrete stack.
 */
export const MERMAID_FALLBACK_FONT_FAMILY =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function createMermaidConfig({
  colorScheme = "dark",
  backgroundColor,
  nodeBackgroundColor,
  nodeBorderColor,
  clusterBackgroundColor,
  foregroundColor,
  mutedColor,
  fontFamily,
}: MermaidDiagramAppearance): MermaidConfig {
  const lineColor = mutedColor ?? foregroundColor;
  const strokeColor = nodeBorderColor ?? lineColor;
  // Anything left undefined falls through to mermaid's own theme. Never pass a
  // relative keyword here: mermaid runs these through a color parser that throws.
  const themeVariables: Record<string, string> = {
    fontFamily: fontFamily?.trim() ? fontFamily : MERMAID_FALLBACK_FONT_FAMILY,
  };
  const colors: Record<string, string | undefined> = {
    background: backgroundColor,
    mainBkg: nodeBackgroundColor ?? backgroundColor,
    clusterBkg: clusterBackgroundColor ?? backgroundColor,
    edgeLabelBackground: backgroundColor,
    nodeBorder: strokeColor,
    clusterBorder: strokeColor,
    lineColor,
    textColor: foregroundColor,
    primaryTextColor: foregroundColor,
    titleColor: foregroundColor,
    secondaryTextColor: lineColor,
    tertiaryTextColor: lineColor,
  };
  for (const [key, value] of Object.entries(colors)) {
    if (value) {
      themeVariables[key] = value;
    }
  }
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: colorScheme === "light" ? "default" : "dark",
    fontFamily: themeVariables.fontFamily,
    themeVariables,
  };
}
