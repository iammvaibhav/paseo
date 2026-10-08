/**
 * Pure formatting helpers for the selection Ask feature.
 *
 * The quote block is the `> …` blockquote form of the selected markdown. The
 * composer block separates quote and comment with a `....` divider; the
 * side-ask first prompt instead labels each part ("Selected text from the
 * parent chat:" / "Question about that selection:") so the model can tell the
 * selection from the question. Kept DOM-free so the exact strings are
 * unit-testable.
 */

import type { AssistantMessageItem, StreamItem } from "@/types/stream";

/** One rendered row of the ask's conversation thread. */
export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Internal shape: extra fields used to coalesce a streamed reply into one row. */
interface AskThreadMessage extends AskMessage {
  blockGroupId?: string;
  messageId?: string;
}

/**
 * Builds the ask's full conversation from the merged head/tail stream. Only
 * `user_message` and `assistant_message` rows participate (tool calls and
 * thoughts are dropped). The head is the still-streaming tail, so an
 * assistant row there is coalesced into the thread's trailing assistant row
 * when it is a continuation — same block group (block promotion keeps
 * completed blocks in the tail while the live block streams in the head),
 * same provider message id (a resumed stream after a flush), or a plain text
 * prefix — instead of appending a duplicate bubble.
 */
export function buildAskThreadMessages(
  tail: readonly StreamItem[] | undefined,
  head: readonly StreamItem[] | undefined,
): AskMessage[] {
  const messages: AskThreadMessage[] = [];
  const appendAssistant = (item: AssistantMessageItem) => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      if (item.blockGroupId && last.blockGroupId === item.blockGroupId) {
        last.text = `${last.text}\n\n${item.text}`;
        return;
      }
      if (item.messageId && last.messageId === item.messageId) {
        last.text = item.text;
        return;
      }
      if (item.text.startsWith(last.text)) {
        last.text = item.text;
        return;
      }
    }
    messages.push({
      id: item.id,
      role: "assistant",
      text: item.text,
      blockGroupId: item.blockGroupId,
      messageId: item.messageId,
    });
  };
  for (const item of tail ?? []) {
    if (item.kind === "user_message") {
      messages.push({ id: item.id, role: "user", text: item.text });
    } else if (item.kind === "assistant_message") {
      appendAssistant(item);
    }
  }
  for (const item of head ?? []) {
    if (item.kind === "assistant_message") {
      appendAssistant(item);
    }
  }
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
  }));
}

export const SELECTION_ASK_INTRO =
  "You are answering a side ask about a selection from the parent chat.\n" +
  "Only answer the question. Do not make any changes unless the user explicitly asks you to.";

/** Appended when a selection exists but no question was provided yet. */
export const SELECTION_ASK_NO_QUESTION =
  "No question yet. Answer based on the selection alone, or wait for the user to ask a question about it.";

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
 *     You are answering a side ask about a selection from the parent chat.
 *     Only answer the question. Do not make any changes unless the user
 *     explicitly asks you to.
 *
 *     Selected text from the parent chat:
 *     > selection
 *
 *     Question about that selection:
 *     question
 *
 * Selection and question are each optional and each labeled, so the model can
 * tell the quoted source text apart from the user's question. A selection
 * without a question gets a note telling the model to answer from the
 * selection alone or wait for the question.
 */
export function buildSelectionAskPrompt(input: { selection: string; question?: string }): string {
  const quote = quoteSelection(input.selection);
  const question = input.question?.trim() ?? "";
  const parts = [SELECTION_ASK_INTRO];
  if (quote) {
    parts.push(`Selected text from the parent chat:\n${quote}`);
  }
  if (question) {
    parts.push(`Question about that selection:\n${question}`);
  } else if (quote) {
    parts.push(SELECTION_ASK_NO_QUESTION);
  }
  return parts.join("\n\n");
}
