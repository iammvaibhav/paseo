import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import type { Writable } from "node:stream";

/**
 * Stream a directory as a zip archive into `out`.
 * Symlinks are skipped (avoids escaping the sandbox via linked paths).
 * Empty directories are omitted (zip stores files only).
 */
export async function streamDirectoryAsZip(absoluteDir: string, out: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const zip = new Zip((error, data, final) => {
      if (error) {
        fail(error);
        return;
      }
      if (data.length > 0) {
        const ok = out.write(Buffer.from(data));
        if (!ok) {
          // Backpressure: fflate does not pause; rare for download sockets.
        }
      }
      if (final) {
        out.end();
        succeed();
      }
    });

    out.on("error", fail);

    void (async () => {
      try {
        await walkAndAdd(absoluteDir, "", zip);
        zip.end();
      } catch (error) {
        try {
          zip.terminate();
        } catch {
          // ignore
        }
        fail(error);
      }
    })();
  });
}

async function walkAndAdd(absoluteDir: string, relativePrefix: string, zip: Zip): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  // Stable order for deterministic zips in tests.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      continue;
    }

    // Skip symlinks so a link cannot pull data from outside the sandboxed root.
    if (stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      await walkAndAdd(absolutePath, relativePath, zip);
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    await addFileToZip(absolutePath, relativePath, zip);
  }
}

function addFileToZip(absolutePath: string, relativePath: string, zip: Zip): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = new ZipPassThrough(relativePath.replace(/\\/g, "/"));
    zip.add(file);

    const stream = createReadStream(absolutePath);
    stream.on("error", (error) => {
      try {
        file.push(new Uint8Array(), true);
      } catch {
        // ignore double-end
      }
      reject(error);
    });
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      file.push(new Uint8Array(bytes));
    });
    stream.on("end", () => {
      file.push(new Uint8Array(), true);
      resolve();
    });
  });
}
