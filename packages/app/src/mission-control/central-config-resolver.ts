import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";
import type { RoutingConfig, RoutingSecretKey } from "@getpaseo/protocol/routing";

export function missionControlCentralConfigQueryKey(serverId: string | null) {
  return ["mission-control-central-config", serverId] as const;
}

/**
 * Every key present, defaults filled — mirrors what the daemon resolves
 * server-side (ResolvedMissionControlCentralConfig). The wire type keeps all
 * keys optional, so the app narrows at the RPC boundary.
 */
export interface ResolvedMissionControlCentralConfig {
  evaluationScope: "commander" | "all";
  retentionDays: number;
  namingTheme: string;
  hideAgentNames: boolean;
  ownTurnNotify: "always" | "not_viewing" | "never";
  defaultDispatchHost: string | null;
  silenceNudgeSeconds: number;
  statusNudgeSeconds: number;
  escalateSeconds: number;
  // Master switch for the stall machinery: when false the daemon never asks
  // agents for status updates; the dormant-turn detector still runs as
  // hard-wedge protection.
  stallDetectionEnabled: boolean;
  // Dormant-turn detector threshold (mirrors the daemon's resolved config):
  // seconds a running agent may sit with no output AND no tool in flight
  // before the turn is treated as wedged and recovered.
  dormantTurnSeconds: number;
  // Whether agents spawned by other agents emit Mission Control lifecycle events.
  trackSubagents: boolean;
  // Placement routing (New workspace auto-selection, fleet_create_agent fill-in).
  routing: RoutingConfig;
  // Which routing API keys this host holds; values never reach clients.
  routingSecretsSet: readonly RoutingSecretKey[];
}

const RESOLVED_DEFAULTS: ResolvedMissionControlCentralConfig = {
  evaluationScope: "commander",
  retentionDays: 30,
  namingTheme: "mixed",
  hideAgentNames: false,
  ownTurnNotify: "not_viewing",
  defaultDispatchHost: null,
  silenceNudgeSeconds: 120,
  statusNudgeSeconds: 300,
  escalateSeconds: 300,
  stallDetectionEnabled: true,
  dormantTurnSeconds: 300,
  trackSubagents: true,
  routing: {},
  routingSecretsSet: [],
};

// Grouped knob resolution (mirrors the server's split in mission-control/config.ts).
function resolveStallTimingKnobs(config: MissionControlCentralConfig) {
  const statusNudgeSeconds = config.statusNudgeSeconds ?? config.nudgeSeconds ?? 300;
  return {
    silenceNudgeSeconds: config.silenceNudgeSeconds ?? 120,
    statusNudgeSeconds,
    escalateSeconds: config.escalateSeconds ?? 300,
    stallDetectionEnabled: config.stallDetectionEnabled ?? true,
    dormantTurnSeconds: config.dormantTurnSeconds ?? 300,
  };
}

export function resolveMissionControlCentralConfig(
  config: MissionControlCentralConfig | null | undefined,
): ResolvedMissionControlCentralConfig {
  if (!config) {
    return RESOLVED_DEFAULTS;
  }
  return {
    evaluationScope: config.evaluationScope ?? "commander",
    retentionDays: config.retentionDays ?? 30,
    namingTheme: config.namingTheme ?? "mixed",
    hideAgentNames: config.hideAgentNames ?? false,
    ownTurnNotify: config.ownTurnNotify ?? "not_viewing",
    defaultDispatchHost: config.defaultDispatchHost ?? null,
    trackSubagents: config.trackSubagents ?? true,
    ...resolveStallTimingKnobs(config),
    routing: config.routing ?? {},
    routingSecretsSet: config.routingSecretsSet ?? [],
  };
}
