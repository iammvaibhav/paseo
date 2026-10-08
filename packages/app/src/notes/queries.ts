import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, NotesRequestParams } from "@getpaseo/client/internal/daemon-client";
import type { NoteDetail, NoteSummary } from "@getpaseo/protocol/notes/types";
import { notesPushRoute } from "@/data/push-router";
import { useFetchQuery } from "@/data/query";
import { noteDetailQueryKey, noteListQueryKey, notesQueryRoot } from "./query-keys";
import { useNotesHost } from "./use-notes-host";

/** The notes host answered with `error` set, or with no entity. */
export class NotesRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesRequestError";
  }
}

export type UpsertNoteInput = NotesRequestParams<"notes.upsert.request">;

export interface NoteListFilters {
  query?: string;
  tag?: string;
  projectKey?: string;
  limit?: number;
}

export interface NoteListResult {
  notes: readonly NoteSummary[];
  revision: number;
  isLoading: boolean;
  error: Error | null;
}

export interface NoteDetailResult {
  note: NoteDetail | null;
  isLoading: boolean;
  error: Error | null;
}

export interface NoteMutations {
  upsertNote(input: UpsertNoteInput): Promise<NoteDetail>;
  deleteNote(input: { noteId: string }): Promise<void>;
}

// The notes.changed push keeps these fresh; the stale time only covers a
// missed push while the screen stays mounted.
const NOTES_STALE_TIME_MS = 60_000;
const NO_NOTES: readonly NoteSummary[] = [];

function unwrap<TPayload extends { error: string | null }>(payload: TPayload): TPayload {
  if (payload.error !== null) {
    throw new NotesRequestError(payload.error);
  }
  return payload;
}

function requireEntity<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new NotesRequestError(message);
  }
  return value;
}

interface NoteListPayload {
  notes: NoteSummary[];
  revision: number;
}

export function useNoteList(filters: NoteListFilters = {}): NoteListResult {
  const { t } = useTranslation();
  const { serverId, client } = useNotesHost();
  const query = useFetchQuery({
    queryKey: noteListQueryKey(serverId ?? "", filters),
    enabled: client !== null,
    meta: notesPushRoute({ enabled: client !== null, serverId: serverId ?? "" }),
    dataShape: "value",
    staleTimeMs: NOTES_STALE_TIME_MS,
    queryFn: async (): Promise<NoteListPayload> => {
      if (!client) {
        throw new NotesRequestError(t("notes.common.errors.hostUnavailable"));
      }
      const payload = unwrap(
        await client.notesRequest("notes.list.request", {
          ...(filters.query ? { query: filters.query } : {}),
          ...(filters.tag ? { tag: filters.tag } : {}),
          ...(filters.projectKey ? { projectKey: filters.projectKey } : {}),
          ...(filters.limit ? { limit: filters.limit } : {}),
        }),
      );
      return { notes: payload.notes, revision: payload.revision };
    },
  });
  return {
    notes: query.data?.notes ?? NO_NOTES,
    revision: query.data?.revision ?? 0,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** `note` is null while loading and when no note matches the ref. */
export function useNoteDetail(ref: { noteId?: string; slug?: string } | null): NoteDetailResult {
  const { t } = useTranslation();
  const { serverId, client } = useNotesHost();
  const hasRef = Boolean(ref?.noteId || ref?.slug);
  const query = useFetchQuery({
    queryKey: noteDetailQueryKey(serverId ?? "", ref),
    enabled: client !== null && hasRef,
    meta: notesPushRoute({ enabled: client !== null && hasRef, serverId: serverId ?? "" }),
    dataShape: "value",
    staleTimeMs: NOTES_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) {
        throw new NotesRequestError(t("notes.common.errors.hostUnavailable"));
      }
      const payload = unwrap(
        await client.notesRequest("notes.get.request", {
          ...(ref?.noteId ? { noteId: ref.noteId } : {}),
          ...(ref?.slug ? { slug: ref.slug } : {}),
        }),
      );
      return payload.note;
    },
  });
  return { note: query.data ?? null, isLoading: query.isLoading, error: query.error };
}

export function useNoteMutations(): NoteMutations {
  const { t } = useTranslation();
  const { serverId, client } = useNotesHost();
  const queryClient = useQueryClient();

  const requireClient = (): DaemonClient => {
    if (!client) {
      throw new NotesRequestError(t("notes.common.errors.hostUnavailable"));
    }
    return client;
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: notesQueryRoot(serverId ?? "") });
  };

  return {
    upsertNote: async (input: UpsertNoteInput) => {
      const emptyResponse = t("notes.common.errors.emptyResponse");
      const payload = unwrap(await requireClient().notesRequest("notes.upsert.request", input));
      const note = requireEntity(payload.note, emptyResponse);
      invalidate();
      return note;
    },
    deleteNote: async (input: { noteId: string }) => {
      unwrap(await requireClient().notesRequest("notes.delete.request", input));
      invalidate();
    },
  };
}
