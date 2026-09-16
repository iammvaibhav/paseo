import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveOmpSessionsDir } from "./session-descriptor.js";
import { encodeOmpSessionDirName } from "./warm-pool.js";

/**
 * Cross-host agent move carries the OMP transcript inline in the transfer
 * message.
 *
 * Why it must be carried at all: an OMP resume handle is an absolute path to a
 * `.jsonl` transcript on the source host (`persistence.nativeHandle`). After a
 * move, `resolveOmpSessionFile` cannot find that path on the target, falls back
 * to a basename search that only accepts files over 2000 bytes, and
 * `ensureResumableSessionFile` then writes a fresh header — so the agent
 * resumes with an empty conversation. Losing the transcript silently is worse
 * than refusing the move.
 *
 * Why a cap: this fleet's transcripts are median 707 B and p90 690 KB, but the
 * tail reaches 32 MB, and the transfer message is a single JSON frame. 10 MB
 * covers 99.7% of them. Over the cap the move is refused with the size named,
 * never truncated — a truncated transcript resumes as a conversation with
 * holes in it.
 */
export const OMP_SESSION_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;

export interface TransferredOmpSession {
  fileName: string;
  contentBase64: string;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${bytes} B`;
}

/**
 * Read the transcript a cross-host move carries to the target host.
 *
 * Returns null when the agent has no transcript: it never ran, so there is
 * nothing to carry and nothing is wrong. Throws what cannot be carried — the
 * caller refuses the move before anything is deleted on the source host.
 */
export async function readOmpSessionForTransfer(
  sessionFile: string | null | undefined,
): Promise<TransferredOmpSession | null> {
  const trimmed = sessionFile?.trim();
  if (!trimmed) {
    return null;
  }
  const info = await stat(trimmed).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    return null;
  }
  if (info.size > OMP_SESSION_TRANSFER_MAX_BYTES) {
    throw new Error(
      `OMP transcript ${path.basename(trimmed)} is ${formatBytes(info.size)}, over the ` +
        `${formatBytes(OMP_SESSION_TRANSFER_MAX_BYTES)} cross-host move limit. The agent was not ` +
        `moved. Start a new agent in the target workspace, or move it after the transcript is archived.`,
    );
  }
  const content = await readFile(trimmed);
  return { fileName: path.basename(trimmed), contentBase64: content.toString("base64") };
}

/** Reject a name that could escape the sessions directory. The provider mints
 *  `<timestamp>_<sessionId>.jsonl`; anything else is not a transcript. */
function assertTranscriptFileName(fileName: string): void {
  if (fileName !== path.basename(fileName) || !fileName.endsWith(".jsonl")) {
    throw new Error(`Refusing transferred OMP transcript with unexpected file name "${fileName}"`);
  }
}

/**
 * Write a transcript carried by a cross-host move into THIS host's omp layout
 * and return the absolute path that replaces the source host's stale handle.
 *
 * The directory mirrors what omp picks for a create in `cwd`
 * (`encodeOmpSessionDirName`), so history discovery and `--continue` find the
 * moved session exactly where they find a natively created one.
 */
export async function ingestTransferredOmpSession(input: {
  fileName: string;
  contentBase64: string;
  cwd: string;
  /** Override for tests; defaults to the provider's own sessions root. */
  sessionsRoot?: string;
}): Promise<string> {
  assertTranscriptFileName(input.fileName);
  const sessionsRoot =
    input.sessionsRoot ?? (await resolveOmpSessionsDir({ cwd: path.resolve(input.cwd) }));
  const dir = path.join(sessionsRoot, encodeOmpSessionDirName(path.resolve(input.cwd)));
  await mkdir(dir, { recursive: true });

  // Temp + rename so a crash mid-write cannot leave a half transcript under a
  // name the provider would then happily resume.
  const sessionFile = path.join(dir, input.fileName);
  const staging = path.join(dir, `.paseo-transfer-${randomUUID()}.jsonl`);
  await writeFile(staging, Buffer.from(input.contentBase64, "base64"));
  await rename(staging, sessionFile);
  return sessionFile;
}
