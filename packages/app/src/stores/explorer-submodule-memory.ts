import { buildExplorerCheckoutKey } from "./explorer-tab-memory";

/**
 * Per-checkout memory of the submodule selected in the explorer header picker.
 * Keyed the same way as the explorer tab memory (serverId + workspace root), so
 * reopening a workspace lands on the submodule the user last looked at instead
 * of resetting to the superproject root.
 *
 * `null` is the root checkout and is stored as an absent key, not an entry. A
 * remembered path that no longer exists in the checkout is ignored by the caller
 * rather than pruned here, so the selection resumes if the submodule comes back
 * (branch switch, `submodule update`).
 */
export function resolveSelectedSubmoduleForCheckout(params: {
  serverId: string;
  cwd: string;
  selectedSubmoduleByCheckout: Record<string, string>;
}): string | null {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  if (!key) {
    return null;
  }
  const stored = params.selectedSubmoduleByCheckout[key];
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

export function setSelectedSubmoduleEntry(
  selectedSubmoduleByCheckout: Record<string, string>,
  params: { serverId: string; cwd: string; submodulePath: string | null },
): Record<string, string> {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  if (!key) {
    return selectedSubmoduleByCheckout;
  }
  const next = params.submodulePath?.trim() ?? "";
  const current = selectedSubmoduleByCheckout[key];
  if (!next) {
    if (current === undefined) {
      return selectedSubmoduleByCheckout;
    }
    const { [key]: _removed, ...rest } = selectedSubmoduleByCheckout;
    return rest;
  }
  if (current === next) {
    return selectedSubmoduleByCheckout;
  }
  return { ...selectedSubmoduleByCheckout, [key]: next };
}

export function sanitizeSelectedSubmoduleByCheckout(value: unknown): Record<string, string> {
  if (typeof value !== "object" || !value) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.length > 0) {
      next[key] = entry;
    }
  }
  return next;
}
