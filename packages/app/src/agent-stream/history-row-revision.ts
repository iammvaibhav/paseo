import { useMemo } from "react";
import type { StreamHistoryRowRevision } from "./strategy";

interface HistoryRowDisplayVariants {
  regular?: object;
  compact?: object;
}

type RowIdSet = StreamHistoryRowRevision["displayStateById"];

const historyRowDisplayVariants = new WeakMap<object, HistoryRowDisplayVariants>();

// The WeakMap keys on row identity, so the cache only holds object rows. A viewport row type is
// generic and could in principle be a primitive; those simply get a fresh copy each pass, which
// is still correct because identity is the only thing this cache preserves.
function getHistoryRowDisplayVariant<T>(item: T, compact: boolean): T {
  if (typeof item !== "object" || item === null) {
    return item;
  }
  let variants = historyRowDisplayVariants.get(item);
  if (!variants) {
    variants = {};
    historyRowDisplayVariants.set(item, variants);
  }
  const key = compact ? "compact" : "regular";
  variants[key] ??= { ...item };
  return variants[key] as T;
}

// Rows are keyed by `id` when they carry one. Viewports may render row types without an id
// (resolveDefaultItemKey falls back to the index), and those rows simply never match a revision
// entry, which is the same outcome as an id that isn't in the set.
function isRevised(item: unknown, revised: RowIdSet | undefined): boolean {
  if (!revised || typeof item !== "object" || item === null) {
    return false;
  }
  return "id" in item && typeof item.id === "string" && revised.has(item.id);
}

// Item identity is the render signal for history rows: the row boundary in view.tsx bails out
// until its item changes. Every viewport runs its history through this hook so a history host
// whose tool-call group keeps updating from the live head, a group whose expanded state changed,
// or a breakpoint change reaches the row as a fresh identity. Unchanged rows keep their identity,
// which is what limits a live update to the rows it touched.
//
// Generic over the row type: the web and native viewports are parameterized over their own item
// type, so preserving T here keeps them type-safe instead of casting through StreamItem.
export function useRevisedHistoryRows<T>(
  items: T[],
  revision: StreamHistoryRowRevision | undefined,
): T[] {
  const globalDisplayState = revision?.globalDisplayState ?? false;
  const displayStateById = revision?.displayStateById;
  const contentById = revision?.contentById;
  const globallyRevisedRows = useMemo(
    () => items.map((item) => getHistoryRowDisplayVariant(item, globalDisplayState)),
    [items, globalDisplayState],
  );
  const displayStateRevisedRows = useMemo(
    () =>
      globallyRevisedRows.map((item) => (isRevised(item, displayStateById) ? { ...item } : item)),
    [globallyRevisedRows, displayStateById],
  );
  return useMemo(
    () =>
      displayStateRevisedRows.map((item) => (isRevised(item, contentById) ? { ...item } : item)),
    [displayStateRevisedRows, contentById],
  );
}
