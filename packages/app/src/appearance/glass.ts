import { useMemo } from "react";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { getIsElectronMac } from "@/constants/platform";
import { resolveGlassColors, type GlassTreatment } from "@/styles/theme";

/** Glass exists only where the window provides vibrancy: Mono in the macOS desktop app. */
export function isGlassThemePreference(preference: AppSettings["theme"]): boolean {
  return preference === "mono" && getIsElectronMac();
}

/**
 * The active glass treatment for a component that must paint it inline (outside a stylesheet),
 * or null when the theme is not glass. Follows the Appearance → Glass settings.
 */
export function useGlassTreatment(): GlassTreatment | null {
  const { settings } = useAppSettings();
  return useMemo(
    () =>
      isGlassThemePreference(settings.theme)
        ? resolveGlassColors(settings.glassTuning).glass
        : null,
    [settings.glassTuning, settings.theme],
  );
}
