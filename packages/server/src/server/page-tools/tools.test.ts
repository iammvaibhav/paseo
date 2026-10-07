import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoToolResult } from "../agent/tools/types.js";
import { PageStore } from "./page-store.js";
import { registerPageTools } from "./tools.js";

type Handler = (input: unknown) => Promise<PaseoToolResult>;

describe("show_page", () => {
  let dir: string;
  let store: PageStore;
  let showPage: Handler;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "page-tools-"));
    store = new PageStore(path.join(dir, "home"));
    const handlers = new Map<string, Handler>();
    registerPageTools({
      registerTool: (name, _config, handler) => handlers.set(name, handler as Handler),
      previewBrowser: { capture: async () => ({ kind: "failed", message: "unused" }) },
      pageStore: store,
      resolveCallerCwd: () => dir,
    });
    showPage = handlers.get("show_page")!;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes a file by path and returns an id whose content outlives the file", async () => {
    const html = "<div class='p-card'>hello</div>";
    await writeFile(path.join(dir, "page.html"), html);

    const result = await showPage({ title: "Hello", path: "page.html" });

    const text = result.content.map((block) => block.text ?? "").join(" ");
    const pageId = /pg_[0-9a-f]{24}/.exec(text)?.[0];
    expect(result.isError).toBeUndefined();
    expect(pageId).toBeDefined();
    await rm(path.join(dir, "page.html"));
    expect(await store.get(pageId!)).toBe(html);
  });

  it("rejects a file or html that holds no markup", async () => {
    await writeFile(path.join(dir, "notes.txt"), "just text");

    const fromFile = await showPage({ title: "x", path: "notes.txt" });
    const fromShell = await showPage({ title: "x", html: "$(cat /tmp/page.html)" });

    expect(fromFile.isError).toBe(true);
    expect(fromShell.isError).toBe(true);
  });

  it("returns the read error for a missing file", async () => {
    const result = await showPage({ title: "x", path: "missing.html" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("missing.html");
  });
});

describe("PageStore", () => {
  it("refuses ids that are not page ids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "page-store-"));
    try {
      const store = new PageStore(dir);
      expect(await store.get("../../etc/passwd")).toBeNull();
      expect(await store.get(`pg_${"0".repeat(24)}`)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
