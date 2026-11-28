import { describe, expect, it } from "vitest";
import { decodeBase64 } from "./base64";

const HELLO_BYTES = [104, 101, 108, 108, 111, 63, 62];

describe("decodeBase64", () => {
  it("decodes padded standard base64", () => {
    expect(Array.from(decodeBase64("aGVsbG8/Pg==") ?? [])).toEqual(HELLO_BYTES);
  });

  it("decodes base64url without padding", () => {
    expect(Array.from(decodeBase64("aGVsbG8_Pg") ?? [])).toEqual(HELLO_BYTES);
  });

  it("ignores whitespace and line breaks", () => {
    expect(Array.from(decodeBase64(" aGVs\nbG8/\r\nPg== ") ?? [])).toEqual(HELLO_BYTES);
  });

  it("decodes an empty payload to no bytes", () => {
    expect(decodeBase64("")).toEqual(new Uint8Array());
  });

  it.each([
    ["a payload cut by the daemon's size limit", "iVBORw0KGgoAAAA…[truncated 38.4 KB]"],
    ["a provider blob reference", "blob:sha256:9f2cf700cd0bf48bade5e1a31a921faae501f099"],
    ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
    ["padding before the end", "aGVs=bG8="],
    ["a length that cannot encode a whole byte", "aGVsb"],
  ])("returns null for %s", (_label, input) => {
    expect(decodeBase64(input)).toBeNull();
  });
});
