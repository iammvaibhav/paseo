import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { writeFileAtomic } from "./atomic-file.js";

// The journal is rewritten down to its pending watches past this size.
const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;

/**
 * An append-only JSONL record of watch transitions, keyed by watchId. Finish
 * watches use it to survive a daemon restart: the next process reads it back
 * and restores the watches it still shows pending. It doubles as the
 * queryable record of what was armed, fired and delivered.
 */
export interface WatchJournal<E extends { watchId: string }> {
  /** Queue an entry; entries land in call order. A failed write is logged, never thrown. */
  append(entry: E): void;
  /** Resolves once every queued entry is on disk. */
  flush(): Promise<void>;
  /**
   * Every entry on disk, in order. Past the compaction size the file is
   * rewritten to the entries of the watches `pendingIds` keeps.
   */
  read(pendingIds: (entries: readonly E[]) => ReadonlySet<string>): Promise<E[]>;
}

export function createWatchJournal<E extends { watchId: string }>(options: {
  path: string;
  logger: Logger;
}): WatchJournal<E> {
  const { path: journalPath, logger } = options;
  let writes: Promise<void> = Promise.resolve();
  let dirReady = false;

  const write = async (entry: E) => {
    try {
      if (!dirReady) {
        await fs.mkdir(path.dirname(journalPath), { recursive: true });
        dirReady = true;
      }
      await fs.appendFile(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      logger.error(
        { err: String(error), watchId: entry.watchId, journalPath },
        "watch journal write failed",
      );
    }
  };

  return {
    append(entry) {
      writes = writes.then(() => write(entry));
    },

    flush: () => writes,

    async read(pendingIds) {
      let raw: string;
      try {
        raw = await fs.readFile(journalPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const entries: E[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as E);
        } catch {
          // A torn final line from a crash mid-append; the rest of the journal stands.
        }
      }
      if (Buffer.byteLength(raw) > JOURNAL_COMPACT_BYTES) {
        const keep = pendingIds(entries);
        const kept = entries.filter((entry) => keep.has(entry.watchId));
        await writeFileAtomic(
          journalPath,
          kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
        );
      }
      return entries;
    },
  };
}
