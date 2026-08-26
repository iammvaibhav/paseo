export type ItsaplanNavigationKind = "initial" | "sameOrigin" | "external" | "blocked";

const INITIAL_URLS: Record<string, true> = {
  "about:blank": true,
  "": true,
};

/**
 * Navigation policy for the itsaplan embed: it is an app surface, so loads that
 * stay inside the tool's own origin pass (the SPA may hard-navigate between
 * routes, e.g. after sign-in); plain web links are handed to the OS browser;
 * custom schemes and anything unparseable are refused. Unlike the file preview
 * (a viewer that refuses every post-initial navigation), an app the user is
 * signed into needs its own origin's navigations to work.
 */
export function itsaplanNavigationKind(url: string, origin: string): ItsaplanNavigationKind {
  if (INITIAL_URLS[url] === true) {
    return "initial";
  }
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(origin);
  } catch {
    return "blocked";
  }
  if (target.origin === base.origin && base.protocol !== "about:") {
    return "sameOrigin";
  }
  if (target.protocol === "https:" || target.protocol === "http:") {
    return "external";
  }
  return "blocked";
}
