/** `note` is a note id (`nte_…`) or slug, carried in `?note=`. */
export interface NotesRouteOptions {
  note?: string;
}

export function buildNotesRoute(options?: NotesRouteOptions) {
  const params = new URLSearchParams();
  if (options?.note) {
    params.set("note", options.note);
  }
  const query = params.toString();
  return query ? (`/notes?${query}` as const) : ("/notes" as const);
}
