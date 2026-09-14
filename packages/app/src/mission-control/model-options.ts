import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import type { HostProfile } from "@/types/host-connection";

/**
 * Builds the set of invocable provider/model strings (`provider/modelId`)
 * from a host's provider snapshot entries. Mirrors the server's
 * `collectHostInvocableModels` (paseo-tools.ts), filtered to enabled entries
 * that can actually spawn agents.
 */
export function buildInvocableProviderModelStrings(
  entries: readonly ProviderSnapshotEntry[] | undefined,
): Set<string> {
  const strings = new Set<string>();
  if (!entries) {
    return strings;
  }
  for (const entry of entries) {
    if (!entry.enabled) {
      continue;
    }
    for (const model of entry.models ?? []) {
      if (model.id) {
        strings.add(`${entry.provider}/${model.id}`);
      }
    }
  }
  return strings;
}

export type IntersectInvocableResult =
  | { status: "unreachable"; reason: string }
  | { status: "empty"; reason: string }
  | { status: "ready"; strings: Set<string> };

/**
 * Computes the intersection of invocable provider/model strings across all
 * candidate hosts. Verifiers spawn per-host on the worker's host, so a
 * fleet-wide verifierModel MUST be invocable on every host that could spawn a
 * verifier. If any connected host's snapshot is unavailable, the
 * intersection cannot be guaranteed and yields an unreachable state.
 */
export function intersectInvocableProviderModelStrings(
  entriesByHost: readonly (readonly ProviderSnapshotEntry[] | undefined)[],
): IntersectInvocableResult {
  if (entriesByHost.length === 0) {
    return { status: "unreachable", reason: "No connected hosts" };
  }

  for (let index = 0; index < entriesByHost.length; index += 1) {
    if (!entriesByHost[index]) {
      return {
        status: "unreachable",
        reason: "At least one connected host snapshot is unavailable",
      };
    }
  }

  const sets = entriesByHost.map((entries) => buildInvocableProviderModelStrings(entries));
  const first = sets[0];
  const intersection = new Set<string>();

  for (const candidate of first) {
    let inAll = true;
    for (let index = 1; index < sets.length; index += 1) {
      if (!sets[index].has(candidate)) {
        inAll = false;
        break;
      }
    }
    if (inAll) {
      intersection.add(candidate);
    }
  }

  if (intersection.size === 0) {
    return { status: "empty", reason: "No model is invocable on every connected host" };
  }

  return { status: "ready", strings: intersection };
}

/**
 * Filters a reference host's `ProviderSelectorProvider[]` options to keep
 * only model rows present in an allowed set of invocable `provider/model` strings.
 */
export function filterProvidersToInvocableStrings(
  providers: ProviderSelectorProvider[],
  allowed: ReadonlySet<string>,
): ProviderSelectorProvider[] {
  const filtered: ProviderSelectorProvider[] = [];

  for (const provider of providers) {
    if (provider.modelSelection.kind !== "models") {
      filtered.push(provider);
      continue;
    }

    const survivingRows = provider.modelSelection.rows.filter((row) => {
      // Default / empty model row ("Host default") is valid when provider has selectable models
      if (!row.modelId) {
        return true;
      }
      return allowed.has(`${row.provider}/${row.modelId}`);
    });

    // Keep provider if it has at least one explicit model row or a synthetic default row
    if (survivingRows.length > 0) {
      filtered.push({
        ...provider,
        modelSelection: {
          kind: "models",
          rows: survivingRows,
        },
      });
    }
  }

  return filtered;
}

/**
 * Resolves `config.commanderHost` (a stored hostname, missionControl.hostAlias,
 * label, serverId, or "local") to the matching `HostProfile` serverId.
 * Matching mirrors server-side `isDesignatedCommanderHost`: the central value
 * is trimmed and compared case-sensitively; a host's alias matches only when
 * non-null. The label fallback is app-side (the settings picker's last resort).
 */
export function resolveCommanderHostServerId(input: {
  commanderHost: string | null;
  hosts: readonly HostProfile[];
  hostnameByServerId: Map<string, string | null>;
  hostAliasByServerId: Map<string, string | null>;
  localServerId: string | null;
}): string | null {
  const { hosts, hostnameByServerId, hostAliasByServerId, localServerId } = input;
  const commanderHost = input.commanderHost?.trim() || null;
  if (commanderHost === null) {
    return null;
  }

  if (commanderHost === "local") {
    if (localServerId && hosts.some((h) => h.serverId === localServerId)) {
      return localServerId;
    }
    return hosts[0]?.serverId ?? null;
  }

  const directServerId = hosts.find((h) => h.serverId === commanderHost);
  if (directServerId) {
    return directServerId.serverId;
  }

  const byHostname = hosts.find((h) => hostnameByServerId.get(h.serverId) === commanderHost);
  if (byHostname) {
    return byHostname.serverId;
  }

  // Mirrors isDesignatedCommanderHost: null alias never matches; otherwise
  // exact (case-sensitive) equality on the trimmed value.
  const byHostAlias = hosts.find((h) => {
    const alias = hostAliasByServerId.get(h.serverId);
    return alias !== null && alias === commanderHost;
  });
  if (byHostAlias) {
    return byHostAlias.serverId;
  }

  const byLabel = hosts.find((h) => h.label === commanderHost);
  if (byLabel) {
    return byLabel.serverId;
  }

  return null;
}
