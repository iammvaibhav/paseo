import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import { streamDirectoryAsZip } from "./zip-directory.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function collectZipBytes(absoluteDir: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
  });
  await streamDirectoryAsZip(absoluteDir, out);
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

describe("streamDirectoryAsZip", () => {
  test("zips nested files into a downloadable archive", async () => {
    const root = makeDir("paseo-zip-dir-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, "src", "main.ts"), "export {};\n");

    const bytes = await collectZipBytes(root);
    const files = unzipSync(bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual(["README.md", "src/main.ts"]);
    expect(new TextDecoder().decode(files["README.md"])).toBe("# hi\n");
    expect(new TextDecoder().decode(files["src/main.ts"])).toBe("export {};\n");
  });

  test("skips symbolic links", async () => {
    const root = makeDir("paseo-zip-symlink-");
    writeFileSync(join(root, "keep.txt"), "safe\n");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync("/etc/passwd", join(root, "escape"));
    } catch {
      // Windows or restricted environments may not allow symlinks.
      return;
    }

    const bytes = await collectZipBytes(root);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(["keep.txt"]);
  });
});
