import { describe, expect, it } from "vitest";
import { filterClarificationOptions, isFreeTextSentinelOption } from "./clarification-card-options";

describe("isFreeTextSentinelOption", () => {
  it.each([
    "Other",
    "Other…",
    "Other...",
    "Other.",
    "Other (say what you need)",
    "Other (specify)",
    "Other (please specify)",
    "other answer",
    "Something else",
    "Something else…",
    "Type your own",
    "Type your own answer",
    "Write your own",
    "Enter your own",
    "Custom",
  ])("recognizes the conventional free-text sentinel %j", (option) => {
    expect(isFreeTextSentinelOption(option)).toBe(true);
  });

  it("recognizes sentinels with stray casing and whitespace", () => {
    expect(isFreeTextSentinelOption("  OTHER  ")).toBe(true);
    expect(isFreeTextSentinelOption("Something   Else")).toBe(true);
    expect(isFreeTextSentinelOption("type YOUR own (describe below)")).toBe(true);
  });

  it.each([
    "Other host",
    "Other host (dev)",
    "Something else entirely",
    "Type your own message",
    "Custom rules",
    "Restart",
    "Update now",
    "Use workspace-a",
    "Ask me later",
  ])("leaves the ordinary option %j alone", (option) => {
    expect(isFreeTextSentinelOption(option)).toBe(false);
  });
});

describe("filterClarificationOptions", () => {
  it("drops sentinel options but keeps ordinary options in order when free text is allowed", () => {
    const options = [
      "Restart",
      "Other",
      "Update now",
      "Other (say what you need)",
      "Other host",
      "Something else",
      "Use workspace-a",
      "Type your own",
      "Ask me later",
    ];
    expect(filterClarificationOptions(options, true)).toEqual([
      "Restart",
      "Update now",
      "Other host",
      "Use workspace-a",
      "Ask me later",
    ]);
  });

  it("keeps every option untouched and in order when free text is not allowed", () => {
    const options = ["Other", "Restart", "Something else", "Other host"];
    expect(filterClarificationOptions(options, false)).toEqual(options);
  });

  it("returns an empty list when every option is a sentinel", () => {
    expect(filterClarificationOptions(["Other", "Type your own"], true)).toEqual([]);
  });

  it("handles an empty option list", () => {
    expect(filterClarificationOptions([], true)).toEqual([]);
  });
});
