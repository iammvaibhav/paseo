import {
  buildHostInfoByServerId,
  resolveCommanderServerId,
  type HostInfoByServerId,
} from "@/screens/mission-control/commander-host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * The host a Mission Control card must open its inspector against. Structural
 * subset of `FeedCardEvent` (AggregatedMissionControlEvent): the card is
 * stamped with the host that EMITTED it (`event.serverId`), which for a
 * spawn-kind proposal is the Commander's host — NOT the host the spawned
 * agent actually runs on. The spawn plan names the target host
 * (`spawnPlan.host`: a peer name / missionControl.hostAlias / hostname, or
 * "local" = the card's own host), so the inspector must look the spawned
 * agent up on THAT host or the agent/workspace resolves "missing" (the false
 * Archived banner).
 */
export interface SpawnHostCarryingEvent {
  serverId: string;
  proposal?: {
    kind?: string | null;
    spawnPlan?: { host?: string | null } | null;
    /**
     * The serverId of the host the spawn actually RAN on, stamped by the
     * executor at execution time (approvals.ts). The card's `serverId` is the
     * EMITTING host (the Commander's), which differs for peer-routed spawns —
     * this field is the ground truth the inspector prefers when present.
     */
    spawnedOnServerId?: string | null;
  } | null;
}

/**
 * Resolve the host a card's agent lives on. Precedence:
 *  1. the proposal's stamped `spawnedOnServerId` (the host the spawn actually
 *     ran on — authoritative, never guessed),
 *  2. the spawn plan's host alias when the card is a spawn-kind proposal
 *     naming a non-local host (legacy records and older daemons without the
 *     stamp),
 *  3. the emitting `event.serverId`.
 * Reuses Mission Control's existing alias → serverId resolver
 * (resolveCommanderServerId — the same mapping the Commander-host
 * designation uses: serverId, then server_info hostname, then
 * missionControl.hostAlias). Pure — callers supply the hosts + identity maps.
 */
export function resolveEventAgentServerId(
  event: SpawnHostCarryingEvent,
  hosts: readonly { serverId: string }[],
  hostInfoByServerId: Readonly<HostInfoByServerId>,
  hostAliases?: Readonly<Record<string, string>>,
): string {
  const stampedServerId = event.proposal?.spawnedOnServerId?.trim();
  if (stampedServerId) {
    return stampedServerId;
  }
  const spawnHost = event.proposal?.spawnPlan?.host?.trim();
  if (event.proposal?.kind === "spawn" && spawnHost && spawnHost.toLowerCase() !== "local") {
    return (
      resolveCommanderServerId(spawnHost, hosts, hostInfoByServerId, hostAliases) ?? event.serverId
    );
  }
  return event.serverId;
}

/**
 * Store-backed convenience for card press handlers: reads the connected hosts
 * and the per-server identity map (hostname + missionControl.hostAlias) at
 * press time and resolves the card's agent host. No subscription needed — the
 * resolution only matters when the user clicks, and the card re-renders on
 * session/host changes through its other subscriptions.
 */
export function resolveCardEventAgentServerId(
  event: SpawnHostCarryingEvent,
  hostAliases?: Readonly<Record<string, string>>,
): string {
  const hosts = getHostRuntimeStore().getHosts();
  const hostInfoByServerId = buildHostInfoByServerId(useSessionStore.getState().sessions);
  return resolveEventAgentServerId(event, hosts, hostInfoByServerId, hostAliases);
}
