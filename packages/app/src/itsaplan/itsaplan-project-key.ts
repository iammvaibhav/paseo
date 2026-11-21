/** Upper bound on the name-derived portion of an itsaplan project key. */
export const ITSAPLAN_PROJECT_KEY_MAX_BASE = 12;

/**
 * Derives the itsaplan project key candidate from the project's display
 * name: uppercase alphanumeric only — itsaplan keys are immutable issue-ID
 * prefixes ("MKT" -> "MKT-1") and URL segments, so slashes/colons from a raw
 * cross-host paseoProjectKey never belong here.
 */
export function deriveItsaplanProjectKey(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ITSAPLAN_PROJECT_KEY_MAX_BASE);
  return base.length > 0 ? base : "PROJECT";
}

/**
 * Resolves the itsaplan project key for a sidebar project entry or display name.
 */
export function resolveProjectItsaplanKey(
  project?: { projectKey?: string | null; projectName?: string | null } | null,
  displayName?: string | null,
): string {
  const explicitKey = project?.projectKey?.trim();
  if (explicitKey && !explicitKey.includes(":") && !explicitKey.includes("/")) {
    const derived = deriveItsaplanProjectKey(explicitKey);
    if (derived !== "PROJECT") {
      return derived;
    }
  }

  const name = (displayName?.trim() || project?.projectName?.trim() || "").trim();
  return deriveItsaplanProjectKey(name);
}
