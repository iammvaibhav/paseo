import { useMemo } from "react";
import { StyleSheet as RNStyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import type { FleetBrowserLiveViewProps } from "./types";

// The fleet browser's Selkies live view on iOS and Android. Selkies decodes its
// stream into a canvas and takes touch as mouse input; its own keyboard button
// opens the on-screen keyboard while the user has control.
const ORIGIN_WHITELIST = ["https://*"];

export function FleetBrowserLiveView({ url, title, testID }: FleetBrowserLiveViewProps) {
  const source = useMemo(() => ({ uri: url }), [url]);
  return (
    <WebView
      testID={testID}
      accessibilityLabel={title}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      style={styles.webView}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      bounces={false}
      scrollEnabled={false}
    />
  );
}

const styles = RNStyleSheet.create({
  webView: { flex: 1, backgroundColor: "transparent" },
});
