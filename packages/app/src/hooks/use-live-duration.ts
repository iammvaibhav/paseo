import { useEffect, useState } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import { formatDurationMinutes } from "@/utils/time";

/**
 * How long something has been running, live ("<1m", "3m", "1h 5m").
 *
 * The counterpart of `useCompactTimeAgo` for a forward-counting duration, and
 * it shares the same clock: one minute-tier timer serves every subscriber, and
 * a tick only sets state when the label text actually changes, so a row
 * reading "3m" re-renders once a minute and nothing above it re-renders at
 * all. Call it from the smallest component that renders the text.
 *
 * `startedAt` of null means the duration is unknown; the label is empty so the
 * caller renders nothing rather than a fabricated "<1m".
 */
export function useLiveDuration(startedAt: Date | null): string {
  const startedMs = startedAt === null ? null : startedAt.getTime();
  const [label, setLabel] = useState(() =>
    startedMs === null ? "" : formatDurationMinutes(Date.now() - startedMs),
  );

  useEffect(() => {
    if (startedMs === null) {
      setLabel("");
      return;
    }
    setLabel(formatDurationMinutes(Date.now() - startedMs));
    return subscribeToRelativeTimeTick("minute", () => {
      setLabel((current) => {
        const next = formatDurationMinutes(Date.now() - startedMs);
        return next === current ? current : next;
      });
    });
  }, [startedMs]);

  return label;
}
