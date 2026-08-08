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
  nudgeSeconds: number;
  escalateSeconds: number;
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
  nudgeSeconds: 120,
  escalateSeconds: 300,
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

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.dir = join(options.paseoHome, CENTRAL_CONFIG_DIR);
    this.logger = options.logger.child({ module: "mission-control", component: "config" });
  }

  async initialize(): Promise<void> {
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
  "nudgeSeconds",
  "escalateSeconds",
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

function resolveCentralConfig(
  stored: MissionControlCentralConfig,
): ResolvedMissionControlCentralConfig {
  const defaults = DEFAULT_CENTRAL_MISSION_CONTROL_CONFIG;
  return {
    commanderHost: stored.commanderHost ?? defaults.commanderHost,
    commanderModel: stored.commanderModel ?? defaults.commanderModel,
    commanderInstructions: stored.commanderInstructions ?? defaults.commanderInstructions,
    verifierModel: stored.verifierModel ?? defaults.verifierModel,
    verifierConcurrency: stored.verifierConcurrency ?? defaults.verifierConcurrency,
    evaluationScope: stored.evaluationScope ?? defaults.evaluationScope,
    mode: stored.mode ?? defaults.mode,
    retentionDays: stored.retentionDays ?? defaults.retentionDays,
    namingTheme: stored.namingTheme ?? defaults.namingTheme,
    hideAgentNames: stored.hideAgentNames ?? defaults.hideAgentNames,
    defaultDispatchHost: stored.defaultDispatchHost ?? defaults.defaultDispatchHost,
    nudgeSeconds: stored.nudgeSeconds ?? defaults.nudgeSeconds,
    escalateSeconds: stored.escalateSeconds ?? defaults.escalateSeconds,
  };
}
