import type { PageThemeTokens } from "@getpaseo/protocol/page/theme";

/** An agent page: its own HTML, or a URL the reader's device can load. */
export type PageSource = { kind: "html"; html: string } | { kind: "url"; url: string };

export interface PageFrameProps {
  source: PageSource;
  title: string;
  tokens: PageThemeTokens;
  /** Frame height cap. HTML grows to its content up to this; a URL page takes it as is. */
  maxHeight: number;
  /** Fill the parent instead of sizing to the content (the full-size viewer). */
  fill?: boolean;
  onOpenUrl: (url: string) => void;
  testID?: string;
}

export const PAGE_FRAME_MIN_HEIGHT = 80;
/** Shown before an HTML page reports its height, so the row does not jump from zero. */
export const PAGE_FRAME_INITIAL_HEIGHT = 160;
export const PAGE_URL_DEFAULT_HEIGHT = 640;

/**
 * The frame height in pixels, or null when the frame fills its parent. An HTML page grows
 * to its reported content height within the cap; a URL page cannot report one.
 */
export function resolvePageFrameHeight(input: {
  source: PageSource;
  fill: boolean;
  contentHeight: number | null;
  maxHeight: number;
}): number | null {
  if (input.fill) return null;
  if (input.source.kind === "url") return input.maxHeight;
  const measured = input.contentHeight ?? PAGE_FRAME_INITIAL_HEIGHT;
  return Math.min(Math.max(measured, PAGE_FRAME_MIN_HEIGHT), input.maxHeight);
}
