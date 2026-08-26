import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface ItsaplanEmbedProps {
  origin: string;
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
// for an unreachable origin (load fires either way), so unreachability surfaces
// through the manual reload affordance rather than a detected failure.
const IFRAME_STYLE = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function ItsaplanEmbed({ origin, attempt, onLoaded, testID }: ItsaplanEmbedProps) {
  const { t } = useTranslation();
  const handleLoad = useCallback(() => onLoaded(), [onLoaded]);
  return (
    <iframe
      key={attempt}
      data-testid={testID}
      title={t("sidebar.sections.itsaplan")}
      src={origin}
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
