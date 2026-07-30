import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../../../atomic-file.js";

/**
 * The subset of an OMP session-file entry a fork has to understand. Everything
 * else passes through untouched, because a fork copies entries verbatim rather
 * than re-deriving them.
 */
const OmpSessionFileEntrySchema = z
  .object({
    type: z.string().optional(),
    id: z.string().optional(),
    parentId: z.string().nullable().optional(),
    message: z.object({ role: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

type OmpSessionFileEntry = z.infer<typeof OmpSessionFileEntrySchema>;

/**
 * OMP has no session-fork RPC — `branch` rewinds the LIVE session in place, which
 * a fork must never do. But an OMP session is a self-contained append-only JSONL
 * file that `--session <path>` resumes, and every entry carries `id`/`parentId`,
 * so the file is an entry tree whose active branch is the chain ending at the
 * last entry. That makes a non-destructive fork a prefix copy: keep every entry
 * through the end of the boundary turn, mint a fresh session id, and the last
 * kept entry becomes the fork's head. Entries left unreachable by an earlier
 * in-place branch stay exactly as unreachable as they were in the source.
 */
export interface OmpSessionForkPlan {
  /** Session id minted for the fork and written into the copied `session` entry. */
  sessionId: string;
  /** Full contents of the forked session file. */
  contents: string;
}

export type OmpSessionForkBoundary =
  /**
   * End the fork after the turn opened by this user prompt entry, dropping
   * everything from the next prompt onward.
   */
  | { kind: "user_entry"; entryId: string }
  /**
   * End the fork at the last user prompt, dropping the turn still streaming
   * after it. Resuming a session whose head is a half-written assistant turn can
   * leave an unanswered tool call as the last entry, which is not a valid point
   * to append a new prompt — the caller carries that in-flight work forward as
   * context text instead.
   */
  | { kind: "last_prompt" };

export function planOmpSessionFork(input: {
  /** Raw contents of the source session file. */
  source: string;
  /** Where the fork's history ends. Omit to copy the session up to its head. */
  boundary?: OmpSessionForkBoundary | null;
  sessionId: string;
  timestamp: Date;
}): OmpSessionForkPlan {
  const entries = parseOmpSessionEntries(input.source);
  const headerIndex = entries.findIndex((entry) => entry.entry.type === "session");
  if (headerIndex < 0) {
    throw new Error("OMP session file has no session header entry to fork from");
  }
  const sourceSessionId = entries[headerIndex]?.entry.id ?? null;
  const end = resolveForkEnd(entries, input.boundary);
  if (end <= headerIndex) {
    throw new Error("OMP fork boundary precedes the session header entry");
  }

  const lines: string[] = [];
  for (let index = 0; index < end; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (index === headerIndex) {
      lines.push(
        JSON.stringify({
          ...entry.entry,
          id: input.sessionId,
          timestamp: input.timestamp.toISOString(),
        }),
      );
      continue;
    }
    // Some OMP versions root the entry chain at the session header, so the new
    // session id has to follow into any entry that pointed at the old one.
    if (sourceSessionId && entry.entry.parentId === sourceSessionId) {
      lines.push(JSON.stringify({ ...entry.entry, parentId: input.sessionId }));
      continue;
    }
    lines.push(entry.text);
  }

  return { sessionId: input.sessionId, contents: `${lines.join("\n")}\n` };
}

interface OmpSessionFileLine {
  text: string;
  entry: OmpSessionFileEntry;
}

function parseOmpSessionEntries(source: string): OmpSessionFileLine[] {
  const entries: OmpSessionFileLine[] = [];
  for (const line of source.split("\n")) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A live session's last line can be a partially flushed write, and OMP
      // itself cannot read an unparseable entry either. Dropping it is the only
      // way to hand the fork a file that parses.
      continue;
    }
    const parsed = OmpSessionFileEntrySchema.safeParse(value);
    if (parsed.success) {
      entries.push({ text, entry: parsed.data });
    }
  }
  return entries;
}

/** Exclusive index of the last entry the fork keeps. */
function resolveForkEnd(
  entries: readonly OmpSessionFileLine[],
  boundary: OmpSessionForkBoundary | null | undefined,
): number {
  if (boundary?.kind === "last_prompt") {
    const lastPrompt = entries.findLastIndex((entry) => isUserPrompt(entry.entry));
    // No prompt at all means no turn to leave behind, so the head is the cut.
    return lastPrompt < 0 ? entries.length : lastPrompt + 1;
  }
  if (boundary?.kind !== "user_entry") {
    return entries.length;
  }
  const entryId = boundary.entryId.trim();
  const boundaryIndex = entries.findIndex((entry) => entry.entry.id === entryId);
  if (boundaryIndex < 0) {
    throw new Error(`OMP session file has no entry ${entryId} to fork at`);
  }
  if (!isUserPrompt(entries[boundaryIndex]?.entry)) {
    throw new Error(`OMP session entry ${entryId} is not a user message`);
  }
  const nextPrompt = entries.findIndex(
    (entry, index) => index > boundaryIndex && isUserPrompt(entry.entry),
  );
  return nextPrompt < 0 ? entries.length : nextPrompt;
}

/**
 * Write a forked copy of `sessionFile` next to it, named the way OMP names its
 * own sessions (`<dashed ISO timestamp>_<session id>.jsonl`) so it shows up
 * correctly in OMP's own session listing and Paseo's session import.
 */
export async function forkOmpSessionFile(input: {
  sessionFile: string;
  boundary?: OmpSessionForkBoundary | null;
  now?: Date;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const timestamp = input.now ?? new Date();
  const sessionId = mintUuidV7(timestamp);
  const plan = planOmpSessionFork({
    source: await readFile(input.sessionFile, "utf8"),
    boundary: input.boundary,
    sessionId,
    timestamp,
  });
  const stamp = timestamp.toISOString().replaceAll(":", "-").replace(".", "-");
  const forkFile = path.join(path.dirname(input.sessionFile), `${stamp}_${sessionId}.jsonl`);
  await writeFileAtomic(forkFile, plan.contents);
  return { sessionId, sessionFile: forkFile };
}

/**
 * OMP session ids are UUIDv7. The fork mints one instead of reusing `randomUUID`
 * so the id keeps its embedded creation timestamp, which is what makes OMP's
 * session listing sort and `--resume <prefix>` behave for the forked session.
 */
function mintUuidV7(timestamp: Date): string {
  const random = randomBytes(10);
  random[0] = ((random[0] ?? 0) & 0x0f) | 0x70;
  random[2] = ((random[2] ?? 0) & 0x3f) | 0x80;
  const hex = timestamp.getTime().toString(16).padStart(12, "0") + random.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUserPrompt(entry: OmpSessionFileEntry | undefined): boolean {
  // OMP records tool output under its own `toolResult` role, so `user` is only
  // ever a real prompt — exactly the entries `get_branch_messages` exposes as the
  // branch anchors Paseo already tracks as user message ids.
  return entry?.type === "message" && entry.message?.role === "user";
}
