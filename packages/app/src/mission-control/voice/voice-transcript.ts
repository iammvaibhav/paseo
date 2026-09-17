import type { CommanderVoiceServerFrame } from "./commander-voice-client";

/**
 * Kinds of human-facing transcript rows. Tool invocations are deliberately
 * absent: they are log noise, not dialogue, and stay in the voice-node logs.
 */
export type TranscriptKind = "heard" | "spoken" | "announcement" | "system";

export interface TranscriptEntry {
  id: number;
  kind: TranscriptKind;
  text: string;
}

export const MAX_TRANSCRIPT_ENTRIES = 200;

/**
 * Append one entry to the transcript.
 *
 * Consecutive "spoken" chunks coalesce into the tail entry: incremental
 * transcription arrives as one chunk per frame (often a single word), and
 * merging renders it as one growing line. The tail text is concatenated
 * verbatim — whitespace preserved, nothing trimmed — the entry keeps its id,
 * and `nextId` is not consumed. Any other kind breaks coalescing.
 *
 * A fresh entry gets `id: nextId`; `nextId` advances by one. The list is
 * capped at MAX_TRANSCRIPT_ENTRIES by dropping the oldest rows.
 */
export function appendTranscript(
  entries: TranscriptEntry[],
  nextId: number,
  kind: TranscriptKind,
  text: string,
): { entries: TranscriptEntry[]; nextId: number } {
  const tail = entries[entries.length - 1];
  if (kind === "spoken" && tail?.kind === "spoken") {
    return { entries: [...entries.slice(0, -1), { ...tail, text: tail.text + text }], nextId };
  }
  const merged = [...entries, { id: nextId, kind, text }];
  if (merged.length > MAX_TRANSCRIPT_ENTRIES) {
    merged.splice(0, merged.length - MAX_TRANSCRIPT_ENTRIES);
  }
  return { entries: merged, nextId: nextId + 1 };
}

/**
 * Frame → transcript seam. Maps a voice-node frame to the row it should
 * render, or null for frames that produce no UI row: toolLog frames are
 * tool-invocation logs (not conversation), setupAck is protocol handshake,
 * and empty-text frames carry nothing to say.
 */
export function frameToTranscript(
  frame: CommanderVoiceServerFrame,
): { kind: TranscriptKind; text: string } | null {
  switch (frame.type) {
    case "inputText":
      return frame.text ? { kind: "heard", text: frame.text } : null;
    case "text":
      return frame.text ? { kind: "spoken", text: frame.text } : null;
    case "injected":
      return frame.text ? { kind: "announcement", text: frame.text } : null;
    case "toolLog":
    case "setupAck":
    case "interrupt":
    case "turnComplete":
      return null;
  }
}
