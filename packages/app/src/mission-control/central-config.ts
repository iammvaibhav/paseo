import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";
import { useFetchQuery } from "@/data/query";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { loadCommanderHostServerId } from "@/mission-control/launch";
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
};

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
    silenceNudgeSeconds: config.silenceNudgeSeconds ?? 120,
    statusNudgeSeconds: config.statusNudgeSeconds ?? config.nudgeSeconds ?? 300,
    escalateSeconds: config.escalateSeconds ?? 300,
    dormantTurnSeconds: config.dormantTurnSeconds ?? 300,
    commanderToWorkerMode: config.commanderToWorkerMode ?? "interrupt",
    verifierToWorkerMode: config.verifierToWorkerMode ?? "interrupt",
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
 * Resolves the host whose daemon holds the canonical central Mission Control
 * config: the saved commander-host preference first, then the local daemon,
 * then the first known host. The config is stored on the commander host, so
 * reads/writes must target it; the fallbacks keep the settings screen usable
 * before a commander host has ever been picked.
 */
export function useMissionControlCentralConfigHost(): {
  serverId: string | null;
  resolving: boolean;
} {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const [savedServerId, setSavedServerId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void loadCommanderHostServerId().then((id) => {
      if (!cancelled) {
        setSavedServerId(id);
      }
      return id;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    if (savedServerId === undefined) {
      return { serverId: null, resolving: true };
    }
    const known = (id: string | null): string | null =>
      id && hosts.some((host) => host.serverId === id) ? id : null;
    const serverId = known(savedServerId) ?? known(localServerId) ?? hosts[0]?.serverId ?? null;
    return { serverId, resolving: false };
  }, [hosts, localServerId, savedServerId]);
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
  const { config, isLoading, setMode } = useMissionControlCentralConfig();

  const handleSetMode = useCallback(
    async (mode: MissionControlMode) => {
      setIsUpdating(true);
      try {
        await setMode(mode);
      } finally {
        setIsUpdating(false);
      }
    },
    [setMode],
  );

  return {
    mode: config?.mode ?? null,
    isLoading,
    isUpdating,
    setMode: handleSetMode,
  };
}
