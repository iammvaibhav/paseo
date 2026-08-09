import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";
import { useFetchQuery } from "@/data/query";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";

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
  dormantTurnSeconds: 300,
  commanderToWorkerMode: "interrupt",
  verifierToWorkerMode: "interrupt",
  hindsightUrl: null,
  hindsightBank: "paseo-fleet",
  hindsightSecondaryBank: "omp",
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
    ...resolveStallTimingKnobs(config),
    ...resolveMemoryKnobs(config),
  };
}

/** Fleet-policy reads/writes against the daemon serving the canonical config. */
export interface MissionControlCentralConfigState {
  /** Host that serves the config (saved commander host, else local, else first). */
  hostServerId: string | null;
  /** True until the saved commander-host preference has been resolved. */
  resolvingHost: boolean;
  config: ResolvedMissionControlCentralConfig | null;
  isLoading: boolean;
  patchConfig: (patch: Partial<MissionControlCentralConfig>) => Promise<void>;
  setMode: (mode: MissionControlMode) => Promise<void>;
}

/**
 * Thrown when a central-config write was forwarded to the designated
 * commander host but that host was unreachable. The daemon never applied the
 * write locally (it must not fork central config), so the app surfaces this
 * as a distinct "commander host unreachable" error (toast + inline) instead
 * of a generic failure — never silent.
 */
export class CommanderHostUnreachableError extends Error {
  readonly commanderHost: string;

  constructor(commanderHost: string, message: string) {
    super(message);
    this.name = "CommanderHostUnreachableError";
    this.commanderHost = commanderHost;
  }
}

/**
 * Resolves the host whose daemon this app talks to for the central Mission
 * Control config: the LOCAL daemon when connected, else the first known host.
 * No saved-commander-host preference is needed anymore — the daemons route
 * central-config writes themselves (the commander host owns central-config;
 * every other host forwards patches to it over peering and replicates the
 * result), so ANY connected host serves reads and accepts writes. The
 * fallbacks keep the settings screen usable before a commander host has ever
 * been picked (standalone mode: every host keeps its own config).
 */
export function useMissionControlCentralConfigHost(): {
  serverId: string | null;
  resolving: boolean;
} {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();

  return useMemo(() => {
    const known = (id: string | null): string | null =>
      id && hosts.some((host) => host.serverId === id) ? id : null;
    const serverId = known(localServerId) ?? hosts[0]?.serverId ?? null;
    return { serverId, resolving: false };
  }, [hosts, localServerId]);
}

export function useMissionControlCentralConfig(): MissionControlCentralConfigState {
  const { serverId, resolving } = useMissionControlCentralConfigHost();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const queryKey = useMemo(() => missionControlCentralConfigQueryKey(serverId), [serverId]);

  const configQuery = useFetchQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected && !resolving),
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      const result = await client.missionControlConfigGet();
      return result.config;
    },
  });

  const patchConfig = useCallback(
    async (patch: Partial<MissionControlCentralConfig>) => {
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      const result = await client.missionControlConfigPatch(patch);
      if (!result.ok) {
        if (result.unreachableCommanderHost) {
          throw new CommanderHostUnreachableError(
            result.unreachableCommanderHost,
            result.error ??
              `Commander host "${result.unreachableCommanderHost}" is unreachable; Mission Control settings were not saved.`,
          );
        }
        throw new Error(result.error ?? "Failed to update Mission Control config");
      }
      queryClient.setQueryData(queryKey, result.config);
    },
    [client, queryClient, queryKey, t],
  );

  const setMode = useCallback(
    async (mode: MissionControlMode) => {
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      const result = await client.missionControlModeSet(mode);
      if (!result.ok) {
        if (result.unreachableCommanderHost) {
          throw new CommanderHostUnreachableError(
            result.unreachableCommanderHost,
            result.error ??
              `Commander host "${result.unreachableCommanderHost}" is unreachable; the mode was not changed.`,
          );
        }
        throw new Error(result.error ?? "Failed to set Mission Control mode");
      }
      queryClient.setQueryData(queryKey, (current: MissionControlCentralConfig | undefined) =>
        current ? { ...current, mode } : current,
      );
    },
    [client, queryClient, queryKey, t],
  );

  return {
    hostServerId: serverId,
    resolvingHost: resolving,
    config: configQuery.data ? resolveMissionControlCentralConfig(configQuery.data) : null,
    isLoading: configQuery.isLoading,
    patchConfig,
    setMode,
  };
}

/** Ask/Auto mode for the Mission Control header toggle and the settings mirror. */
export function useMissionControlMode(): {
  mode: MissionControlMode | null;
  isLoading: boolean;
  isUpdating: boolean;
  setMode: (mode: MissionControlMode) => Promise<void>;
} {
  const [isUpdating, setIsUpdating] = useState(false);
  const toast = useToast();
  const { config, isLoading, setMode } = useMissionControlCentralConfig();

  const handleSetMode = useCallback(
    async (mode: MissionControlMode) => {
      setIsUpdating(true);
      try {
        await setMode(mode);
      } catch (caught) {
        // Never silent: a mode change that failed to reach the commander
        // host surfaces as a toast (the toggle itself has no error slot).
        const message = caught instanceof Error ? caught.message : String(caught);
        toast.error(message);
        throw caught;
      } finally {
        setIsUpdating(false);
      }
    },
    [setMode, toast],
  );

  return {
    mode: config?.mode ?? null,
    isLoading,
    isUpdating,
    setMode: handleSetMode,
  };
}
