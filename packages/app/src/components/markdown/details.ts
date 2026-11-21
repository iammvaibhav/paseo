import { decodeString } from "micromark-util-decode-string";
import { maskMarkdownCode } from "./code-mask";

export interface MarkdownTextSegment {
  kind: "markdown";
  id: string;
  source: string;
}

export interface MarkdownDetailsSegment {
  kind: "details";
  id: string;
  summary: string;
  body: string;
  open: boolean;
}

export type MarkdownSegment = MarkdownTextSegment | MarkdownDetailsSegment;

const DETAILS_TAG = /<(\/?)details(?=[\s>])[^>]*>/gi;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

function summaryText(html: string): string {
  return decodeString(
    html
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Top-level `<details>` elements that start a line become collapsible sections; the engine
 * would show their summary and body expanded. Code spans and fences keep their source. An
 * element still open at the end (a streaming reply) runs to the end of the source.
 */
export function splitDetailsBlocks(source: string): MarkdownSegment[] {
  if (!/<details[\s>]/i.test(source)) return [{ kind: "markdown", id: "0", source }];
  const masked = maskMarkdownCode(source);
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let depth = 0;
  let open: { start: number; tag: string; end: number } | null = null;
  const pushMarkdown = (end: number) => {
    const text = source.slice(cursor, end);
    if (text.trim()) segments.push({ kind: "markdown", id: String(segments.length), source: text });
  };
  const pushDetails = (closeStart: number) => {
    if (!open) return;
    const inner = source.slice(open.end, closeStart);
    const summary = SUMMARY.exec(inner);
    segments.push({
      kind: "details",
      id: String(segments.length),
      summary: summary ? summaryText(summary[1]) : "",
      body: (summary ? inner.slice(summary[0].length) : inner).replace(/^\s*\n|\s+$/g, ""),
      open: /\sopen(?=[\s=>])/i.test(open.tag),
    });
  };
  for (const match of masked.matchAll(DETAILS_TAG)) {
    const closing = match[1] === "/";
    if (!closing) {
      if (depth === 0) {
        const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
        if (!/^ {0,3}$/.test(source.slice(lineStart, match.index))) continue;
        pushMarkdown(match.index);
        open = { start: match.index, tag: match[0], end: match.index + match[0].length };
      }
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth > 0) continue;
    pushDetails(match.index);
    open = null;
    cursor = match.index + match[0].length;
  }
  if (open) {
    pushDetails(source.length);
    cursor = source.length;
  }
  pushMarkdown(source.length);
  return segments.length > 0 ? segments : [{ kind: "markdown", id: "0", source }];
}
