import {
  IDENTITY_COLOR_NAMES,
  deriveIdentityColorName,
  type IdentityColorName,
} from "@/styles/identity-colors";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

/**
 * Per-host glyph override, as persisted in `missionControl.hostGlyph` on the
 * daemon config. Both fields are optional and independently resettable; an
 * empty override (null) means "defaults".
 */
export interface HostGlyphOverride {
  initials?: string | null;
  color?: string | null;
}

const IDENTITY_COLOR_SET: ReadonlySet<string> = new Set(IDENTITY_COLOR_NAMES);

/**
 * Wire → safe override. Anything that is not a plain object yields null (no
 * override). Unknown colors and blank initials are dropped — the palette is
 * app-owned, so a stale value must never break the glyph. Initials are bounded
 * to the first two code points so an emoji counts as one character.
 */
export function normalizeHostGlyphOverride(value: unknown): HostGlyphOverride | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const normalized: HostGlyphOverride = {};
  if (typeof record.initials === "string") {
    const initials = Array.from(record.initials.trim()).slice(0, 2).join("");
    if (initials.length > 0) {
      normalized.initials = initials;
    }
  }
  if (typeof record.color === "string" && IDENTITY_COLOR_SET.has(record.color)) {
    normalized.color = record.color;
  }
  return normalized.initials !== undefined || normalized.color !== undefined ? normalized : null;
}

export interface HostGlyphPresentation {
  /** The character(s) drawn on the chip. */
  glyph: string;
  /** Resolved identity color (override wins, else deterministic from serverId). */
  colorName: IdentityColorName;
}

/**
 * Override precedence (spec): custom initials/color beat the default of
 * "alias initial + deterministic color". The alias is preferred over the raw
 * host label for the default initial because the alias is the host's fleet
 * identity; the label prop stays the tooltip's "full name".
 */
export function resolveHostGlyphPresentation(input: {
  serverId: string;
  label: string;
  override?: HostGlyphOverride | null;
}): HostGlyphPresentation {
  const { serverId, label, override } = input;
  const overrideInitials = override?.initials?.trim() ?? "";
  const glyph =
    overrideInitials.length > 0 ? overrideInitials : firstGlyphCharacter(label.trim() || serverId);
  const overrideColor = override?.color;
  const colorName: IdentityColorName =
    overrideColor !== undefined && overrideColor !== null && IDENTITY_COLOR_SET.has(overrideColor)
      ? (overrideColor as IdentityColorName)
      : deriveIdentityColorName(serverId);
  return { glyph, colorName };
}

function firstGlyphCharacter(value: string): string {
  return Array.from(value)[0]?.toUpperCase() ?? "?";
}

/**
 * Connection status → glyph signal. Online is the quiet full-color chip;
 * connecting warns with the amber token, everything else (idle/offline/error)
 * alerts with the danger token — mirroring the status dot's mapping so no
 * information is lost when the dot is replaced.
 */
export type HostGlyphStatusSignal = "none" | "warning" | "danger";

export function hostGlyphStatusSignal(status: HostRuntimeConnectionStatus): HostGlyphStatusSignal {
  if (status === "online") {
    return "none";
  }
  return status === "connecting" ? "warning" : "danger";
}
