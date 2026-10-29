import type { MarkdownStyle } from "react-native-enriched-markdown";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";

// iOS Safari needs the prefix to override the gesture host's selection suppression.
const WEB_CONTAINER = { userSelect: "text", WebkitUserSelect: "text" } as const;

export function createMarkdownStyles(
  theme: Theme,
  {
    compact = false,
    muted = false,
    blockGap,
  }: { compact?: boolean; muted?: boolean; blockGap: number },
): { markdownStyle: MarkdownStyle; selectionColor: string; containerStyle?: typeof WEB_CONTAINER } {
  const fontSize = compact ? theme.fontSize.base : theme.fontSize.content;
  // Every block is followed by the same gap; the library drops it after the last block.
  const block = { marginTop: 0, marginBottom: blockGap };
  const paragraph = {
    fontSize,
    fontFamily: theme.fontFamily.ui,
    lineHeight: Math.round(fontSize * 1.4),
    // Prose and headings use different tones; themes without a prose tone use foreground.
    color: muted ? theme.colors.foregroundMuted : theme.colors.foregroundProse,
    ...block,
  };
  const emphasisColor = muted ? theme.colors.foregroundMuted : theme.colors.foreground;
  // Headings stay close to the body size: tiers of the type ramp over its base step.
  const heading = (tier: keyof typeof theme.fontSize) => {
    const size = Math.round(fontSize * (theme.fontSize[tier] / theme.fontSize.base));
    return {
      ...paragraph,
      color: emphasisColor,
      fontSize: size,
      lineHeight: Math.round(size * 1.3),
      fontWeight: "600",
    };
  };
  return {
    containerStyle: isWeb ? WEB_CONTAINER : undefined,
    selectionColor: theme.colors.terminal.selectionBackground,
    markdownStyle: {
      paragraph,
      h1: heading("2xl"),
      h2: heading("xl"),
      h3: heading("lg"),
      h4: heading("lg"),
      h5: heading("base"),
      h6: { ...heading("base"), color: theme.colors.foregroundMuted },
      strong: { color: emphasisColor },
      em: { color: emphasisColor },
      list: {
        ...paragraph,
        bulletColor: theme.colors.foregroundMuted,
        markerColor: theme.colors.foregroundMuted,
        gapWidth: 7,
        itemSpacing: 4,
        marginLeft: 20,
      },
      blockquote: {
        ...paragraph,
        color: `${theme.colors.foreground}cc`,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.surface2,
        borderWidth: 3,
        padding: 12,
        gapWidth: 8,
        admonitions: {
          note: { color: theme.colors.accentBright, backgroundColor: theme.colors.surface2 },
          tip: { color: theme.colors.statusSuccess, backgroundColor: theme.colors.surface2 },
          important: { color: theme.colors.statusMerged, backgroundColor: theme.colors.surface2 },
          warning: { color: theme.colors.statusWarning, backgroundColor: theme.colors.surface2 },
          caution: { color: theme.colors.statusDanger, backgroundColor: theme.colors.surface2 },
        },
      },
      link: { color: theme.colors.accentBright, underline: false },
      linkVariants: {
        "^(?!https?://).+": {
          color: theme.colors.accentBright,
        },
      },
      code: {
        fontFamily: theme.fontFamily.mono === "ui-monospace" && !isWeb ? "" : theme.fontFamily.mono,
        fontScale: theme.fontSize.code / fontSize,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: "transparent",
      },
      codeBlock: {
        ...paragraph,
        fontFamily: theme.fontFamily.mono === "ui-monospace" && !isWeb ? "" : theme.fontFamily.mono,
        fontSize: theme.fontSize.code,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 12,
      },
      // One frame around the whole table on a single fill, without striped rows.
      table: {
        ...paragraph,
        fontSize: theme.fontSize.base,
        lineHeight: Math.round(theme.fontSize.base * 1.4),
        borderColor: theme.colors.border,
        borderRadius: theme.borderRadius.lg,
        cellPaddingHorizontal: theme.spacing[3],
        cellPaddingVertical: theme.spacing[2],
        headerBackgroundColor: theme.colors.surface1,
        headerTextColor: theme.colors.foreground,
        rowEvenBackgroundColor: theme.colors.surface1,
        rowOddBackgroundColor: theme.colors.surface1,
      },
      taskList: {
        checkedTextColor: theme.colors.foregroundMuted,
        checkedColor: theme.colors.accent,
        checkmarkColor: theme.colors.accentForeground,
        borderColor: theme.colors.foregroundMuted,
      },
      inlineImage: { size: paragraph.lineHeight },
      // The engine's default display-math fill is light; math sits on the chat surface.
      math: { ...block, color: paragraph.color, backgroundColor: "transparent" },
      inlineMath: { color: paragraph.color },
      image: { ...block, height: 320, resizeMode: "contain", borderRadius: 8 },
      thematicBreak: { ...block, color: theme.colors.border, height: 1 },
    },
  };
}
