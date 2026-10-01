// Kept free of React and runtime imports: the push router (loaded by the host
// runtime) needs the root key without an import cycle back into the runtime.

/** Every notes query of one host lives under this root. */
export function notesQueryRoot(serverId: string) {
  return ["notes", serverId] as const;
}

export function noteListQueryRoot(serverId: string) {
  return [...notesQueryRoot(serverId), "list"] as const;
}

export function noteListQueryKey(
  serverId: string,
  filters: { query?: string; tag?: string; projectKey?: string; limit?: number },
) {
  return [
    ...noteListQueryRoot(serverId),
    filters.query ?? "",
    filters.tag ?? "",
    filters.projectKey ?? "",
    filters.limit ?? "",
  ] as const;
}

export function noteDetailQueryKey(
  serverId: string,
  ref: { noteId?: string; slug?: string } | null,
) {
  return [...notesQueryRoot(serverId), "detail", ref?.noteId ?? null, ref?.slug ?? null] as const;
}
