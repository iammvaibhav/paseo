import { useEffect, useRef } from "react";
import {
  ensurePersistentBrowserWebview,
  hidePersistentBrowserWebview,
  isBrowserWebviewDomReady,
  navigatePersistentBrowserWebview,
  showPersistentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import type { ItsaplanEmbedProps } from "./itsaplan-webview.web";

// Electron embed. Metro resolves .electron.tsx ahead of .web.tsx for the desktop
// build, so this replaces the iframe there — and it has to, because a
// cross-origin IFRAME cannot hold an itsaplan session at all.
//
// itsaplan is served from a different origin than the Paseo app, so an iframe's
// cookies are third-party and Chromium drops them. Observed end to end: the
// sign-in POST returns 200 with a token, the very next get-session returns
// `null`, and the button sits on "Signing in…" forever. better-auth issues its
// cookie SameSite=Lax (itsaplan packages/auth defaultCookieAttributes), which is
// never sent in a third-party context, and relaxing that to SameSite=None would
// weaken CSRF posture for a multi-user tracker to work around a container
// choice.
//
// A <webview> is not a subframe: it hosts an independent top-level document in
// its own guest WebContents, so its cookies are first-party to itsaplan's own
// origin and are kept. That is the same reason code-server's cookie auth already
// works in Paseo's browser pane.
//
// PERSISTENT, not per-mount. The guest is created once and then parked offscreen
// when the pane unmounts, exactly as VS Code Web does — see
// resident-webviews.ts. Creating and destroying it per visit reloaded the whole
// app every time the user navigated back, which is the difference between an
// instant pane and a spinner. Parking keeps the WebContents (and its session)
// alive for the rest of the app's lifetime.
//
// Lazily created on first visit rather than at launch: a hot guest costs real
// Chromium memory, and a session that never opens the pane should not pay for
// it. Only the FIRST visit loads; every later one just reveals the parked node.
//
// resident-webviews owns partition and attach: prepareBrowserWebview reads the
// partition from the desktop bridge, which matters because the main process
// refuses any attach whose partition is not the Paseo browser profile
// (packages/desktop/src/features/browser-webviews/index.ts
// isPaseoBrowserWebviewAttach). Sharing that profile also means itsaplan keeps
// the same cookie jar as the VS Code Web embed and stays signed in across
// restarts.

/** One hot guest for itsaplan, independent of workspace. */
const ITSAPLAN_BROWSER_ID = "itsaplan-embed";

const CONTAINER_STYLE = {
  flex: 1,
  minHeight: 0,
  position: "relative",
} as const;

export function ItsaplanEmbed({ origin, attempt, onLoaded, onFailed, testID }: ItsaplanEmbedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read callbacks through a ref: they change identity on every render of the
  // parent, and re-running the effect would re-park and re-reveal the guest.
  const handlersRef = useRef({ onLoaded, onFailed });
  handlersRef.current = { onLoaded, onFailed };
  // Which (origin, attempt) the live guest was last pointed at, so a Retry or an
  // origin change navigates instead of silently showing the previous page.
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const webview = ensurePersistentBrowserWebview({ browserId: ITSAPLAN_BROWSER_ID, url: origin });
    if (!webview) {
      // No desktop bridge, or no document to attach to: the pane's unreachable
      // state is the honest outcome rather than an empty container.
      handlersRef.current.onFailed();
      return undefined;
    }

    const handleLoad = () => handlersRef.current.onLoaded();
    const handleFail = (event: Event) => {
      // Sub-resource failures surface here too; only a failed main document
      // means the embed itself is unreachable. -3 is ABORTED, which an ordinary
      // in-app navigation also produces.
      const detail = event as Event & { isMainFrame?: boolean; errorCode?: number };
      if (detail.isMainFrame === false || detail.errorCode === -3) {
        return;
      }
      handlersRef.current.onFailed();
    };
    const handleGone = () => handlersRef.current.onFailed();

    webview.addEventListener("did-finish-load", handleLoad);
    webview.addEventListener("did-fail-load", handleFail);
    webview.addEventListener("crashed", handleGone);
    webview.addEventListener("render-process-gone", handleGone);

    const wanted = `${attempt}:${origin}`;
    if (loadedForRef.current !== wanted) {
      // First mount already got `url`; only navigate when the target actually
      // changed, so a plain revisit does not throw away a loaded page.
      if (loadedForRef.current !== null) {
        navigatePersistentBrowserWebview(ITSAPLAN_BROWSER_ID, origin);
      }
      loadedForRef.current = wanted;
    } else if (isBrowserWebviewDomReady(webview)) {
      // Revisiting an already-loaded guest fires no further load event, so clear
      // the screen's loading state immediately instead of waiting for a timeout.
      handlersRef.current.onLoaded();
    }

    showPersistentBrowserWebview(ITSAPLAN_BROWSER_ID, container);

    return () => {
      webview.removeEventListener("did-finish-load", handleLoad);
      webview.removeEventListener("did-fail-load", handleFail);
      webview.removeEventListener("crashed", handleGone);
      webview.removeEventListener("render-process-gone", handleGone);
      // Park, never destroy: this is what keeps the next visit instant.
      hidePersistentBrowserWebview(ITSAPLAN_BROWSER_ID);
    };
  }, [origin, attempt]);

  return <div ref={containerRef} style={CONTAINER_STYLE} data-testid={testID} />;
}
