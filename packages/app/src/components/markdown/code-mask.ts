const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
/** Stands in for every masked character; source syntax never contains it. */
export const CODE_MASK = "\u0000";

export interface FencedCodeBlock {
  /** Offset of the opening fence line. */
  start: number;
  /** Offset just past the closing fence line, or the end of the source when unclosed. */
  end: number;
  /** True when no line between the fences holds code. */
  empty: boolean;
}

/** Top-level fenced code blocks, by line scan. Fences inside lists or quotes are not found. */
export function findFencedCodeBlocks(source: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let open: { marker: string; start: number; empty: boolean } | null = null;
  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const lineStart = offset;
    offset += line.length;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      const closes =
        marker !== undefined &&
        marker[0] === open.marker[0] &&
        marker.length >= open.marker.length &&
        line.trim().slice(marker.length).trim() === "";
      if (closes) {
        blocks.push({ start: open.start, end: offset, empty: open.empty });
        open = null;
      } else if (line.trim()) {
        open.empty = false;
      }
      continue;
    }
    // A backtick fence's info string cannot hold a backtick; that line is inline code.
    if (marker && !(marker[0] === "`" && line.trim().slice(marker.length).includes("`"))) {
      open = { marker, start: lineStart, empty: true };
    }
  }
  if (open) blocks.push({ start: open.start, end: source.length, empty: open.empty });
  return blocks;
}

function mask(text: string): string {
  return text.replace(/[^\n]/g, CODE_MASK);
}

/**
 * The source with fenced blocks and code spans replaced character for character by
 * `CODE_MASK`, newlines kept. Offsets match the source, so a pattern that excludes the
 * mask finds syntax only in prose, and its match is the same text in the source.
 */
export function maskMarkdownCode(source: string): string {
  if (!source.includes("`") && !source.includes("~~~")) return source;
  let masked = "";
  let cursor = 0;
  for (const block of findFencedCodeBlocks(source)) {
    masked += source.slice(cursor, block.start) + mask(source.slice(block.start, block.end));
    cursor = block.end;
  }
  masked += source.slice(cursor);
  return masked.replace(INLINE_CODE, mask);
}
