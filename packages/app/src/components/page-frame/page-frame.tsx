import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet as RNStyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import {
  buildPageDocument,
  buildPageKitTheme,
  PAGE_HOST_SOURCE,
  parsePageFrameMessage,
  type PageHostThemeMessage,
} from "@getpaseo/protocol/page/kit";
import { resolvePageFrameHeight, type PageFrameProps } from "./types";

const ORIGIN_WHITELIST = ["*"];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** An agent page inline in the chat on iOS and Android: a transparent WebView. */
export function PageFrame({
  source,
  title,
  tokens,
  maxHeight,
  fill = false,
  onOpenUrl,
  testID,
}: PageFrameProps) {
  const webViewRef = useRef<WebView | null>(null);
  const kitTheme = useMemo(() => buildPageKitTheme(tokens), [tokens]);
  // Built once per mount; token changes while mounted are injected, so the page repaints
  // without reloading.
  const kitThemeRef = useRef(kitTheme);
  kitThemeRef.current = kitTheme;
  const html = source.kind === "html" ? source.html : null;
  const webViewSource = useMemo(
    () =>
      html === null
        ? { uri: source.kind === "url" ? source.url : "about:blank" }
        : {
            html: buildPageDocument({ html, theme: kitThemeRef.current, bridge: "webview" }),
          },
    [html, source],
  );
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const injectTheme = useCallback(() => {
    const message: PageHostThemeMessage = {
      source: PAGE_HOST_SOURCE,
      type: "theme",
      theme: kitThemeRef.current,
    };
    webViewRef.current?.injectJavaScript(
      `window.__paseoPageReceive && window.__paseoPageReceive(${JSON.stringify(message)}); true;`,
    );
  }, []);

  useEffect(() => {
    if (source.kind === "html") injectTheme();
  }, [injectTheme, kitTheme, source.kind]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let value: unknown;
      try {
        value = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      const message = parsePageFrameMessage(value);
      if (!message) return;
      if (message.type === "height") setContentHeight(message.height);
      else if (message.type === "open") onOpenUrl(message.url);
      else injectTheme();
    },
    [injectTheme, onOpenUrl],
  );

  const pageOrigin = source.kind === "url" ? originOf(source.url) : null;
  const handleShouldStartLoad = useCallback(
    (request: ShouldStartLoadRequest) => {
      const { url } = request;
      if (url === "about:blank" || url.startsWith("data:") || url.startsWith("about:srcdoc")) {
        return true;
      }
      // Sub-frames (embeds) load in place; isTopFrame is iOS-only, so only an explicit
      // `true` counts as a top-level navigation.
      if (request.isTopFrame !== true) return true;
      if (pageOrigin !== null && originOf(url) === pageOrigin) return true;
      if (/^https?:\/\//i.test(url)) onOpenUrl(url);
      return false;
    },
    [onOpenUrl, pageOrigin],
  );

  const overflows =
    source.kind === "url" || fill || (contentHeight !== null && contentHeight > maxHeight);
  const height = resolvePageFrameHeight({ source, fill, contentHeight, maxHeight });
  const style = useMemo(
    () => [styles.webView, height === null ? styles.fill : { height }],
    [height],
  );

  return (
    <WebView
      ref={webViewRef}
      testID={testID}
      accessibilityLabel={title}
      source={webViewSource}
      originWhitelist={ORIGIN_WHITELIST}
      style={style}
      containerStyle={styles.container}
      onMessage={handleMessage}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
      scrollEnabled={overflows}
      nestedScrollEnabled={overflows}
      bounces={false}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      javaScriptEnabled
      domStorageEnabled
    />
  );
}

const styles = RNStyleSheet.create({
  // A transparent WebView is not opaque, so the chat background shows through.
  webView: { backgroundColor: "transparent" },
  container: { backgroundColor: "transparent" },
  fill: { flex: 1 },
});
