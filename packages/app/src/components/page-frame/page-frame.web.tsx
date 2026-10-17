import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPageDocument,
  buildPageKitTheme,
  PAGE_HOST_SOURCE,
  parsePageFrameMessage,
  type PageHostThemeMessage,
} from "@getpaseo/protocol/page/kit";
import { resolvePageFrameHeight, type PageFrameProps } from "./types";

// A page is its own opaque origin: it runs scripts and loads the network, but it cannot
// reach this document, its storage, or the daemon session. No popups: the kit routes
// links and window.open to the host instead. No modals: an alert() in a reply would block
// the whole app.
const HTML_SANDBOX = "allow-scripts allow-forms";
// A URL page is a real app at another origin; it keeps that origin for its own storage.
const URL_SANDBOX = "allow-scripts allow-forms allow-modals allow-same-origin allow-downloads";
const SAME_ORIGIN_URL_SANDBOX = "allow-scripts allow-forms allow-modals";

function urlSandbox(url: string): string {
  try {
    // Same origin + allow-same-origin would hand the page this document. Never grant both.
    return new URL(url).origin === window.location.origin ? SAME_ORIGIN_URL_SANDBOX : URL_SANDBOX;
  } catch {
    return SAME_ORIGIN_URL_SANDBOX;
  }
}

/** An agent page inline in the chat: a sandboxed iframe on the chat's own background. */
export function PageFrame({
  source,
  title,
  tokens,
  maxHeight,
  fill = false,
  onOpenUrl,
  testID,
}: PageFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const kitTheme = useMemo(() => buildPageKitTheme(tokens), [tokens]);
  // The document is built once per mount; token changes while the row stays mounted go in
  // by postMessage, so the page repaints without reloading. A full theme switch remounts the
  // chat, and the rebuilt document carries the new theme.
  const kitThemeRef = useRef(kitTheme);
  kitThemeRef.current = kitTheme;
  const html = source.kind === "html" ? source.html : null;
  const srcDoc = useMemo(
    () =>
      html === null
        ? undefined
        : buildPageDocument({ html, theme: kitThemeRef.current, bridge: "iframe" }),
    [html],
  );
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;

  useEffect(() => {
    function postTheme(): void {
      const message: PageHostThemeMessage = {
        source: PAGE_HOST_SOURCE,
        type: "theme",
        theme: kitThemeRef.current,
      };
      iframeRef.current?.contentWindow?.postMessage(message, "*");
    }
    function receive(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parsePageFrameMessage(event.data);
      if (!message) return;
      if (message.type === "height") setContentHeight(message.height);
      else if (message.type === "open") onOpenUrlRef.current(message.url);
      else postTheme();
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (source.kind !== "html") return;
    const message: PageHostThemeMessage = {
      source: PAGE_HOST_SOURCE,
      type: "theme",
      theme: kitTheme,
    };
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, [kitTheme, source.kind]);

  const height = resolvePageFrameHeight({ source, fill, contentHeight, maxHeight }) ?? "100%";

  const style = useMemo<React.CSSProperties>(
    () => ({
      display: "block",
      width: "100%",
      height,
      border: 0,
      background: "transparent",
      // Chromium paints an opaque canvas behind an iframe whose color-scheme differs from
      // the parent's; match it so the page stays on the chat's own background.
      colorScheme: tokens.colorScheme,
    }),
    [height, tokens.colorScheme],
  );

  return (
    <iframe
      ref={iframeRef}
      title={title}
      data-testid={testID}
      sandbox={source.kind === "html" ? HTML_SANDBOX : urlSandbox(source.url)}
      srcDoc={srcDoc}
      src={source.kind === "url" ? source.url : undefined}
      referrerPolicy="no-referrer"
      style={style}
    />
  );
}
