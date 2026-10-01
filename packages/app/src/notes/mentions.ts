import type { NoteSummary } from "@getpaseo/protocol/notes/types";

/**
 * `@note/<slug>` mentions. The client owns detection and injection: before
 * send, every resolvable mention's full markdown body is appended to the
 * submitted text as a fenced block. The block shape is byte-identical to the
 * contract (`/data/quarterdeck/.dev/contracts/notes.md`) so prompts match
 * across clients. Unresolved slugs stay literal.
 */

export const NOTE_MENTION_PATTERN = /(^|\s)@note\/([A-Za-z0-9_-]+)/g;
const NOTE_MENTION_ACTIVE_PATTERN = /(^|\s)@note\/([A-Za-z0-9_-]*)$/;

export interface NoteMentionRange {
  start: number;
  end: number;
  query: string;
}

interface FindActiveNoteMentionInput {
  text: string;
  cursorIndex: number;
}

/**
 * The `@note/` token under the cursor, for autocomplete. Returns null when
 * the cursor is not directly after a mention-shaped token.
 */
export function findActiveNoteMention(input: FindActiveNoteMentionInput): NoteMentionRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);
  const match = NOTE_MENTION_ACTIVE_PATTERN.exec(beforeCursor);
  if (!match) {
    return null;
  }
  const leading = match[1] ?? "";
  const query = match[2] ?? "";
  const end = clampedCursor;
  const start = end - query.length - "@note/".length;
  void leading;
  return { start, end, query };
}

interface ApplyNoteMentionReplacementInput {
  text: string;
  mention: NoteMentionRange;
  slug: string;
}

export function applyNoteMentionReplacement(input: ApplyNoteMentionReplacementInput): string {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  return `${before}${needsSpace ? " " : ""}@note/${input.slug} ${after}`;
}

/** First ~200 chars of markdown, for the mention picker's detail line. */
export function deriveNotePickerDetail(note: Pick<NoteSummary, "preview" | "tags">): string {
  const tags = note.tags.length > 0 ? ` · #${note.tags.join(" #")}` : "";
  return `${note.preview}${tags}`;
}

export interface InjectedNote {
  title: string;
  body: string;
}

interface InjectNoteMentionsInput {
  text: string;
  resolve: (slug: string) => InjectedNote | null;
}

function renderInjectedNoteBlock(note: InjectedNote): string {
  return `---\nReferenced note "${note.title}":\n\n${note.body}`;
}

/**
 * Append one fenced block per resolvable `@note/<slug>` mention, in mention
 * order. Detection is `(^|\s)@note/([A-Za-z0-9_-]+)`; unresolved slugs stay
 * literal. Duplicate mentions of one slug inject once.
 */
export function injectNoteMentions(input: InjectNoteMentionsInput): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  NOTE_MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NOTE_MENTION_PATTERN.exec(input.text)) !== null) {
    const slug = match[2] ?? "";
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const note = input.resolve(slug);
    if (note) {
      blocks.push(renderInjectedNoteBlock(note));
    }
  }
  if (blocks.length === 0) {
    return input.text;
  }
  return `${input.text}\n\n${blocks.join("\n\n")}`;
}
/**
 * Async variant of injectNoteMentions that supports fetching note details on miss.
 */
export async function resolveAndInjectNoteMentions(input: {
  text: string;
  resolve: (slug: string) => Promise<InjectedNote | null> | InjectedNote | null;
}): Promise<string> {
  const seen = new Set<string>();
  const blocks: string[] = [];
  NOTE_MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NOTE_MENTION_PATTERN.exec(input.text)) !== null) {
    const slug = match[2] ?? "";
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const note = await input.resolve(slug);
    if (note) {
      blocks.push(renderInjectedNoteBlock(note));
    }
  }
  if (blocks.length === 0) {
    return input.text;
  }
  return `${input.text}\n\n${blocks.join("\n\n")}`;
}

/** Title fallback when creating a note from body text: first line, ~80 chars. */
export function deriveNoteTitle(body: string, maxLength = 80): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "Untitled note";
  }
  return firstLine.length > maxLength
    ? `${firstLine.slice(0, maxLength - 1).trimEnd()}…`
    : firstLine;
}
