import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

const CENTRAL_CONFIG_DIR = "mission-control";
const CENTRAL_CONFIG_FILENAME = "central-config.json";

/**
 * Resolved central Mission Control config: every key present, defaults filled.
 * Only commanderModel/verifierModel/commanderHost/defaultDispatchHost may be
 * null (the model overrides and host designations are optional by spec).
 * commanderHost null = NO host is designated (never "self-designate"): the
 * daemon must be explicitly told which host runs the fleet Commander.
 */
export interface ResolvedMissionControlCentralConfig {
  commanderHost: string | null;
  commanderModel: string | null;
  commanderInstructions: string;
  verifierModel: string | null;
  verifierConcurrency: number;
  evaluationScope: "commander" | "all";
  mode: "ask" | "auto";
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
  // Dormant-turn detector: seconds a running agent may sit with NO timeline
  // output AND no tool call in flight before the turn is treated as wedged
  // (omp loop-advance failure) and recovered via the interrupt path. Default
  // 300 (5 min). Floor = slowest legitimate model call (178.6s max of 8242
  // samples; a 727k-token call took 48s TTFT + 54s) — Paseo cannot observe a
  // model request in flight (omp-internal, no timeline rows), so values under
  // ~4 min risk false positives.
  dormantTurnSeconds: number;
  // Delivery semantics for commander/verifier → worker sends. Default
  // "interrupt": a fleet direction change is time-sensitive — queue-until-idle
  // can sit for tens of minutes. The Commander may still pass an explicit
  // `mode` to fleet_send_prompt (e.g. "steer" for additive, non-urgent
  // instructions); stall nudges are unaffected (always native steer).
  commanderToWorkerMode: "steer" | "interrupt" | "queue";
  verifierToWorkerMode: "steer" | "interrupt" | "queue";
  // M6 context architecture: Hindsight fleet memory bank. hindsightUrl null =
  // disabled (run records stay local; fleet_recall degrades to "memory
  // unavailable"). hindsightBank names the bank to write/recall (default
  // "paseo-fleet"; the omp bank stays read-only, never written).
  // hindsightSecondaryBank names an ADDITIONAL read-only bank fleet_recall
  // consults behind the primary (default "omp": transcript memories). Null =
  // no secondary source; it is never written to.
  hindsightUrl: string | null;
  hindsightBank: string;
  hindsightSecondaryBank: string | null;
  // M9 in-app Commander Voice: where the voice node lives on this fleet. The
  // app reads it from central config to decide whether to show Commander
  // Voice in the Mission Control composer and where to connect. Null/empty =
  // feature hidden.
  voiceNodeUrl: string | null;
  // Lifecycle-tracking gates: which agent classes emit Mission Control
  // lifecycle events. The Commander itself is never tracked; root agents are
  // always tracked. Defaults: all three classes tracked.
  trackCommanderWorkers: boolean;
  trackVerifiers: boolean;
  trackSubagents: boolean;
}

export const DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG: ResolvedMissionControlCentralConfig = {
  commanderHost: null,
  commanderModel: null,
  // The shipped contract now lives in the bundled commander-prompt.md; the
  // central instructions are user overrides appended on top at build time.
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
  trackCommanderWorkers: true,
  trackVerifiers: true,
  trackSubagents: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Central Mission Control settings, stored on the commander host and edited
 * from anywhere via mission_control.config.get/patch. Per-host keys
 * (missionControl.enabled, missionControl.hostAlias) stay in the daemon
 * config; everything fleet-policy lives here.
 */
export class CentralMissionControlConfigStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private config: MissionControlCentralConfig = {};
  private initialized = false;

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.dir = join(options.paseoHome, CENTRAL_CONFIG_DIR);
    this.logger = options.logger.child({ module: "mission-control", component: "config" });
  }

  async initialize(): Promise<void> {
    // Idempotent: ONE store is shared daemon-wide (bootstrap initializes it,
    // MissionControlService.start() also calls initialize), so a second call
    // must never re-read the file and clobber in-memory state.
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await mkdir(this.dir, { recursive: true });
    let content: string;
    try {
      content = await readFile(join(this.dir, CENTRAL_CONFIG_FILENAME), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn({ err: error }, "Failed to load central mission control config");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)) {
        this.config = pickCentralConfigKeys(parsed);
        // Migrate the pre-rename knob (nudgeSeconds -> statusNudgeSeconds):
        // pre-release central config, so one read at load is enough — the old
        // key is dropped from the persisted file.
        if (
          typeof parsed["nudgeSeconds"] === "number" &&
          this.config.statusNudgeSeconds === undefined
        ) {
          this.config.statusNudgeSeconds = parsed["nudgeSeconds"];
          try {
            await writeJsonFileAtomic(join(this.dir, CENTRAL_CONFIG_FILENAME), this.config);
            this.logger.info(
              { component: "config", from: "nudgeSeconds", to: "statusNudgeSeconds" },
              "mission_control.config.migrated_nudge_knob",
            );
          } catch (error) {
            this.logger.warn(
              { err: error },
              "Failed to persist migrated central config (legacy nudgeSeconds)",
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to parse central mission control config");
    }
  }

  /** Resolved config: stored values over defaults, all keys present. */
  get(): ResolvedMissionControlCentralConfig {
    return resolveCentralConfig(this.config);
  }

  /** Shallow merge of the patch into stored config; persists; returns resolved. */
  async patch(patch: MissionControlCentralConfig): Promise<ResolvedMissionControlCentralConfig> {
    const next = { ...this.config };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      (next as Record<string, unknown>)[key] = value;
    }
    this.config = pickCentralConfigKeys(next);
    try {
      await writeJsonFileAtomic(join(this.dir, CENTRAL_CONFIG_FILENAME), this.config);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to persist central mission control config");
      throw error;
    }
    const resolved = this.get();
    this.logger.info(
      { component: "config", mode: resolved.mode, patchKeys: Object.keys(patch) },
      "mission_control.config.patched",
    );
    return resolved;
  }

  /** Convenience for the mode toggle: ask/auto. */
  async setMode(mode: MissionControlMode): Promise<ResolvedMissionControlCentralConfig> {
    return this.patch({ mode });
  }

  /**
   * Full snapshot replace (replica path): overwrite stored config + persist,
   * last-writer-wins. Used when this host receives a
   * mission_control.config.replica from the commander host — the receiver
   * never merges (the snapshot is authoritative) and never re-pushes (that
   * would loop). The in-memory store updates so every consumer (stall
   * detector, hindsight writer, verifier) sees the new fleet policy live.
   */
  async replace(
    snapshot: MissionControlCentralConfig,
  ): Promise<ResolvedMissionControlCentralConfig> {
    this.config = pickCentralConfigKeys(snapshot as Record<string, unknown>);
    try {
      await writeJsonFileAtomic(join(this.dir, CENTRAL_CONFIG_FILENAME), this.config);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to persist central mission control config replica");
      throw error;
    }
    const resolved = this.get();
    this.logger.info(
      { component: "config", from: "replica", keys: Object.keys(this.config) },
      "mission_control.config.replica_applied",
    );
    return resolved;
  }
}

const CENTRAL_CONFIG_KEYS: readonly (keyof ResolvedMissionControlCentralConfig)[] = [
  "commanderHost",
  "commanderModel",
  "commanderInstructions",
  "verifierModel",
  "verifierConcurrency",
  "evaluationScope",
  "mode",
  "retentionDays",
  "namingTheme",
  "hideAgentNames",
  "defaultDispatchHost",
  "silenceNudgeSeconds",
  "statusNudgeSeconds",
  "escalateSeconds",
  "stallDetectionEnabled",
  "dormantTurnSeconds",
  "commanderToWorkerMode",
  "verifierToWorkerMode",
  "hindsightUrl",
  "hindsightBank",
  "hindsightSecondaryBank",
  "voiceNodeUrl",
  "trackCommanderWorkers",
  "trackVerifiers",
  "trackSubagents",
];

function pickCentralConfigKeys(value: Record<string, unknown>): MissionControlCentralConfig {
  const picked: Record<string, unknown> = {};
  for (const key of CENTRAL_CONFIG_KEYS) {
    const raw = value[key];
    if (raw === undefined) {
      continue;
    }
    picked[key] = raw;
  }
  return picked as MissionControlCentralConfig;
}

type NullableStringKnobs = Pick<
  ResolvedMissionControlCentralConfig,
  | "commanderHost"
  | "commanderModel"
  | "verifierModel"
  | "defaultDispatchHost"
  | "hindsightUrl"
  | "hindsightSecondaryBank"
  | "voiceNodeUrl"
>;

/** The optional model overrides and host designations: string-or-null knobs. */
function resolveNullableStringKnobs(
  stored: MissionControlCentralConfig,
  defaults: ResolvedMissionControlCentralConfig,
): NullableStringKnobs {
  const commanderHost = stored.commanderHost ?? defaults.commanderHost;
  const commanderModel = stored.commanderModel ?? defaults.commanderModel;
  const verifierModel = stored.verifierModel ?? defaults.verifierModel;
  const defaultDispatchHost = stored.defaultDispatchHost ?? defaults.defaultDispatchHost;
  const hindsightUrl = stored.hindsightUrl ?? defaults.hindsightUrl;
  const hindsightSecondaryBank = stored.hindsightSecondaryBank ?? defaults.hindsightSecondaryBank;
  const voiceNodeUrl = stored.voiceNodeUrl ?? defaults.voiceNodeUrl;
  return {
    commanderHost,
    commanderModel,
    verifierModel,
    defaultDispatchHost,
    hindsightUrl,
    hindsightSecondaryBank,
    voiceNodeUrl,
  };
}

function resolveCentralConfig(
  stored: MissionControlCentralConfig,
): ResolvedMissionControlCentralConfig {
  const defaults = DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG;
  return {
    ...resolveNullableStringKnobs(stored, defaults),
    commanderInstructions: stored.commanderInstructions ?? defaults.commanderInstructions,
    verifierConcurrency: stored.verifierConcurrency ?? defaults.verifierConcurrency,
    evaluationScope: stored.evaluationScope ?? defaults.evaluationScope,
    mode: stored.mode ?? defaults.mode,
    retentionDays: stored.retentionDays ?? defaults.retentionDays,
    namingTheme: stored.namingTheme ?? defaults.namingTheme,
    hideAgentNames: stored.hideAgentNames ?? defaults.hideAgentNames,
    silenceNudgeSeconds: stored.silenceNudgeSeconds ?? defaults.silenceNudgeSeconds,
    // Legacy fallback: pre-rename files carry status cadence as nudgeSeconds.
    statusNudgeSeconds:
      stored.statusNudgeSeconds ?? stored.nudgeSeconds ?? defaults.statusNudgeSeconds,
    escalateSeconds: stored.escalateSeconds ?? defaults.escalateSeconds,
    stallDetectionEnabled: stored.stallDetectionEnabled ?? defaults.stallDetectionEnabled,
    dormantTurnSeconds: stored.dormantTurnSeconds ?? defaults.dormantTurnSeconds,
    commanderToWorkerMode: stored.commanderToWorkerMode ?? defaults.commanderToWorkerMode,
    verifierToWorkerMode: stored.verifierToWorkerMode ?? defaults.verifierToWorkerMode,
    hindsightBank: stored.hindsightBank ?? defaults.hindsightBank,
    trackCommanderWorkers: stored.trackCommanderWorkers ?? defaults.trackCommanderWorkers,
    trackVerifiers: stored.trackVerifiers ?? defaults.trackVerifiers,
    trackSubagents: stored.trackSubagents ?? defaults.trackSubagents,
  };
}
