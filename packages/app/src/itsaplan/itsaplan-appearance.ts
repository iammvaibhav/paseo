import type { Theme } from "@/styles/theme";

/**
 * The palette itsaplan takes from Paseo when embedded: its color scheme plus values for the CSS
 * variables of itsaplan's `globals.css` (applied by itsaplan's `lib/paseo-appearance.ts`).
 */
export interface ItsaplanAppearance {
  scheme: "dark" | "light";
  vars: Record<string, string>;
}

/**
 * Map Paseo's theme onto itsaplan's tokens so the embed reads as one of Paseo's panes.
 *
 * In the glass theme the guest page is see-through, so its sidebar shows the window vibrancy
 * exactly like Paseo's sidebar and its content sits on Paseo's chat-area tint. Menus take the
 * dense overlay fill: a guest's `backdrop-filter` cannot reach the vibrancy, and it would keep
 * the window on Chromium's slow path (see `GlassTreatment.overlay`). Cards are opaque: they
 * include the ticket side panel, a column of text over the board, where even the overlay fill
 * lets the cards behind show through.
 */
export function buildItsaplanAppearance(theme: Theme): ItsaplanAppearance {
  const colors = theme.colors;
  const glass = theme.glass;
  const raised = glass ? glass.scrim.surface1 : colors.surface1;
  return {
    scheme: theme.colorScheme,
    vars: {
      "--background": glass ? colors.surfaceContent : colors.surface0,
      "--foreground": colors.foreground,
      "--card": raised,
      "--card-foreground": colors.foreground,
      "--popover": glass ? glass.overlay : colors.popover,
      "--popover-foreground": colors.foreground,
      "--primary": colors.primaryAction,
      "--primary-foreground": colors.primaryActionForeground,
      "--secondary": colors.surface3,
      "--secondary-foreground": colors.foreground,
      "--muted": colors.surface2,
      "--muted-foreground": colors.foregroundMuted,
      "--accent": colors.surface2,
      "--accent-foreground": colors.foreground,
      "--border": colors.border,
      "--input": colors.borderAccent,
      "--ring": colors.accent,
      "--sidebar": colors.surfaceSidebar,
      "--sidebar-foreground": colors.foreground,
      "--sidebar-primary": colors.primaryAction,
      "--sidebar-primary-foreground": colors.primaryActionForeground,
      "--sidebar-accent": colors.surfaceSidebarSelected,
      "--sidebar-accent-foreground": colors.foreground,
      "--sidebar-border": colors.border,
      "--sidebar-ring": colors.accent,
      // Board lanes sit a step below the page and cards a step above it, as in itsaplan's own
      // themes; in glass both are washes over the content tint.
      "--kanban-column": glass ? colors.surfaceDiffEmpty : colors.surfaceSidebar,
      "--kanban-column-raised": colors.surface1,
      "--kanban-card": glass ? colors.surface2 : colors.surface1,
      "--kanban-card-hover": glass ? colors.surface3 : colors.surface2,
      "--paseo-font-ui": theme.fontFamily.ui,
    },
  };
}

/**
 * Script run in the itsaplan guest. It leaves the appearance on `window` for a bridge that has
 * not mounted yet (the guest is often still hydrating), and hands it to the bridge when it has.
 */
export function buildItsaplanAppearanceScript(appearance: ItsaplanAppearance): string {
  const json = JSON.stringify(appearance);
  return `(() => {
  window.__paseo_appearance = ${json};
  window.__paseo_itsaplan?.setAppearance?.(window.__paseo_appearance);
})()`;
}
