import path from "node:path";
import type { Logger } from "pino";
import { NoteService } from "./service.js";
import { NoteStore } from "./store.js";

export interface NotesRuntime {
  store: NoteStore;
  service: NoteService;
}

export interface OpenNotesInput {
  paseoHome: string;
  logger: Logger;
}

/** Opens `$PASEO_HOME/notes`. Null when node:sqlite is missing: the feature is off. */
export async function openNotes(input: OpenNotesInput): Promise<NotesRuntime | null> {
  const store = await NoteStore.open({
    directory: path.join(input.paseoHome, "notes"),
    logger: input.logger,
  });
  return store ? { store, service: new NoteService({ store, logger: input.logger }) } : null;
}

export {
  MAX_IMAGE_BYTES,
  NoteService,
  NotesError,
  deriveNoteTitle,
  type NotesChange,
} from "./service.js";
export { NoteStore, newNoteId, notePreview } from "./store.js";
export { NotesSession, isServingNotes, type NotesHost } from "./session.js";
