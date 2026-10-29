import { CODE_MASK, maskMarkdownCode } from "./code-mask";

const MATH_SYNTAX = new RegExp(
  [
    // \[ display \]
    String.raw`\\\[([^${CODE_MASK}]+?)\\\]`,
    // \( inline \)
    String.raw`\\\(([^${CODE_MASK}\n]+?)\\\)`,
    // A bare "[" line, TeX lines, then a "]" line. Some models (Grok) drop the backslashes.
    String.raw`^[ \t]*\[[ \t]*\n([^${CODE_MASK}]+?)\n[ \t]*\][ \t]*$`,
    // A lone "$" between whitespace: a shell prompt or a price, never a math opener. The
    // closing "$" of `$r$ is` is followed by a space too, so it must not count.
    String.raw`(?<=^|[ \t])\$(?!\$)(?=[ \t])`,
  ].join("|"),
  "gm",
);

/**
 * Assistant replies write TeX several ways; the engine reads only `$…$` and `$$…$$`.
 * Rewrite `\(…\)`, `\[…\]` and bare `[ … ]` blocks whose first line is a TeX command to
 * dollar delimiters, and escape a lone `$` before whitespace so `$ npm test` stays text.
 * Code spans and fences keep their source.
 */
export function normalizeMathDelimiters(source: string): string {
  if (!/\\[[(]|^[ \t]*\[[ \t]*$|\$[ \t]/m.test(source)) return source;
  const masked = maskMarkdownCode(source);
  let result = "";
  let cursor = 0;
  for (const match of masked.matchAll(MATH_SYNTAX)) {
    const [whole, display, inline, bareBlock] = match;
    let replacement: string | null = null;
    if (display !== undefined) replacement = `$$${display}$$`;
    else if (inline !== undefined) replacement = `$${inline}$`;
    else if (bareBlock !== undefined) {
      if (/^\s*\\[a-zA-Z{]/.test(bareBlock)) replacement = `$$\n${bareBlock}\n$$`;
    } else replacement = "\\$";
    if (replacement === null) continue;
    result += source.slice(cursor, match.index) + replacement;
    cursor = match.index + whole.length;
  }
  return result + source.slice(cursor);
}
