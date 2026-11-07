import { describe, expect, it } from "vitest";
import { toFtsQueries } from "./fts-query.js";

describe("toFtsQueries", () => {
  it("ranks the exact phrase, then the words near each other, then AND-of-prefixes", () => {
    expect(toFtsQueries("warm pool")).toEqual([
      '"warm pool"*',
      'NEAR("warm"* "pool"*, 5)',
      "warm* AND pool*",
    ]);
  });

  it("turns a single word into one prefix query", () => {
    expect(toFtsQueries("stripe")).toEqual(["stripe*"]);
  });

  it("keeps a quoted phrase as a phrase", () => {
    expect(toFtsQueries('"exact phrase"')).toEqual(['"exact phrase"']);
  });

  it("treats a pasted URL as a phrase so slashes stay one token", () => {
    expect(toFtsQueries("https://github.com/getpaseo/paseo/pull/12")).toEqual([
      '"https://github.com/getpaseo/paseo/pull/12"',
    ]);
  });

  it("treats a github pull path as a phrase", () => {
    expect(toFtsQueries("github.com/getpaseo/paseo/pull/12")).toEqual([
      '"github.com/getpaseo/paseo/pull/12"',
    ]);
  });

  it("returns no query for a stopword-only query", () => {
    expect(toFtsQueries("the")).toEqual([]);
    expect(toFtsQueries("  and  ")).toEqual([]);
  });

  it("returns no query for a blank query", () => {
    expect(toFtsQueries("")).toEqual([]);
    expect(toFtsQueries("   ")).toEqual([]);
  });

  it("keeps a lone content word even next to stopwords", () => {
    expect(toFtsQueries("the stripe")).toEqual([
      '"the stripe"*',
      'NEAR("the"* "stripe"*, 5)',
      "the* AND stripe*",
    ]);
  });
});
