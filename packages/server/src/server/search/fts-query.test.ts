import { describe, expect, it } from "vitest";
import { toFtsQuery } from "./fts-query.js";

describe("toFtsQuery", () => {
  it("turns bare words into AND-of-prefixes", () => {
    expect(toFtsQuery("warm pool")).toBe("warm* AND pool*");
  });

  it("keeps a quoted phrase as a phrase", () => {
    expect(toFtsQuery('"exact phrase"')).toBe('"exact phrase"');
  });

  it("treats a pasted URL as a phrase so slashes stay one token", () => {
    expect(toFtsQuery("https://github.com/getpaseo/paseo/pull/12")).toBe(
      '"https://github.com/getpaseo/paseo/pull/12"',
    );
  });

  it("treats a github pull path as a phrase", () => {
    expect(toFtsQuery("github.com/getpaseo/paseo/pull/12")).toBe(
      '"github.com/getpaseo/paseo/pull/12"',
    );
  });

  it("returns null for a stopword-only query", () => {
    expect(toFtsQuery("the")).toBeNull();
    expect(toFtsQuery("  and  ")).toBeNull();
  });

  it("returns null for a blank query", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
  });

  it("keeps a lone content word even next to stopwords", () => {
    expect(toFtsQuery("the stripe")).toBe("the* AND stripe*");
  });
});
