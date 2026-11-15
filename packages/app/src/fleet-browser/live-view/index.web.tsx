import { useMemo } from "react";
import type { FleetBrowserLiveViewProps } from "./types";

// The fleet browser's Selkies live view, in an iframe on web and Electron. The
// page is a NetBird-only service at its own origin, so it keeps that origin for
// its WebSocket and storage; keyboard and clipboard work while it has focus.
const ALLOW = "autoplay; clipboard-read; clipboard-write; fullscreen; keyboard-map";
// Selkies needs its own origin (storage, WebSocket) and scripts; pointer lock and
// downloads keep take-over usable. It is a different origin from Paseo, so it can
// never reach this document.
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads";

export function FleetBrowserLiveView({ url, title, testID }: FleetBrowserLiveViewProps) {
  const style = useMemo<React.CSSProperties>(
    () => ({
      display: "block",
      width: "100%",
      height: "100%",
      border: 0,
      background: "transparent",
    }),
    [],
  );
  return (
    <iframe
      title={title}
      src={url}
      allow={ALLOW}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      data-testid={testID}
      style={style}
    />
  );
}
