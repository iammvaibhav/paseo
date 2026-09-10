import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  frameToTranscript,
  MAX_TRANSCRIPT_ENTRIES,
  type TranscriptEntry,
} from "./voice-transcript";

describe("frameToTranscript (frame → entry seam)", () => {
  it("omits toolLog frames from the transcript", () => {
    expect(
      frameToTranscript({ type: "toolLog", name: "commander_dispatch", args: { message: "x" } }),
    ).toBeNull();
    expect(frameToTranscript({ type: "toolLog", name: "pending_updates" })).toBeNull();
  });

  it("omits setupAck handshake frames", () => {
    expect(frameToTranscript({ type: "setupAck" })).toBeNull();
  });

  it("maps user speech to heard, output text to spoken, injected to announcement", () => {
    expect(frameToTranscript({ type: "inputText", text: "fleet status" })).toEqual({
      kind: "heard",
      text: "fleet status",
    });
    expect(frameToTranscript({ type: "text", text: "on it" })).toEqual({
      kind: "spoken",
      text: "on it",
    });
    expect(
      frameToTranscript({
        type: "injected",
        text: "proposal needs you",
        event: { id: "p1", kind: "proposal", severity: "blocker" },
      }),
    ).toEqual({ kind: "announcement", text: "proposal needs you" });
  });

  it("omits empty-text frames", () => {
    expect(frameToTranscript({ type: "text", text: "" })).toBeNull();
    expect(frameToTranscript({ type: "inputText", text: "" })).toBeNull();
    expect(frameToTranscript({ type: "injected", text: "" })).toBeNull();
  });

  it("does not break spoken coalescing across an interleaved toolLog frame", () => {
    // toolLog frames produce no row, so chunks on either side still coalesce.
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    state = appendTranscript(state.entries, state.nextId, "heard", "check fleet");
    for (const frame of [
      { type: "text" as const, text: "stand" },
      { type: "toolLog" as const, name: "pending_updates" },
      { type: "text" as const, text: " by" },
    ]) {
      const entry = frameToTranscript(frame);
      if (entry) {
        state = appendTranscript(state.entries, state.nextId, entry.kind, entry.text);
      }
    }
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1]).toEqual({ id: 1, kind: "spoken", text: "stand by" });
  });
});

describe("appendTranscript (spoken chunk coalescing)", () => {
  it("merges consecutive spoken chunks into one entry, whitespace preserved", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    for (const chunk of ["on ", "it ", "now"]) {
      state = appendTranscript(state.entries, state.nextId, "spoken", chunk);
    }
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toEqual({ id: 0, kind: "spoken", text: "on it now" });
  });

  it("keeps the first chunk's id and does not consume nextId while merging", () => {
    const spoken = appendTranscript([], 0, "spoken", "go");
    const merged = appendTranscript(spoken.entries, spoken.nextId, "spoken", " north");
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].id).toBe(0);
    expect(merged.nextId).toBe(1);
    // The id skipped by the merge is not reused; the next fresh entry advances.
    const fresh = appendTranscript(merged.entries, merged.nextId, "announcement", "ping");
    expect(fresh.entries[1].id).toBe(1);
  });
});

describe("appendTranscript (coalescing breakers)", () => {
  it("breaks on a heard entry", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    state = appendTranscript(state.entries, state.nextId, "spoken", "on");
    state = appendTranscript(state.entries, state.nextId, "heard", "what now");
    state = appendTranscript(state.entries, state.nextId, "spoken", " it");
    expect(state.entries).toHaveLength(3);
    expect(state.entries.map((e) => e.text)).toEqual(["on", "what now", " it"]);
  });

  it("breaks on an announcement entry", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    state = appendTranscript(state.entries, state.nextId, "spoken", "hold");
    state = appendTranscript(state.entries, state.nextId, "announcement", "proposal needs you");
    state = appendTranscript(state.entries, state.nextId, "spoken", " on");
    expect(state.entries).toHaveLength(3);
    expect(state.entries[1].kind).toBe("announcement");
    expect(state.entries[2]).toEqual({ id: 2, kind: "spoken", text: " on" });
  });

  it("breaks on a system entry", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    state = appendTranscript(state.entries, state.nextId, "spoken", "stand");
    state = appendTranscript(state.entries, state.nextId, "system", "mic unavailable");
    state = appendTranscript(state.entries, state.nextId, "spoken", " by");
    expect(state.entries).toHaveLength(3);
    expect(state.entries[2]).toEqual({ id: 2, kind: "spoken", text: " by" });
  });

  it("does not coalesce non-spoken kinds with each other", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    state = appendTranscript(state.entries, state.nextId, "heard", "a");
    state = appendTranscript(state.entries, state.nextId, "heard", "b");
    state = appendTranscript(state.entries, state.nextId, "system", "c");
    state = appendTranscript(state.entries, state.nextId, "system", "d");
    expect(state.entries).toHaveLength(4);
  });
});

describe("appendTranscript (max-entry cap)", () => {
  it("caps the transcript at MAX_TRANSCRIPT_ENTRIES, dropping the oldest", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 25; i += 1) {
      state = appendTranscript(state.entries, state.nextId, "system", `row ${i}`);
    }
    expect(state.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(state.entries[0]).toEqual({ id: 25, kind: "system", text: "row 25" });
    expect(state.entries[state.entries.length - 1]).toEqual({
      id: MAX_TRANSCRIPT_ENTRIES + 24,
      kind: "system",
      text: `row ${MAX_TRANSCRIPT_ENTRIES + 24}`,
    });
    expect(state.nextId).toBe(MAX_TRANSCRIPT_ENTRIES + 25);
  });

  it("still coalesces the tail spoken entry at the cap", () => {
    let state = { entries: [] as TranscriptEntry[], nextId: 0 };
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES; i += 1) {
      state = appendTranscript(state.entries, state.nextId, "system", `row ${i}`);
    }
    state = appendTranscript(state.entries, state.nextId, "spoken", "stand");
    const merged = appendTranscript(state.entries, state.nextId, "spoken", " by");
    expect(merged.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(merged.entries[merged.entries.length - 1].text).toBe("stand by");
  });
});
