export interface FleetBrowserLiveViewProps {
  /** Selkies live view URL; `#shared` makes it a view-only stream. */
  url: string;
  title: string;
  testID?: string;
}

/** Watch: the view-only Selkies client (no input, never resizes the desktop). Control: full input. */
export function fleetBrowserLiveViewUrl(liveViewUrl: string, mode: "watch" | "control"): string {
  const base = liveViewUrl.replace(/#.*$/, "").replace(/\/?$/, "/");
  return mode === "watch" ? `${base}#shared` : base;
}
