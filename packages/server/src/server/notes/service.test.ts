import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { isServingNotes, NotesSession } from "./session.js";
import { NotesError, NoteService, deriveNoteTitle } from "./service.js";
import { NoteStore } from "./store.js";

let directory: string;
let store: NoteStore;
let service: NoteService;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-notes-"));
  const opened = await NoteStore.open({ directory, logger: createTestLogger() });
  if (!opened) {
    throw new Error("node:sqlite is required for the notes tests");
  }
  store = opened;
  service = new NoteService({ store, logger: createTestLogger() });
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe("upsertNote", () => {
  it("creates a note with a derived slug, title and preview", () => {
    const note = service.upsertNote({ title: "Deploy Checklist", body: "# Deploy\nShip it" });
    expect(note.slug).toBe("deploy-checklist");
    expect(note.title).toBe("Deploy Checklist");
    expect(note.body).toBe("# Deploy\nShip it");
    expect(note.id).toMatch(/^nte_[0-9a-f]{16}$/);
  });

  it("derives the title from the body when absent and suffixes colliding slugs", () => {
    const first = service.upsertNote({ body: "# Same Title\none" });
    const second = service.upsertNote({ body: "# Same Title\ntwo" });
    expect(first.slug).toBe("same-title");
    expect(second.slug).toBe("same-title-2");
    expect(first.title).toBe("Same Title");
  });

  it("keeps stored fields on update and falls back to a body title on empty title", () => {
    const created = service.upsertNote({ title: "Keep", body: "body", tags: ["A"] });
    const updated = service.upsertNote({ noteId: created.id, body: "# Fresh\nnew" });
    expect(updated.title).toBe("Keep");
    expect(updated.tags).toEqual(["a"]);
    const retitled = service.upsertNote({ noteId: created.id, title: "" });
    expect(retitled.title).toBe("Fresh");
  });

  it("rejects an unknown id", () => {
    expect(() => service.upsertNote({ noteId: "nte_missing", body: "x" })).toThrow(NotesError);
  });
});

describe("listNotes", () => {
  it("filters by query, tag and projectKey with a revision", () => {
    service.upsertNote({ title: "Alpha", body: "first", tags: ["ops"], sourceProjectKey: "p1" });
    service.upsertNote({ title: "Beta", body: "second", tags: ["dev"], sourceProjectKey: "p2" });
    const revision = store.getRevision();
    expect(service.listNotes({ query: "alp" }).notes.map((note) => note.title)).toEqual(["Alpha"]);
    expect(service.listNotes({ tag: "dev" }).notes.map((note) => note.title)).toEqual(["Beta"]);
    expect(service.listNotes({ projectKey: "p1" }).notes.map((note) => note.title)).toEqual([
      "Alpha",
    ]);
    expect(service.listNotes({}).revision).toBe(revision);
  });
});

describe("revision and onChange", () => {
  it("bumps the revision and names the note id once per mutation", () => {
    const changes: Array<{ revision: number; noteIds: string[] }> = [];
    service.onChange((change) => changes.push(change));
    const before = store.getRevision();
    const note = service.upsertNote({ title: "Push", body: "x" });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.revision).toBe(before + 1);
    expect(changes[0]?.noteIds).toEqual([note.id]);
    service.deleteNote(note.id);
    expect(changes).toHaveLength(2);
    expect(changes[1]?.revision).toBe(before + 2);
  });
});

describe("deleteNote", () => {
  it("removes the note and is a no-op for unknown ids", () => {
    const note = service.upsertNote({ title: "Gone", body: "x" });
    service.deleteNote(note.id);
    expect(service.getNote({ noteId: note.id })).toBeNull();
    expect(() => service.deleteNote("nte_missing")).not.toThrow();
  });
});

describe("note images", () => {
  it("writes the image file atomically and reads it back", async () => {
    const note = service.upsertNote({ title: "Pic", body: "x" });
    const bytes = Buffer.from("fake-png-bytes");
    await service.writeImageFile("nim_test123", bytes);
    const { imageId } = service.addImage(
      note.id,
      { fileName: "shot.png", mimeType: "image/png", dataBase64: bytes },
      "nim_test123",
    );
    const { bytes: readBack } = service.readImage(imageId);
    expect(Buffer.compare(await readBack, bytes)).toBe(0);
  });

  it("leaves no orphan file when the row commit fails", async () => {
    const bytes = Buffer.from("orphan-bytes");
    await service.writeImageFile("nim_orphan", bytes);
    expect(() =>
      service.addImage(
        "nte_missing",
        { fileName: "shot.png", mimeType: "image/png", dataBase64: bytes },
        "nim_orphan",
      ),
    ).toThrow(NotesError);
    await service.removeImageFiles(["nim_orphan"]);
    expect(() => service.readImage("nim_orphan")).toThrow(NotesError);
  });
});

describe("deriveNoteTitle", () => {
  it("prefers headings and skips fences", () => {
    expect(deriveNoteTitle("# Hello\nbody")).toBe("Hello");
    expect(deriveNoteTitle("```\ncode\n```\nProse")).toBe("Prose");
    expect(deriveNoteTitle("")).toBe("Untitled");
  });
});

describe("NotesSession", () => {
  function servingSession(onMessage: (message: never) => void) {
    return new NotesSession({
      emit: onMessage as (message: never) => void,
      host: { service, isNotesHost: () => true, notesHostName: () => "commander" },
      logger: createTestLogger(),
    });
  }

  it("serves list/get/upsert/delete over the wire and answers get for unknown ids with null", async () => {
    const sent: Array<{ type: string; payload: { requestId: string } & Record<string, unknown> }> =
      [];
    const session = servingSession((message) => {
      sent.push(message as never);
    });
    await session.dispatch({ type: "notes.upsert.request", requestId: "1", body: "hello" });
    const created = sent[0]?.payload["note"] as { id: string; slug: string };
    expect(sent[0]?.type).toBe("notes.upsert.response");
    expect(created.slug).toBe("hello");
    await session.dispatch({ type: "notes.list.request", requestId: "2" });
    expect(sent[1]?.type).toBe("notes.list.response");
    await session.dispatch({ type: "notes.get.request", requestId: "3", slug: created.slug });
    expect(sent[2]?.type).toBe("notes.get.response");
    await session.dispatch({ type: "notes.delete.request", requestId: "4", noteId: created.id });
    expect(sent[3]?.type).toBe("notes.delete.response");
    await session.dispatch({ type: "notes.get.request", requestId: "5", noteId: created.id });
    expect(sent[4]?.payload["note"]).toBeNull();
  });

  it("names the Commander host when this host does not serve notes", async () => {
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    const session = new NotesSession({
      emit: (message) => {
        sent.push(message as never);
      },
      host: { service: null, isNotesHost: () => false, notesHostName: () => "commander" },
      logger: createTestLogger(),
    });
    expect(
      isServingNotes({ service: null, isNotesHost: () => false, notesHostName: () => null }),
    ).toBe(false);
    await session.dispatch({ type: "notes.list.request", requestId: "1" });
    expect(sent[0]?.payload["error"]).toBe("Notes live on the Commander host (commander)");
  });
});
