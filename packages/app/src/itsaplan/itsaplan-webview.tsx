import { useCallback, useMemo, useRef } from "react";
import { Linking } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";
import { itsaplanNavigationKind } from "./itsaplan-navigation";

export interface ItsaplanEmbedProps {
  origin: string;
  project?: string;
  /** Bump to remount the embed (retry after a failed load). */
  attempt: number;
  onLoaded: () => void;
  onFailed: () => void;
  testID?: string;
}

// Same reasoning as FileHtmlPreview: `originWhitelist: ["*"]` forces every
// scheme through the guard below instead of react-native-webview silently
// handing rejects to the system browser, and multiple windows / automatic popups
// stay off so the page cannot escape the pane.
const ORIGIN_WHITELIST = ["*"];

export function ItsaplanEmbed({ origin, attempt, onLoaded, onFailed, testID }: ItsaplanEmbedProps) {
  const erroredRef = useRef(false);

  const handleFailed = useCallback(() => {
    // onError fires before onLoadEnd; remember it so a dead origin reports as
    // failed rather than loaded.
    erroredRef.current = true;
    onFailed();
  }, [onFailed]);

  const handleLoadEnd = useCallback(() => {
    if (!erroredRef.current) {
      onLoaded();
    }
  }, [onLoaded]);

  const handleShouldStartLoad = useCallback(
    ({ url }: { url: string }) => {
      const kind = itsaplanNavigationKind(url, origin);
      if (kind === "sameOrigin" || kind === "initial") {
        return true;
      }
      if (kind === "external") {
        void Linking.openURL(url).catch(() => undefined);
      }
      return false;
    },
    [origin],
  );

  const source = useMemo(() => ({ uri: origin }), [origin]);

  return (
    <WebView
      key={attempt}
      testID={testID}
      style={styles.webview}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
      onError={handleFailed}
      onHttpError={handleFailed}
      onRenderProcessGone={handleFailed}
      onLoadEnd={handleLoadEnd}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      cacheEnabled
    />
  );
}

const styles = StyleSheet.create(() => ({
  webview: {
    flex: 1,
    backgroundColor: "white",
  },
}));

/**
 * No-op outside the Electron shell. Only the desktop build keeps a persistent
 * guest that can be warmed ahead of time; an iframe and a react-native WebView
 * are created by rendering them.
 */
export function warmItsaplanEmbed(_origin: string): void {}

export function navigateItsaplanEmbedProject(_projectKey: string): void {}

export function prefetchItsaplanProject(_projectKey: string): void {}

export function prefetchItsaplanProjects(_projectKeys: readonly string[]): void {}

export function prefetchItsaplanAllProjects(): void {}
