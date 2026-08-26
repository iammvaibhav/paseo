import { useEffect, useRef } from "react";
import { getDesktopHost } from "@/desktop/host";
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
// The element is created imperatively rather than as JSX, matching
// resident-webviews.ts: <webview> is an Electron custom element that React DOM
// does not model, and its attributes must be set before attach.
//
// Partition is NOT optional: the main window's will-attach-webview handler
// rejects any attach whose partition is not the Paseo browser profile
// (packages/desktop/src/features/browser-webviews/index.ts
// isPaseoBrowserWebviewAttach). Sharing that profile also means itsaplan keeps
// the same cookie jar as the VS Code Web embed and survives app restarts, which
// is what makes staying signed in work.

const CONTAINER_STYLE = {
  flex: 1,
  minHeight: 0,
  position: "relative",
} as const;

export function ItsaplanEmbed({ origin, attempt, onLoaded, onFailed, testID }: ItsaplanEmbedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read callbacks through a ref so re-renders never tear down a live webview:
  // recreating it would drop the guest's session state and restart the load.
  const handlersRef = useRef({ onLoaded, onFailed });
  handlersRef.current = { onLoaded, onFailed };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    // The partition is supplied by the desktop bridge rather than hardcoded, so
    // it stays in lockstep with whatever the main process actually allows. No
    // bridge means no Electron shell, and an unpartitioned webview would be
    // refused on attach, so leave the pane to report failure instead.
    const partition = getDesktopHost()?.browser?.profilePartition;
    if (!partition) {
      handlersRef.current.onFailed();
      return undefined;
    }
    const webview = document.createElement("webview");
    webview.setAttribute("src", origin);
    webview.setAttribute("partition", partition);
    webview.setAttribute("allowpopups", "true");
    Object.assign(webview.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      border: "none",
      backgroundColor: "white",
    });
    if (testID) {
      webview.setAttribute("data-testid", testID);
    }

    // Unlike the iframe, a webview reports real outcomes, so the web variant's
    // 20s "no load event arrived" watchdog is not needed here.
    const handleLoad = () => handlersRef.current.onLoaded();
    const handleFail = (event: Event) => {
      // Sub-resource failures surface here too; only a failed main document
      // means the embed itself is unreachable. -3 is ABORTED, which a normal
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
    container.append(webview);

    return () => {
      webview.removeEventListener("did-finish-load", handleLoad);
      webview.removeEventListener("did-fail-load", handleFail);
      webview.removeEventListener("crashed", handleGone);
      webview.removeEventListener("render-process-gone", handleGone);
      webview.remove();
    };
    // `attempt` is the screen's Retry signal: bumping it rebuilds the guest.
  }, [origin, attempt, testID]);

  return <div ref={containerRef} style={CONTAINER_STYLE} />;
}
