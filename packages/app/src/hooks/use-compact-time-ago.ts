import { useEffect, useRef, useState } from "react";
import { subscribeToRelativeTimeTick, type TickResolution } from "@/utils/relative-time-ticker";
import {
  describeCompactTimeAgo,
  formatCompactTimeAgo,
  formatTimeAgo,
  type RelativeTimeResolution,
} from "@/utils/time";

type TimeAgoFormatter = (date: Date) => string;

/**
 * Shared engine behind live relative timestamps.
 *
 * Call this from the smallest component that renders the text. The state lives there, so a tick
 * re-renders one `<Text>` and nothing above it — the row, the list, and the sidebar are never
 * involved.
 *
 * Two things keep the cost near zero:
 *
 * - **Ticking is not re-rendering.** A tick recomputes the label and only sets state if the
 *   string actually changed. A row reading "3d" is woken hourly and re-renders roughly once a
 *   day, when it becomes "4d".
 * - **The tier follows the label.** As a timestamp ages the label changes more slowly, so the
 *   subscription moves to a slower tier; past a week it unsubscribes for good, because a date
 *   never changes again.
 *
 * The formatter is injected so the same clock serves both wordings: prose
 * (`useLiveTimeAgo` → "5m ago") and compact (`useCompactTimeAgo` → "5m"). The
 * resolution always comes from `describeCompactTimeAgo`, whose unit boundaries
 * match both — the prose formatter's sub-minute labels ("just now", "47s ago")
 * are served by the minute tier with at most one minute of staleness, the same
 * honesty tradeoff the compact "now" makes.
 */
function useRelativeTimeLabel(date: Date | null, format: TimeAgoFormatter): string {
  const formatRef = useRef(format);
  formatRef.current = format;
  const [label, setLabel] = useState(() => (date ? format(date) : ""));

  // Keyed on the instant, not the Date object: the store parses a fresh Date on every payload, so
  // depending on identity would tear down and rebuild the subscription for an unchanged time.
  const time = date === null ? null : date.getTime();

  useEffect(() => {
    if (time === null) {
      setLabel("");
      return undefined;
    }

    const source = new Date(time);
    let current = formatRef.current(source);
    let currentResolution: RelativeTimeResolution = describeCompactTimeAgo(source).resolution;
    setLabel(current);

    let unsubscribe: (() => void) | null = null;

    const handleTick = () => {
      const next = formatRef.current(source);
      if (next !== current) {
        setLabel(next);
      }
      const resolution = describeCompactTimeAgo(source).resolution;
      if (resolution === "static") {
        // Aged into the absolute-date range: the label can never change again,
        // so leave the ticking tiers for good.
        current = next;
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      if (resolution !== currentResolution) {
        // Aged into a slower tier — or out of them entirely.
        currentResolution = resolution;
        current = next;
        unsubscribe?.();
        unsubscribe = null;
        attach();
        return;
      }
      current = next;
    };

    const attach = () => {
      if (currentResolution === "static") return;
      unsubscribe = subscribeToRelativeTimeTick(currentResolution as TickResolution, handleTick);
    };

    attach();
    return () => {
      unsubscribe?.();
    };
  }, [time]);

  return label;
}

/** Compact relative timestamp ("now", "5m", "2h", "3d", "Jan 15"). */
export function useCompactTimeAgo(date: Date | null): string {
  return useRelativeTimeLabel(date, formatCompactTimeAgo);
}

/** Prose relative timestamp ("just now", "5m ago", "2h ago", "3d ago", "Jan 15"). */
export function useLiveTimeAgo(date: Date | null): string {
  return useRelativeTimeLabel(date, formatTimeAgo);
}
