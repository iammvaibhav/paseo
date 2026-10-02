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
 * - When host snapshot lists modes: prefer `paseo-allow-all`, else first isUnattended
 * - When snapshot is empty `[]`: omit mode (provider has no modes — e.g. some ACP
 *   agents; daemon rejects invented mode ids with "Available modes: (none)")
 * - When snapshot is unknown: manifest unattended only; never invent paseo-allow-all
 */
export function resolveUnattendedModeId(
  provider: string,
  availableModes?: readonly UnattendedModeCandidate[] | null,
): string | undefined {
  const trimmedProvider = provider.trim();
  if (!trimmedProvider) {
    return undefined;
  }

  const known = KNOWN_UNATTENDED_MODE_BY_PROVIDER[trimmedProvider];
  const modesKnown = availableModes !== undefined && availableModes !== null;
  const modes = availableModes ?? [];

  // Built-in providers: prefer known unattended id even before modes load.
  if (known) {
    if (!modesKnown || modes.length === 0 || modes.some((mode) => mode.id === known)) {
      return known;
    }
    // Snapshot listed modes but not the known id — fall through.
  }

  if (modesKnown) {
    // Explicit empty list: provider has no modes; createAgent must omit modeId.
    if (modes.length === 0) {
      return undefined;
    }

    const acpAllowAll = modes.find((mode) => mode.id === ACP_ALLOW_ALL_MODE_ID);
    if (acpAllowAll) {
      return acpAllowAll.id;
    }

    const markedUnattended = modes.find((mode) => mode.isUnattended === true);
    if (markedUnattended) {
      return markedUnattended.id;
    }

    // Modes exist but none are unattended — still pick known if present, else omit.
    if (known && modes.some((mode) => mode.id === known)) {
      return known;
    }
    return undefined;
  }

  // Modes unknown (no snapshot): use protocol manifest only.
  if (known) {
    return known;
  }
  return getUnattendedModeId(trimmedProvider);
}
