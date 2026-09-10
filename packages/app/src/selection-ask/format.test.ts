import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  SELECTION_ASK_INTRO,
  SELECTION_ASK_NO_QUESTION,
  buildAskThreadMessages,
  buildSelectionAskBlock,
  buildSelectionAskPrompt,
  buildSelectionAskTitle,
  quoteSelection,
} from "./format";

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(0) };
}

function assistantMessage(
  id: string,
  text: string,
  extra: { messageId?: string; blockGroupId?: string } = {},
): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(0),
    ...(extra.messageId ? { messageId: extra.messageId } : {}),
    ...(extra.blockGroupId ? { blockGroupId: extra.blockGroupId } : {}),
  };
}

describe("quoteSelection", () => {
  it("quotes every line of a multi-line selection", () => {
    expect(quoteSelection("line one\nline two")).toBe("> line one\n> line two");
  });

  it("trims surrounding whitespace", () => {
    expect(quoteSelection("  padded  ")).toBe("> padded");
  });

  it("returns an empty string for blank input", () => {
    expect(quoteSelection("   \n  ")).toBe("");
  });
});

describe("buildSelectionAskBlock", () => {
  it("builds the quote, divider, and comment block", () => {
    expect(
      buildSelectionAskBlock({ selection: "selected text", comment: "what does this mean?" }),
    ).toBe("> selected text\n....\nwhat does this mean?");
  });

  it("quotes multi-line selections inside the block", () => {
    expect(buildSelectionAskBlock({ selection: "a\nb", comment: "comment" })).toBe(
      "> a\n> b\n....\ncomment",
    );
  });

  it("omits the divider when there is no comment", () => {
    expect(buildSelectionAskBlock({ selection: "just the quote" })).toBe("> just the quote");
  });

  it("treats a whitespace-only comment as absent", () => {
    expect(buildSelectionAskBlock({ selection: "text", comment: "   " })).toBe("> text");
  });

  it("returns an empty string for an empty selection", () => {
    expect(buildSelectionAskBlock({ selection: "", comment: "comment" })).toBe("");
  });
});

describe("buildSelectionAskPrompt", () => {
  it("builds the full side-ask prompt with intro, labeled selection, and labeled question", () => {
    const prompt = buildSelectionAskPrompt({ selection: "the selected part", question: "why?" });
    expect(prompt).toBe(
      `${SELECTION_ASK_INTRO}\n\nSelected text from the parent chat:\n> the selected part\n\nQuestion about that selection:\nwhy?`,
    );
  });

  it("labels the selection and notes the missing question when the question is blank", () => {
    const prompt = buildSelectionAskPrompt({ selection: "the selected part" });
    expect(prompt).toBe(
      `${SELECTION_ASK_INTRO}\n\nSelected text from the parent chat:\n> the selected part\n\n${SELECTION_ASK_NO_QUESTION}`,
    );
  });

  it("keeps the intro and labeled question when the selection is blank", () => {
    const prompt = buildSelectionAskPrompt({ selection: "", question: "just asking" });
    expect(prompt).toBe(`${SELECTION_ASK_INTRO}\n\nQuestion about that selection:\njust asking`);
  });

  it("trims the question", () => {
    const prompt = buildSelectionAskPrompt({ selection: "s", question: "  why?  " });
    expect(prompt).toContain("\nQuestion about that selection:\nwhy?");
  });
});

describe("buildSelectionAskTitle", () => {
  it("prefixes the user's question with Ask:", () => {
    expect(buildSelectionAskTitle({ question: "what does this mean?", selection: "x" })).toBe(
      "Ask: what does this mean?",
    );
  });

  it("falls back to the first non-empty selection line when there is no question", () => {
    expect(buildSelectionAskTitle({ selection: "const x = 10;\nconst y = 20;" })).toBe(
      "const x = 10;",
    );
  });

  it("collapses whitespace and clamps long titles", () => {
    const title = buildSelectionAskTitle({
      question: "  explain   this   ",
      selection: "x",
    });
    expect(title).toBe("Ask: explain this");
    const long = buildSelectionAskTitle({ question: "q".repeat(200) });
    expect(long?.length).toBeLessThanOrEqual(60);
    expect(long).toBe(`Ask: ${"q".repeat(55)}`);
  });

  it("returns null when question and selection are both blank", () => {
    expect(buildSelectionAskTitle({ question: "   ", selection: "\n  \n" })).toBeNull();
    expect(buildSelectionAskTitle({})).toBeNull();
  });
});

describe("buildAskThreadMessages", () => {
  it("keeps every user and assistant row in order, including follow-ups", () => {
    const tail = [
      userMessage("prompt", "what is this?"),
      assistantMessage("a1", "first answer"),
      userMessage("follow-up", "and this part?"),
      assistantMessage("a2", "second answer"),
    ];
    expect(buildAskThreadMessages(tail, [])).toEqual([
      { id: "prompt", role: "user", text: "what is this?" },
      { id: "a1", role: "assistant", text: "first answer" },
      { id: "follow-up", role: "user", text: "and this part?" },
      { id: "a2", role: "assistant", text: "second answer" },
    ]);
  });

  it("drops tool calls and thoughts", () => {
    const tail: StreamItem[] = [
      userMessage("prompt", "hi"),
      { kind: "tool_call", id: "t1", timestamp: new Date(0) } as StreamItem,
      assistantMessage("a1", "answer"),
      { kind: "thought", id: "th1", text: "hmm", status: "ready", timestamp: new Date(0) },
    ];
    expect(buildAskThreadMessages(tail, [])).toEqual([
      { id: "prompt", role: "user", text: "hi" },
      { id: "a1", role: "assistant", text: "answer" },
    ]);
  });

  it("merges a streaming head continuation into the trailing assistant row", () => {
    const tail = [userMessage("prompt", "hi"), assistantMessage("a1", "Hel")];
    const head = [assistantMessage("a1-live", "Hello world")];
    expect(buildAskThreadMessages(tail, head)).toEqual([
      { id: "prompt", role: "user", text: "hi" },
      { id: "a1", role: "assistant", text: "Hello world" },
    ]);
  });

  it("appends a new head assistant row when it is not a continuation", () => {
    const tail = [userMessage("prompt", "hi"), assistantMessage("a1", "first")];
    const head = [assistantMessage("a2-live", "second")];
    expect(buildAskThreadMessages(tail, head)).toEqual([
      { id: "prompt", role: "user", text: "hi" },
      { id: "a1", role: "assistant", text: "first" },
      { id: "a2-live", role: "assistant", text: "second" },
    ]);
  });

  it("merges resumed streams with a matching provider message id", () => {
    const tail = [
      userMessage("prompt", "hi"),
      assistantMessage("a1", "partial", { messageId: "m1" }),
    ];
    const head = [assistantMessage("a1-live", "partial, then more", { messageId: "m1" })];
    expect(buildAskThreadMessages(tail, head)).toEqual([
      { id: "prompt", role: "user", text: "hi" },
      { id: "a1", role: "assistant", text: "partial, then more" },
    ]);
  });

  it("joins block-group rows (promoted blocks plus the live head block) into one reply", () => {
    const tail = [
      userMessage("prompt", "hi"),
      assistantMessage("b1", "First block", { blockGroupId: "g1" }),
      assistantMessage("b2", "Second block", { blockGroupId: "g1" }),
    ];
    const head = [assistantMessage("b3-live", "Third block", { blockGroupId: "g1" })];
    expect(buildAskThreadMessages(tail, head)).toEqual([
      { id: "prompt", role: "user", text: "hi" },
      {
        id: "b1",
        role: "assistant",
        text: "First block\n\nSecond block\n\nThird block",
      },
    ]);
  });

  it("returns an empty thread for an empty stream", () => {
    expect(buildAskThreadMessages([], [])).toEqual([]);
    expect(buildAskThreadMessages(undefined, undefined)).toEqual([]);
  });
});
