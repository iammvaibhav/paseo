import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { NotesError, type NoteService } from "./service.js";

type NotesRequest = Extract<SessionInboundMessage, { type: `notes.${string}.request` }>;

export interface NotesHost {
  service: NoteService | null;
  isNotesHost(): boolean;
  notesHostName(): string | null;
}

/** The one rule for `server_info.features.notes` and for serving notes.* requests. */
export function isServingNotes(host: NotesHost | null): boolean {
  return host !== null && host.service !== null && host.isNotesHost();
}

interface ServingHost {
  service: NoteService;
}

type Attempt<T> = { value: T; error: null } | { value: null; error: string };

function isNotesRequest(message: SessionInboundMessage): message is NotesRequest {
  return message.type.startsWith("notes.") && message.type.endsWith(".request");
}

function unhandled(request: never): never {
  throw new Error(`Unhandled notes request ${JSON.stringify(request)}`);
}

export interface NotesSessionOptions {
  emit(message: SessionOutboundMessage): void;
  host: NotesHost | null;
  logger: pino.Logger;
}

/**
 * Client request surface of native notes. Only the notes host serves it;
 * every other host answers each request with an error naming the notes host.
 */
export class NotesSession {
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly host: NotesHost | null;
  private readonly logger: pino.Logger;

  constructor(options: NotesSessionOptions) {
    this.emit = options.emit;
    this.host = options.host;
    this.logger = options.logger;
  }

  /** Claims every notes.*.request; undefined for any other message. */
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!isNotesRequest(message)) {
      return undefined;
    }
    return this.handleRequest(message);
  }

  private serving(): ServingHost | string {
    if (this.host === null || !this.host.isNotesHost()) {
      const name = this.host?.notesHostName() ?? "none designated";
      return `Notes live on the Commander host (${name})`;
    }
    if (this.host.service === null) {
      return "Notes are unavailable on this host: node:sqlite is missing";
    }
    return { service: this.host.service };
  }

  private async attempt<T>(
    request: NotesRequest,
    work: (serving: ServingHost) => T | Promise<T>,
  ): Promise<Attempt<T>> {
    const serving = this.serving();
    if (typeof serving === "string") {
      return { value: null, error: serving };
    }
    try {
      return { value: await work(serving), error: null };
    } catch (error) {
      // Every request owes its caller a response; a NotesError is an expected refusal.
      if (!(error instanceof NotesError)) {
        this.logger.error({ err: error, requestType: request.type }, "Notes request failed");
      }
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleRequest(request: NotesRequest): Promise<void> {
    const requestId = request.requestId;
    switch (request.type) {
      case "notes.list.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.listNotes({
            query: request.query,
            tag: request.tag,
            projectKey: request.projectKey,
            limit: request.limit,
          }),
        );
        this.emit({
          type: "notes.list.response",
          payload: {
            requestId,
            error: result.error,
            notes: result.value?.notes ?? [],
            revision: result.value?.revision ?? 0,
          },
        });
        return;
      }
      case "notes.get.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.getNote({ noteId: request.noteId, slug: request.slug }),
        );
        this.emit({
          type: "notes.get.response",
          payload: { requestId, error: result.error, note: result.value ?? null },
        });
        return;
      }
      case "notes.upsert.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.upsertNote({
            noteId: request.noteId,
            title: request.title,
            body: request.body,
            tags: request.tags,
            sourceAgentId: request.sourceAgentId,
            sourceHost: request.sourceHost,
            sourceCwd: request.sourceCwd,
            sourceProjectKey: request.sourceProjectKey,
          }),
        );
        this.emit({
          type: "notes.upsert.response",
          payload: { requestId, error: result.error, note: result.value ?? null },
        });
        return;
      }
      case "notes.delete.request": {
        const result = await this.attempt(request, async ({ service }) => {
          const removed = service.deleteNote(request.noteId);
          await service.removeImageFiles(removed.images.map((image) => image.storagePath));
        });
        this.emit({
          type: "notes.delete.response",
          payload: { requestId, error: result.error },
        });
        return;
      }
      case "notes.image.add.request": {
        const result = await this.attempt(request, async ({ service }) => {
          const bytes = Buffer.from(request.dataBase64, "base64");
          const detail = service.addImage(request.noteId, {
            fileName: request.fileName,
            mimeType: request.mimeType,
            dataBase64: bytes,
          });
          await service.writeImageFile(detail.images[detail.images.length - 1]?.id ?? "", bytes);
          return service.getNote({ noteId: request.noteId });
        });
        this.emit({
          type: "notes.image.add.response",
          payload: { requestId, error: result.error, note: result.value ?? null },
        });
        return;
      }
      case "notes.image.read.request": {
        const result = await this.attempt(request, async ({ service }) => {
          const { image, bytes } = service.readImage(request.imageId);
          const data = await bytes;
          return {
            fileName: image.fileName,
            mimeType: image.mimeType,
            dataBase64: data.toString("base64"),
          };
        });
        this.emit({
          type: "notes.image.read.response",
          payload: {
            requestId,
            error: result.error,
            fileName: result.value?.fileName ?? null,
            mimeType: result.value?.mimeType ?? null,
            dataBase64: result.value?.dataBase64 ?? null,
          },
        });
        return;
      }
      case "notes.image.delete.request": {
        const result = await this.attempt(request, async ({ service }) => {
          const deleted = service.deleteImage(request.imageId);
          if (deleted.storagePath) {
            await service.removeImageFiles([deleted.storagePath]);
          }
          return deleted.note;
        });
        this.emit({
          type: "notes.image.delete.response",
          payload: { requestId, error: result.error, note: result.value ?? null },
        });
        return;
      }
      default:
        return unhandled(request);
    }
  }
}
