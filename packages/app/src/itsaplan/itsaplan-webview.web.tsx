import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ItsaplanEmbedProps {
  origin: string;
  project?: string;
  /** Bump to remount the embed (retry after a failed load). */
  attempt: number;
  onLoaded: () => void;
  onFailed: () => void;
  testID?: string;
}

// Web fallback for the native WebView (the app ships to both platforms — see
// html-preview.web.tsx). A cross-origin iframe keeps its own cookies and
// storage, so itsaplan's session stays isolated from the Paseo origin without a
// sandbox that would break sign-in. `allow-top-navigation` is deliberately not
// granted: the frame may navigate itself within our shell but never take over
// the Paseo window. Unlike the native side there is no reliable error signal
// for an unreachable origin (load fires either way), so a load that never
// arrives within the watchdog window is reported as failed, and the screen's
// pre-flight fetch probe catches origins that refuse connections outright.
const LOAD_WATCHDOG_MS = 20_000;

const IFRAME_STYLE = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function ItsaplanEmbed({
  origin,
  project,
  attempt,
  onLoaded,
  onFailed,
  testID,
}: ItsaplanEmbedProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const initialSrc = useMemo(() => {
    const trimmed = project?.trim();
    if (trimmed) {
      return `${origin.replace(/\/+$/, "")}/project/${encodeURIComponent(trimmed)}`;
    }
    return origin;
  }, [origin, project]);

  // Both: local state cancels the watchdog below, and the parent needs telling
  // so it can drop its loading overlay. Setting only the local flag left the
  // screen spinning forever on a perfectly good load.
  const handleLoad = useCallback(() => {
    setLoaded(true);
    onLoaded();
    const trimmed = project?.trim();
    if (trimmed && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "paseo:navigate-project", projectKey: trimmed },
        "*",
      );
    }
  }, [onLoaded, project]);

  useEffect(() => {
    if (loaded && project != null && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "paseo:navigate-project", projectKey: project.trim() },
        "*",
      );
    }
  }, [project, loaded]);

  useEffect(() => {
    // key={attempt} remounts this component per retry, so each attempt starts
    // un-loaded with a fresh watchdog. A cross-origin iframe gives no error
    // event: blocked TLS, refused connections, and error pages all surface as
    // silence or a spurious load. If no load lands in time, report failure so
    // the screen shows its unreachable state instead of an empty white frame.
    if (loaded) {
      return undefined;
    }
    const timer = setTimeout(onFailed, LOAD_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [loaded, onFailed]);

  return (
    <iframe
      ref={iframeRef}
      key={attempt}
      data-testid={testID}
      title={t("sidebar.sections.itsaplan")}
      src={initialSrc}
      onLoad={handleLoad}
      // itsaplan is a trusted first-party app the user points this at, and it
      // needs same-origin to read its own session cookie and run its own
      // scripts. That pair is what the rule objects to, and it is right that
      // the combination gives no isolation — a same-origin frame can clear its
      // own sandbox. Kept anyway as the narrowest declaration of intent (no
      // top-navigation, no downloads, no pointer lock). Contrast
      // html-preview.web.tsx, which renders UNTRUSTED repo documents and must
      // withhold allow-same-origin for the sandbox to mean anything.
      // eslint-disable-next-line react/iframe-missing-sandbox
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerPolicy="no-referrer"
      style={IFRAME_STYLE}
    />
  );
}

/**
 * No-op outside the Electron shell. Only the desktop build keeps a persistent
 * guest that can be warmed ahead of time; an iframe and a react-native WebView
 * are created by rendering them.
 */
export function warmItsaplanEmbed(_origin: string): void {}

export function prefetchItsaplanProject(_projectKey: string): void {}

export function prefetchItsaplanProjects(_projectKeys: readonly string[]): void {}
