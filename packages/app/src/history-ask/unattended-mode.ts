import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";

const KNOWN_UNATTENDED_MODE_BY_PROVIDER: Record<string, string> = {
  claude: "bypassPermissions",
  codex: "full-access",
  copilot: "allow-all",
};

const ACP_ALLOW_ALL_MODE_ID = "paseo-allow-all";

export interface UnattendedModeCandidate {
  id: string;
  isUnattended?: boolean;
}

/**
 * Resolve the mode id for unattended History Ask launches.
 *
 * - claude → bypassPermissions
 * - codex → full-access
 * - copilot → allow-all
 * - ACP (cursor/grok/agy/…) → paseo-allow-all, else first isUnattended mode
 * - otherwise → first isUnattended mode, then protocol manifest, then known id
 */
export function resolveUnattendedModeId(
  provider: string,
  availableModes?: readonly UnattendedModeCandidate[] | null,
): string | undefined {
  const trimmedProvider = provider.trim();
  if (!trimmedProvider) {
    return undefined;
  }

  const modes = availableModes ?? [];
  const known = KNOWN_UNATTENDED_MODE_BY_PROVIDER[trimmedProvider];

  if (known) {
    if (modes.length === 0 || modes.some((mode) => mode.id === known)) {
      return known;
    }
  }

  const acpAllowAll = modes.find((mode) => mode.id === ACP_ALLOW_ALL_MODE_ID);
  if (acpAllowAll) {
    return acpAllowAll.id;
  }

  const markedUnattended = modes.find((mode) => mode.isUnattended === true);
  if (markedUnattended) {
    return markedUnattended.id;
  }

  if (known) {
    return known;
  }

  const fromManifest = getUnattendedModeId(trimmedProvider);
  if (fromManifest) {
    return fromManifest;
  }

  // ACP-style providers without a published unattended mode: prefer paseo-allow-all.
  if (modes.length === 0) {
    return ACP_ALLOW_ALL_MODE_ID;
  }

  return undefined;
}
