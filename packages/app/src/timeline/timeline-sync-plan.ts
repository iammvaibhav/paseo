import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export interface TimelineSyncCursor {
  epoch: string;
  seq: number;
}

export interface ProjectedTimelineTailFetchPlan {
  direction: "tail";
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineAfterFetchPlan {
  direction: "after";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineBeforeFetchPlan {
  direction: "before";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export type ProjectedTimelineFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan
  | ProjectedTimelineBeforeFetchPlan;

export type ProjectedTimelineForwardFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan;

export function planTimelineCatchUpAfter(cursor: TimelineSyncCursor) {
  return {
    direction: "after",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineTailFetch() {
  return {
    direction: "tail",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineResumeFetch(
  range: { epoch: string; endSeq: number } | null | undefined,
): ProjectedTimelineForwardFetchPlan {
  return range
    ? planTimelineCatchUpAfter({ epoch: range.epoch, seq: range.endSeq })
    : planTimelineTailFetch();
}

/**
 * Loaded coverage of one agent timeline: the contiguous range that reaches the
 * newest row, plus disjoint older windows a prompt jump merged in.
 */
export interface TimelineLoadedCoverage {
  epoch: string;
  startSeq: number;
  endSeq: number;
  retainedRanges?: ReadonlyArray<{ startSeq: number; endSeq: number }>;
}

/** Unloaded rows between two loaded ranges, inclusive. */
export interface TimelineGap {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

export function listTimelineGaps(coverage: TimelineLoadedCoverage | null): TimelineGap[] {
  if (!coverage?.retainedRanges?.length) return [];
  const ranges = [
    ...coverage.retainedRanges,
    { startSeq: coverage.startSeq, endSeq: coverage.endSeq },
  ].sort((left, right) => left.startSeq - right.startSeq);
  const gaps: TimelineGap[] = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const startSeq = ranges[index - 1]!.endSeq + 1;
    const endSeq = ranges[index]!.startSeq - 1;
    if (endSeq >= startSeq) gaps.push({ epoch: coverage.epoch, startSeq, endSeq });
  }
  return gaps;
}

/** First loaded seq across every range: where scrolling up continues from. */
export function earliestLoadedSeq(coverage: TimelineLoadedCoverage): number {
  return Math.min(
    coverage.startSeq,
    ...(coverage.retainedRanges ?? []).map((range) => range.startSeq),
  );
}

/**
 * The page above the top of the list. While a prompt-jump window is the top,
 * the page merges into that window; otherwise it prepends to the loaded range.
 */
export function planTimelineOlderFetch(coverage: TimelineLoadedCoverage) {
  const seq = earliestLoadedSeq(coverage);
  return {
    direction: "before",
    cursor: { epoch: coverage.epoch, seq },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    ...(seq < coverage.startSeq ? { mergeWindow: true as const } : {}),
  } as const;
}

/** The first page of a gap, read top-down so it continues the row above the gap. */
export function planTimelineGapFill(gap: TimelineGap) {
  return {
    direction: "before",
    cursor: {
      epoch: gap.epoch,
      seq: Math.min(gap.startSeq + TIMELINE_FETCH_PAGE_SIZE, gap.endSeq + 1),
    },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    mergeWindow: true,
  } as const;
}

export function planTimelinePromptJump(target: TimelineSyncCursor) {
  const newerRows = Math.floor(TIMELINE_FETCH_PAGE_SIZE / 2);
  return {
    direction: "before",
    cursor: { epoch: target.epoch, seq: target.seq + newerRows + 1 },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    mergeWindow: true,
  } as const;
}

export function isTimelineCatchUpComplete(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error) {
    return false;
  }

  return input.direction !== "after" || !input.hasNewer;
}

export function isTimelineResumeSnapshotAuthoritative(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error || input.direction === "before") return false;
  return input.direction === "tail" || !input.hasNewer;
}
