/**
 * What to do when the itsaplan pane is opened, given a guest that outlives it.
 *
 * The desktop embed keeps one persistent guest and parks it when the pane
 * unmounts, so "the pane mounted" says nothing about whether anything needs to
 * load. Three cases have to stay distinct, and conflating the last two is the
 * bug this exists to prevent:
 *
 * - the guest has never been pointed anywhere: creation supplies the URL, so
 *   there is nothing to navigate and nothing is loaded yet;
 * - the pane wants a different origin, or the user hit Retry: navigate;
 * - the pane wants what the guest already shows: navigating would throw away a
 *   loaded page, and staying silent would leave the screen on its spinner,
 *   because an already-loaded guest fires no further load event.
 */
export interface ItsaplanEmbedVisit {
  /** Point the existing guest at the wanted origin. */
  navigate: boolean;
  /** Tell the screen the page is up now, because no load event is coming. */
  reportLoaded: boolean;
  /** What the guest shows once this visit is applied. */
  nextTarget: string;
}

export interface ItsaplanEmbedVisitInput {
  /** What the guest currently shows, or null if it was never pointed anywhere. */
  current: string | null;
  /** What this visit wants it to show. */
  wanted: string;
  /** Whether the guest has finished loading its current document. */
  domReady: boolean;
}

export function planItsaplanEmbedVisit(input: ItsaplanEmbedVisitInput): ItsaplanEmbedVisit {
  const { current, wanted, domReady } = input;
  if (current === wanted) {
    // Already showing it. A load event fired before this mount, or before the
    // previous one - either way none is coming, so the screen only leaves its
    // loading state if we say so.
    return { navigate: false, reportLoaded: domReady, nextTarget: wanted };
  }
  return {
    // A guest that has never been pointed anywhere received the URL when it was
    // created; navigating it again would reload the page it is already fetching.
    navigate: current !== null,
    // A navigation always produces a load event, so let that report instead.
    reportLoaded: false,
    nextTarget: wanted,
  };
}
