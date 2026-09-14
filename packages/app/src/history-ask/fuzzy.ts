export interface HistoryAskFuzzyTarget {
  title?: string | null;
  provider?: string | null;
  cwd?: string | null;
  labels?: Record<string, string> | null;
  id?: string | null;
  serverLabel?: string | null;
}

/**
 * Multi-token case-insensitive metadata filter.
 * Every whitespace-separated token must match at least one field
 * (title, provider, cwd, id, serverLabel, or any label key/value).
 */
export function matchesHistoryAskFuzzy(target: HistoryAskFuzzyTarget, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return true;
  }

  const fields = collectFields(target);
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

export function filterByHistoryAskFuzzy<T extends HistoryAskFuzzyTarget>(
  items: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) {
    return [...items];
  }
  return items.filter((item) => matchesHistoryAskFuzzy(item, query));
}

function collectFields(target: HistoryAskFuzzyTarget): string[] {
  const fields: string[] = [];
  push(fields, target.title);
  push(fields, target.provider);
  push(fields, target.cwd);
  push(fields, target.id);
  push(fields, target.serverLabel);

  if (target.labels) {
    for (const [key, value] of Object.entries(target.labels)) {
      push(fields, key);
      push(fields, value);
    }
  }

  return fields;
}

function push(fields: string[], value: string | null | undefined): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed) {
    fields.push(trimmed);
  }
}
