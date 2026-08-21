import { createContext, useContext, type ReactNode } from "react";
import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";

const TitlebarDragRegionEnabledContext = createContext(true);

/**
 * VS Code-style titlebar drag region for Electron.
 *
 * Copied from VS Code at commit daa0a70:
 *   - titlebarPart.ts:463-464  → prepend(container, $('div.titlebar-drag-region'))
 *   - titlebarpart.css:57-64   → position: absolute, full size, -webkit-app-region: drag
 *   - titlebarpart.css:249-260 → top-edge resizer, no-drag, 4px
 *
 * VS Code's drag region is a static DOM element — no z-index, no pointer-events,
 * no state, no event listeners. Interactive elements get no-drag from their own
 * CSS (global backstop in index.html). The drag region never re-renders.
 *
 * The resizer is Windows/Linux only (titlebarpart.css:249 scopes to .windows/.linux).
 * On macOS, Electron handles edge resize natively.
 */

const DRAG_OVERLAY_STYLE: React.CSSProperties = {
  top: 0,
  left: 0,
  display: "block",
  position: "absolute",
  width: "100%",
  height: "100%",
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "drag",
};

const TOP_RESIZER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  width: "100%",
  height: 4,
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "no-drag",
};

/**
 * Scopes drag-region rendering to subtrees that are actually visible.
 * Invisible keep-mounted overlays must not declare drag regions: Blink
 * collects -webkit-app-region from the whole layout tree in DOM order,
 * ignoring opacity, z-index, and pointer-events, so a later drag rect from a
 * hidden overlay re-covers — and kills clicks on — the interactive elements
 * beneath it (the hidden Mission Control layer was eating the workspace
 * header buttons).
 */
export function TitlebarDragRegionEnabled({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <TitlebarDragRegionEnabledContext.Provider value={enabled}>
      {children}
    </TitlebarDragRegionEnabledContext.Provider>
  );
}

/**
 * Static drag overlay and top-edge resizer. Returns null on non-Electron.
 * Place as FIRST child of any positioned container that should be draggable.
 */
export function TitlebarDragRegion() {
  const enabled = useContext(TitlebarDragRegionEnabledContext);
  if (isNative || !getIsElectronRuntime() || !enabled) {
    return null;
  }

  return (
    <>
      {/* Drag overlay — VS Code .titlebar-drag-region (titlebarpart.css:57-64) */}
      <div style={DRAG_OVERLAY_STYLE} />
      {/* Top-edge resizer — VS Code .resizer (titlebarpart.css:249-256) */}
      <div style={TOP_RESIZER_STYLE} />
    </>
  );
}
