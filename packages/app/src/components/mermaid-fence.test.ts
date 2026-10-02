import { describe, expect, it } from "vitest";
import { isMermaidFenceLanguage, stripTerminalFenceNewline } from "./mermaid-fence";

describe("isMermaidFenceLanguage", () => {
  it("detects mermaid fence info strings", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("MERMAID")).toBe(true);
    expect(isMermaidFenceLanguage(" mermaid ")).toBe(true);
    expect(isMermaidFenceLanguage(".mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("mermaid theme=dark")).toBe(true);
  });

  it("rejects non-mermaid languages and empty info", () => {
    expect(isMermaidFenceLanguage(null)).toBe(false);
    expect(isMermaidFenceLanguage(undefined)).toBe(false);
    expect(isMermaidFenceLanguage("")).toBe(false);
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("markdown")).toBe(false);
  });
});

describe("stripTerminalFenceNewline", () => {
  it("removes a single trailing newline", () => {
    expect(stripTerminalFenceNewline("graph LR\n  A --> B\n")).toBe("graph LR\n  A --> B");
  });

  it("leaves content without a trailing newline unchanged", () => {
    expect(stripTerminalFenceNewline("graph LR")).toBe("graph LR");
  });
});
