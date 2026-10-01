import { describe, expect, it } from "vitest";
import { noteListQueryKey, notesQueryRoot } from "./query-keys";
import {
  findActiveNoteMention,
  applyNoteMentionReplacement,
  injectNoteMentions,
  resolveAndInjectNoteMentions,
  deriveNoteTitle,
  NOTE_MENTION_PATTERN,
} from "./mentions";

describe("noteListQueryKey", () => {
  it("scopes every filter under one host root", () => {
    expect(noteListQueryKey("h1", {})).toEqual(["notes", "h1", "list", "", "", "", ""]);
    expect(noteListQueryKey("h1", { query: "q", tag: "t", projectKey: "p", limit: 10 })).toEqual([
      "notes",
      "h1",
      "list",
      "q",
      "t",
      "p",
      10,
    ]);
    expect(notesQueryRoot("h1")).toEqual(["notes", "h1"]);
  });
});

describe("findActiveNoteMention", () => {
  it("detects @note/ under the cursor", () => {
    expect(findActiveNoteMention({ text: "see @note/my-slug", cursorIndex: 17 })).toEqual({
      start: 4,
      end: 17,
      query: "my-slug",
    });
  });

  it("returns null away from a mention", () => {
    expect(findActiveNoteMention({ text: "hello world", cursorIndex: 5 })).toBeNull();
    expect(findActiveNoteMention({ text: "@note/slug trailing", cursorIndex: 17 })).toBeNull();
  });

  it("matches the contract detection regex", () => {
    NOTE_MENTION_PATTERN.lastIndex = 0;
    const matches = [..."see @note/my-slug and @note/other_1".matchAll(NOTE_MENTION_PATTERN)];
    expect(matches.map((match) => match[2])).toEqual(["my-slug", "other_1"]);
  });
});

describe("applyNoteMentionReplacement", () => {
  it("replaces the active token with the picked slug", () => {
    const mention = findActiveNoteMention({ text: "see @note/my", cursorIndex: 11 });
    expect(mention).not.toBeNull();
    expect(
      applyNoteMentionReplacement({
        text: "see @note/my",
        mention: { start: 4, end: 12, query: "my" },
        slug: "my-slug",
      }),
    ).toBe("see @note/my-slug ");
  });
});

describe("injectNoteMentions", () => {
  const resolve = (slug: string) =>
    slug === "my-slug" ? { title: "My note", body: "body text" } : null;

  it("appends a byte-identical fenced block per resolvable mention", () => {
    expect(injectNoteMentions({ text: "see @note/my-slug", resolve })).toBe(
      'see @note/my-slug\n\n---\nReferenced note "My note":\n\nbody text',
    );
  });

  it("leaves unresolved slugs literal and dedupes repeats", () => {
    expect(
      injectNoteMentions({ text: "@note/missing and @note/my-slug and @note/my-slug", resolve }),
    ).toBe(
      '@note/missing and @note/my-slug and @note/my-slug\n\n---\nReferenced note "My note":\n\nbody text',
    );
  });

  it("returns text unchanged without resolvable mentions", () => {
    expect(injectNoteMentions({ text: "no mentions", resolve })).toBe("no mentions");
    expect(injectNoteMentions({ text: "@note/missing", resolve })).toBe("@note/missing");
  });
});
describe("resolveAndInjectNoteMentions", () => {
  const resolveAsync = async (slug: string) =>
    slug === "my-slug" ? { title: "My note", body: "body text" } : null;

  it("resolves asynchronously and appends fenced block", async () => {
    const result = await resolveAndInjectNoteMentions({
      text: "see @note/my-slug",
      resolve: resolveAsync,
    });
    expect(result).toBe('see @note/my-slug\n\n---\nReferenced note "My note":\n\nbody text');
  });
});

describe("deriveNoteTitle", () => {
  it("uses the first non-empty line without heading marks", () => {
    expect(deriveNoteTitle("# Hello\nworld")).toBe("Hello");
    expect(deriveNoteTitle("\n\n  \nbody")).toBe("body");
    expect(deriveNoteTitle("")).toBe("Untitled note");
  });
});
