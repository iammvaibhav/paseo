import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../agent/tools/types.js";
import { NoteService } from "./service.js";
import { NoteStore } from "./store.js";
import {
  createLocalNoteToolsBackend,
  createPeerNoteToolsBackend,
  NotesHostUnavailableError,
  registerNoteTools,
} from "./tools.js";

let directory: string;
let store: NoteStore;
let service: NoteService;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-note-tools-"));
  const opened = await NoteStore.open({ directory, logger: createTestLogger() });
  if (!opened) {
    throw new Error("node:sqlite is required for the notes tools tests");
  }
  store = opened;
  service = new NoteService({ store, logger: createTestLogger() });
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

type Handler = (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;

function localHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerNoteTools({
    registerTool: (name, _config, handler) => {
      handlers[name] = handler;
    },
    resolveBackend: () => createLocalNoteToolsBackend({ service }),
  });
  return handlers;
}

async function call(handlers: Record<string, Handler>, name: string, input: unknown) {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`tool ${name} not registered`);
  }
  const result = await handler(input, {});
  return result.structuredContent as Record<string, never>;
}

describe("note_* MCP tools (local backend)", () => {
  it("writes a note, lists it, reads it back and updates it by slug", async () => {
    const handlers = localHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["note_list", "note_read", "note_write"]);

    const created = (await call(handlers, "note_write", {
      title: "Tool Note",
      body: "hello from the tool",
      tags: ["Ops"],
    })) as { ok: boolean; slug: string; created: boolean };
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);
    expect(created.slug).toBe("tool-note");

    const listed = (await call(handlers, "note_list", {})) as {
      ok: boolean;
      total: number;
      notes: Array<{ slug: string; preview: string }>;
    };
    expect(listed.ok).toBe(true);
    expect(listed.total).toBe(1);
    expect(listed.notes[0]?.slug).toBe("tool-note");

    const read = (await call(handlers, "note_read", { slug: "tool-note" })) as {
      ok: boolean;
      note: { slug: string; body: string; tags: string[] };
    };
    expect(read.ok).toBe(true);
    expect(read.note.body).toBe("hello from the tool");
    expect(read.note.tags).toEqual(["ops"]);

    const updated = (await call(handlers, "note_write", {
      slug: "tool-note",
      body: "revised body",
    })) as { ok: boolean; slug: string; created: boolean };
    expect(updated.ok).toBe(true);
    expect(updated.created).toBe(false);
    const reread = (await call(handlers, "note_read", { slug: "tool-note" })) as {
      note: { body: string };
    };
    expect(reread.note.body).toBe("revised body");
  });

  it("rejects an unknown slug on read", async () => {
    const handlers = localHandlers();
    await expect(call(handlers, "note_read", { slug: "nope" })).rejects.toThrow(
      'Unknown note slug "nope".',
    );
  });
});

describe("note tools backend resolution", () => {
  it("names the designated host when no Commander host is reachable", () => {
    const error = new NotesHostUnavailableError("commander");
    expect(error.message).toBe(
      "Notes live on the Commander host (commander), which is not reachable",
    );
    expect(new NotesHostUnavailableError(null).message).toBe(
      "Notes are off: no Commander host is designated",
    );
  });

  it("serves the peer backend through the notes-host client", async () => {
    const backend = createPeerNoteToolsBackend(
      () =>
        ({
          async notesRequest(type: string) {
            if (type === "notes.list.request") {
              return { error: null, notes: [], revision: 0 };
            }
            throw new Error(`unexpected ${type}`);
          },
        }) as never,
    );
    await expect(backend.listNotes()).resolves.toEqual([]);
  });
});
