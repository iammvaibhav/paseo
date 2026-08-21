import { describe, expect, it } from "vitest";
import { isPlannotatorAnnotatableFile } from "./open-file-in-plannotator";

describe("isPlannotatorAnnotatableFile", () => {
  it.each([
    "README.md",
    "plan.mdx",
    "notes.txt",
    "page.html",
    "config.yaml",
    "package.json",
    "settings.toml",
    "server.log",
    ".env.example",
  ])("accepts %s", (path) => {
    expect(isPlannotatorAnnotatableFile(path)).toBe(true);
  });

  it.each(["app.ts", "main.py", "image.png", ".env"])("rejects %s", (path) => {
    expect(isPlannotatorAnnotatableFile(path)).toBe(false);
  });
});
