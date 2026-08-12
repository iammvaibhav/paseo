/**
 * Pure formatting helpers for the selection Ask feature.
 *
 * The quote block is the `> …` blockquote form of the selected markdown; the
 * `....` divider separates the quote from the user's own words in both the
 * composer block and the side-ask first prompt. Kept DOM-free so the exact
 * strings are unit-testable.
 */

export const SELECTION_ASK_INTRO =
  "This is a side ask from a selection in the parent chat. Only answer and make no changes unless the user asks to.";

/** Title length cap, matching the server's derived-title clamp. */
const MAX_SELECTION_ASK_TITLE_CHARS = 60;

function clampTitle(text: string): string | null {
  const clamped = text.replace(/\s+/g, " ").trim().slice(0, MAX_SELECTION_ASK_TITLE_CHARS).trim();
  return clamped.length > 0 ? clamped : null;
}

/**
 * A short, user-derived title for the fork tab. The question wins when the
 * user wrote one, otherwise the first non-empty selection line is used; null
 * means the server should keep deriving the title from the prompt itself.
 */
export function buildSelectionAskTitle(input: {
  question?: string;
  selection?: string;
}): string | null {
  const question = input.question?.trim();
  if (question) {
    return clampTitle(`Ask: ${question}`);
  }
  const firstLine = input.selection
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? clampTitle(firstLine) : null;
}

/** Quote each line of the selection as a blockquote. */
export function quoteSelection(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The block appended to the composer:
 *
 *     > selection
 *     ....
 *     comment
 *
 * A selection with no comment is just the quote.
 */
export function buildSelectionAskBlock(input: { selection: string; comment?: string }): string {
  const quote = quoteSelection(input.selection);
  if (!quote) {
    return "";
  }
  const comment = input.comment?.trim();
  if (!comment) {
    return quote;
  }
  return `${quote}\n....\n${comment}`;
}

/**
 * The first prompt a side-ask agent runs with:
 *
 *     This is a side ask from a selection in the parent chat. Only answer and
 *     make no changes unless the user asks to.
 *
 *     > selection
 *
 *     ....
 *     question
 *
 * Question and selection are each optional; every non-empty part keeps its
 * place so the prompt reads naturally with whatever the user supplied.
 */
export function buildSelectionAskPrompt(input: { selection: string; question?: string }): string {
  const quote = quoteSelection(input.selection);
  const question = input.question?.trim() ?? "";
  const parts = [SELECTION_ASK_INTRO];
  if (quote) {
    parts.push(quote);
  }
  if (question) {
    parts.push(quote ? `....\n${question}` : question);
  }
  return parts.join("\n\n");
}
