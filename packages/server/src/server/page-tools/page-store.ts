import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** `pg_` + 24 hex: the id a show_page result carries and the page.content.get key. */
export const PAGE_ID_RE = /^pg_[0-9a-f]{24}$/;

/**
 * Pages an agent published from a file (`show_page` with `path`). The transcript holds only
 * the id, so the page survives the file being edited or deleted, and the agent never has
 * to repeat the markup in a tool call. Content-addressed: publishing the same page twice
 * stores it once.
 */
export class PageStore {
  private readonly dir: string;

  constructor(paseoHome: string) {
    this.dir = path.join(paseoHome, "pages");
  }

  async save(html: string): Promise<string> {
    const id = `pg_${createHash("sha256").update(html).digest("hex").slice(0, 24)}`;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${id}.html`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, html, "utf8");
    await rename(temp, file);
    return id;
  }

  /** The page markup, or null for an unknown or malformed id. */
  async get(id: string): Promise<string | null> {
    if (!PAGE_ID_RE.test(id)) return null;
    try {
      return await readFile(path.join(this.dir, `${id}.html`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
