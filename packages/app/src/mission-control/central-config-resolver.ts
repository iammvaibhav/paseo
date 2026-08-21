import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";

export function missionControlCentralConfigQueryKey(serverId: string | null) {
  return ["mission-control-central-config", serverId] as const;
}

/**
 * Every key present, defaults filled — mirrors what the daemon resolves
 * server-side (ResolvedMissionControlCentralConfig). The wire type keeps all
 * keys optional, so the app narrows at the RPC boundary.
 */
export interface ResolvedMissionControlCentralConfig {
  commanderHost: string | null;
  commanderModel: string | null;
  commanderInstructions: string;
  verifierModel: string | null;
  verifierConcurrency: number;
  evaluationScope: "commander" | "all";
  mode: MissionControlMode;
  retentionDays: number;
  namingTheme: string;
  hideAgentNames: boolean;
  defaultDispatchHost: string | null;
  silenceNudgeSeconds: number;
  statusNudgeSeconds: number;
  escalateSeconds: number;
  // Master switch for the stall machinery: when false the daemon never asks
  // agents for status updates (no silence/status nudges, no escalation) — the
  // dormant-turn detector still runs as hard-wedge protection.
  stallDetectionEnabled: boolean;
  // Dormant-turn detector threshold (mirrors the daemon's resolved central
  // config): seconds a running agent may sit with no output AND no tool in
  // flight before the turn is treated as wedged and recovered.
  dormantTurnSeconds: number;
  // Default delivery for commander/verifier → worker sends (mirrors the
  // daemon's resolved central config). Stall nudges unaffected.
  commanderToWorkerMode: "steer" | "interrupt" | "queue";
  verifierToWorkerMode: "steer" | "interrupt" | "queue";
  // Hindsight fleet memory (M6 context architecture). hindsightUrl null =
  // disabled (run records stay local; fleet_recall degrades to "memory
  // unavailable"). hindsightBank is the bank run records are written to and
  // recalled over; hindsightSecondaryBank is the read-only secondary recall
  // source (omp), null = no secondary source.
  hindsightUrl: string | null;
  hindsightBank: string;
  hindsightSecondaryBank: string | null;
  // M9 in-app Commander Voice: where the voice node lives (scripts/
  // commander-voice). The Mission Control composer shows Commander Voice only
  // when this is set; null/empty = feature hidden.
  voiceNodeUrl: string | null;
  // M9 voice tool surface: "relay" (default) = shared read tools plus
  // commander_dispatch/proposal_respond/pending_updates, mutations via the
  // Commander; "direct" = full Commander allowlist, every call mirrored.
  // Applies to NEW voice sessions; an open session keeps its start mode.
  voiceMode: "relay" | "direct";
  // Lifecycle-tracking gates (mirror the daemon's resolved central config):
  // which agent classes emit Mission Control lifecycle events. The Commander
  // itself is never tracked; root agents are always tracked.
  trackCommanderWorkers: boolean;
  trackVerifiers: boolean;
  trackSubagents: boolean;
}

const RESOLVED_DEFAULTS: ResolvedMissionControlCentralConfig = {
  commanderHost: null,
  commanderModel: null,
  commanderInstructions: "",
  verifierModel: null,
  verifierConcurrency: 3,
  evaluationScope: "commander",
  mode: "ask",
  retentionDays: 30,
  namingTheme: "mixed",
  hideAgentNames: false,
  defaultDispatchHost: null,
  silenceNudgeSeconds: 120,
  statusNudgeSeconds: 300,
  escalateSeconds: 300,
  stallDetectionEnabled: true,
  dormantTurnSeconds: 300,
  commanderToWorkerMode: "interrupt",
  verifierToWorkerMode: "interrupt",
  hindsightUrl: null,
  hindsightBank: "paseo-fleet",
  hindsightSecondaryBank: "omp",
  voiceNodeUrl: null,
  voiceMode: "relay",
  trackCommanderWorkers: true,
  trackVerifiers: true,
  trackSubagents: true,
};

// Grouped knob resolution (mirrors the server's resolveNullableStringKnobs
// split in mission-control/config.ts): each group owns its defaults so the
// composer stays a flat spread.
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

function resolveMemoryKnobs(config: MissionControlCentralConfig) {
  const hindsightUrl = config.hindsightUrl ?? null;
  return {
    hindsightUrl,
    hindsightBank: config.hindsightBank ?? "paseo-fleet",
    hindsightSecondaryBank: config.hindsightSecondaryBank ?? "omp",
  };
}

function resolveVoiceKnobs(config: MissionControlCentralConfig) {
  return {
    voiceNodeUrl: config.voiceNodeUrl ?? null,
    voiceMode: config.voiceMode ?? "relay",
  };
}

export function resolveMissionControlCentralConfig(
  config: MissionControlCentralConfig | null | undefined,
): ResolvedMissionControlCentralConfig {
  if (!config) {
    return RESOLVED_DEFAULTS;
  }
  return {
    commanderHost: config.commanderHost ?? null,
    commanderModel: config.commanderModel ?? null,
    commanderInstructions: config.commanderInstructions ?? "",
    verifierModel: config.verifierModel ?? null,
    verifierConcurrency: config.verifierConcurrency ?? 3,
    evaluationScope: config.evaluationScope ?? "commander",
    mode: config.mode ?? "ask",
    retentionDays: config.retentionDays ?? 30,
    namingTheme: config.namingTheme ?? "mixed",
    hideAgentNames: config.hideAgentNames ?? false,
    defaultDispatchHost: config.defaultDispatchHost ?? null,
    commanderToWorkerMode: config.commanderToWorkerMode ?? "interrupt",
    verifierToWorkerMode: config.verifierToWorkerMode ?? "interrupt",
    trackCommanderWorkers: config.trackCommanderWorkers ?? true,
    trackVerifiers: config.trackVerifiers ?? true,
    trackSubagents: config.trackSubagents ?? true,
    ...resolveStallTimingKnobs(config),
    ...resolveMemoryKnobs(config),
    ...resolveVoiceKnobs(config),
  };
}
