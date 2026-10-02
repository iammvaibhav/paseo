import type { StreamItem } from "@/types/stream";

const UNSUPPORTED_HISTORY_FALLBACK = /^\[[^\]\r\n]+\] Unsupported history record$/;

function isUnsupportedHistoryFallback(item: StreamItem): boolean {
  return item.kind === "assistant_message" && UNSUPPORTED_HISTORY_FALLBACK.test(item.text.trim());
}

/**
 * OMP keeps unknown history records visible so agent chat never loses data.
 * Mission Control's inspector treats those mapper placeholders as machinery:
 * normal mode hides them; verbose mode exposes the original stream unchanged.
 */
export function filterMissionControlInspectorStream(
  items: StreamItem[],
  verbose: boolean,
): StreamItem[] {
  if (verbose) {
    return items;
  }
  const visible = items.filter((item) => !isUnsupportedHistoryFallback(item));
  return visible.length === items.length ? items : visible;
}
