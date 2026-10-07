import { pagePaletteFor, type PageThemeTokens } from "@getpaseo/protocol/page/theme";
import type { Theme } from "@/styles/theme";

const FALLBACK_UI_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FALLBACK_MONO_FONT = "ui-monospace, Menlo, monospace";

// Native font tokens name platform defaults ("normal", "monospace") that CSS reads poorly;
// a page always gets a full stack.
function cssFontStack(family: string, fallback: string): string {
  return family === "normal" || family === "system-ui" || family === "ui-monospace"
    ? fallback
    : `${family}, ${fallback}`;
}

/**
 * The page and chart theme for the active app theme. Fills come straight from the theme
 * tokens, so a glass theme hands its washes (and its floating and cover fills) to pages.
 */
export function buildPageThemeTokens(theme: Theme): PageThemeTokens {
  const { colors } = theme;
  const isDark = theme.colorScheme === "dark";
  const extraPalette = pagePaletteFor(theme.colorScheme).slice(4);
  return {
    colorScheme: theme.colorScheme,
    glass: theme.glass !== null,
    foreground: colors.foreground,
    muted: colors.foregroundMuted,
    faint: colors.foregroundExtraMuted,
    border: colors.border,
    accent: isDark ? colors.accentBright : colors.accent,
    surface1: colors.surface1,
    surface2: colors.surface2,
    surface3: colors.surface3,
    background: colors.background,
    floating: theme.glass?.floating ?? colors.popover,
    floatingBorder: theme.glass?.floatingBorder ?? colors.borderAccent,
    cover: theme.glass?.cover ?? colors.background,
    success: colors.statusDotSuccess,
    warning: colors.statusDotWarning,
    danger: colors.statusDotDanger,
    palette: [
      colors.statusDotRunning,
      colors.statusDotSuccess,
      colors.statusDotWarning,
      colors.statusDotDanger,
      ...extraPalette,
    ],
    fontUi: cssFontStack(theme.fontFamily.ui, FALLBACK_UI_FONT),
    fontMono: cssFontStack(theme.fontFamily.mono, FALLBACK_MONO_FONT),
    fontSize: theme.fontSize.base,
    radius: theme.borderRadius.lg,
  };
}
