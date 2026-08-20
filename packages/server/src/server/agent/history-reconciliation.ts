import { isDeepStrictEqual } from "node:util";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export interface ProviderHistoryTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

/** Reconciles canonical metadata onto provider-ordered history without inventing membership. */
export function reconcileProviderHistory(
  canonicalRows: readonly AgentTimelineRow[],
  providerEntries: readonly ProviderHistoryTimelineEntry[],
  options?: { mode?: "incomplete" | "force" },
): AgentTimelineRow[] {
  if (providerEntries.length === 0) {
    return options?.mode === "force"
      ? []
      : canonicalRows.map((row, index) => ({ ...row, seq: index + 1 }));
  }
  const remaining = canonicalRows.map((row, canonicalIndex) => ({
    row,
    canonicalIndex,
    used: false,
  }));

  const identityMap = new Map<
    string,
    Array<{ row: AgentTimelineRow; canonicalIndex: number; used: boolean }>
  >();
  const structuralBuckets = new Map<
    string,
    Array<{ row: AgentTimelineRow; canonicalIndex: number; used: boolean }>
  >();

  for (let i = 0; i < remaining.length; i++) {
    const candidate = remaining[i];
    const item = candidate.row.item;
    if (item.type === "user_message") {
      const identities = [
        item.clientMessageId,
        item.messageId,
        candidate.row.providerMessageId,
      ].filter(Boolean) as string[];
      for (const id of identities) {
        let list = identityMap.get(id);
        if (!list) {
          list = [];
          identityMap.set(id, list);
        }
        list.push(candidate);
      }
    }
    const key = structuralKey(item);
    let bucket = structuralBuckets.get(key);
    if (!bucket) {
      bucket = [];
      structuralBuckets.set(key, bucket);
    }
    bucket.push(candidate);
  }

  const structuralCounts = countStructuralOccurrences(canonicalRows, providerEntries);
  let nextSequentialCanonicalIndex = 0;

  const providerRows = providerEntries.map((entry) => {
    const match = takeMatchFast(
      entry.item,
      identityMap,
      structuralBuckets,
      structuralCounts,
      () => {
        while (
          nextSequentialCanonicalIndex < remaining.length &&
          remaining[nextSequentialCanonicalIndex].used
        ) {
          nextSequentialCanonicalIndex++;
        }
        return nextSequentialCanonicalIndex < remaining.length
          ? remaining[nextSequentialCanonicalIndex]
          : null;
      },
      () => {
        nextSequentialCanonicalIndex++;
      },
    );
    return { entry, match };
  });
  const rows: AgentTimelineRow[] = [];
  const emittedCanonicalIndexes = new Set<number>();
  let remainingScanIndex = 0;

  for (const { entry, match } of providerRows) {
    if (match) {
      while (
        remainingScanIndex < remaining.length &&
        remaining[remainingScanIndex].canonicalIndex < match.canonicalIndex
      ) {
        const candidate = remaining[remainingScanIndex];
        if (!emittedCanonicalIndexes.has(candidate.canonicalIndex)) {
          rows.push({ ...candidate.row });
          emittedCanonicalIndexes.add(candidate.canonicalIndex);
        }
        remainingScanIndex++;
      }
      rows.push(
        match.transferProviderIdentity ? mergeMatchedRow(match.row, entry) : { ...match.row },
      );
      emittedCanonicalIndexes.add(match.canonicalIndex);
      continue;
    }
    rows.push({
      seq: 0,
      timestamp: entry.timestamp ?? new Date(0).toISOString(),
      item: entry.item,
    });
  }

  if (options?.mode !== "force") {
    while (remainingScanIndex < remaining.length) {
      const candidate = remaining[remainingScanIndex];
      if (!emittedCanonicalIndexes.has(candidate.canonicalIndex)) {
        rows.push({ ...candidate.row });
      }
      remainingScanIndex++;
    }
  }
  rows.forEach((row, index) => {
    row.seq = index + 1;
  });
  return rows;
}

function takeMatchFast(
  provider: AgentTimelineItem,
  identityMap: Map<string, Array<{ row: AgentTimelineRow; canonicalIndex: number; used: boolean }>>,
  structuralBuckets: Map<
    string,
    Array<{ row: AgentTimelineRow; canonicalIndex: number; used: boolean }>
  >,
  structuralCounts: Map<string, { canonical: number; provider: number }>,
  getNextSequentialCandidate: () => {
    row: AgentTimelineRow;
    canonicalIndex: number;
    used: boolean;
  } | null,
  advanceSequentialCandidate: () => void,
): { row: AgentTimelineRow; canonicalIndex: number; transferProviderIdentity: boolean } | null {
  if (provider.type === "user_message") {
    const identities = [provider.clientMessageId, provider.messageId].filter(Boolean) as string[];
    for (const id of identities) {
      const list = identityMap.get(id);
      if (list) {
        const strong = list.find(
          (candidate) => !candidate.used && hasSharedIdentity(candidate.row, provider),
        );
        if (strong) {
          strong.used = true;
          return {
            row: strong.row,
            canonicalIndex: strong.canonicalIndex,
            transferProviderIdentity: true,
          };
        }
      }
    }
  }

  const nextCandidate = getNextSequentialCandidate();
  if (nextCandidate && structurallyMatches(nextCandidate.row.item, provider)) {
    nextCandidate.used = true;
    advanceSequentialCandidate();
    const key = structuralKey(provider);
    const counts = structuralCounts.get(key);
    return {
      row: nextCandidate.row,
      canonicalIndex: nextCandidate.canonicalIndex,
      transferProviderIdentity: counts?.canonical === 1 && counts?.provider === 1,
    };
  }

  const key = structuralKey(provider);
  const bucket = structuralBuckets.get(key);
  if (bucket) {
    const match = bucket.find(
      (candidate) => !candidate.used && structurallyMatches(candidate.row.item, provider),
    );
    if (match) {
      match.used = true;
      const counts = structuralCounts.get(key);
      return {
        row: match.row,
        canonicalIndex: match.canonicalIndex,
        transferProviderIdentity: counts?.canonical === 1 && counts?.provider === 1,
      };
    }
  }

  return null;
}
function mergeMatchedRow(
  canonical: AgentTimelineRow,
  provider: ProviderHistoryTimelineEntry,
): AgentTimelineRow {
  return {
    ...canonical,
    item: mergeCanonicalIdentity(canonical.item, provider.item),
  };
}

function countStructuralOccurrences(
  canonicalRows: readonly AgentTimelineRow[],
  providerEntries: readonly ProviderHistoryTimelineEntry[],
): Map<string, { canonical: number; provider: number }> {
  const counts = new Map<string, { canonical: number; provider: number }>();
  for (const row of canonicalRows) {
    const key = structuralKey(row.item);
    const count = counts.get(key) ?? { canonical: 0, provider: 0 };
    count.canonical += 1;
    counts.set(key, count);
  }
  for (const entry of providerEntries) {
    const key = structuralKey(entry.item);
    const count = counts.get(key) ?? { canonical: 0, provider: 0 };
    count.provider += 1;
    counts.set(key, count);
  }
  return counts;
}

function structuralKey(item: AgentTimelineItem): string {
  return item.type === "user_message"
    ? `user:${item.text}`
    : `${item.type}:${JSON.stringify(item)}`;
}

function hasSharedIdentity(row: AgentTimelineRow, provider: AgentTimelineItem): boolean {
  if (row.item.type !== "user_message" || provider.type !== "user_message") return false;
  const identities = [row.item.clientMessageId, row.item.messageId, row.providerMessageId].filter(
    Boolean,
  );
  return identities.some(
    (identity) => identity === provider.clientMessageId || identity === provider.messageId,
  );
}

function structurallyMatches(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  if (left.type === "user_message" && right.type === "user_message")
    return left.text === right.text;
  return isDeepStrictEqual(left, right);
}

function mergeCanonicalIdentity(
  canonical: AgentTimelineItem,
  provider: AgentTimelineItem,
): AgentTimelineItem {
  if (canonical.type !== "user_message" || provider.type !== "user_message") return provider;
  return {
    ...provider,
    ...(canonical.clientMessageId ? { clientMessageId: canonical.clientMessageId } : {}),
    ...(canonical.messageId ? { messageId: canonical.messageId } : {}),
  };
}
