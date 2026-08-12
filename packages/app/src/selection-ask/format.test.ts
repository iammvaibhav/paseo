import { describe, expect, it } from "vitest";
import {
  SELECTION_ASK_INTRO,
  buildSelectionAskBlock,
  buildSelectionAskPrompt,
  quoteSelection,
} from "./format";

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
  it("builds the full side-ask prompt with intro, quote, divider, and question", () => {
    const prompt = buildSelectionAskPrompt({ selection: "the selected part", question: "why?" });
    expect(prompt).toBe(`${SELECTION_ASK_INTRO}\n\n> the selected part\n\n....\nwhy?`);
  });

  it("keeps the intro and quote when the question is blank", () => {
    const prompt = buildSelectionAskPrompt({ selection: "the selected part" });
    expect(prompt).toBe(`${SELECTION_ASK_INTRO}\n\n> the selected part`);
  });

  it("keeps the intro and question when the selection is blank", () => {
    const prompt = buildSelectionAskPrompt({ selection: "", question: "just asking" });
    expect(prompt).toBe(`${SELECTION_ASK_INTRO}\n\njust asking`);
  });

  it("trims the question", () => {
    const prompt = buildSelectionAskPrompt({ selection: "s", question: "  why?  " });
    expect(prompt).toContain("\n....\nwhy?");
  });
});
