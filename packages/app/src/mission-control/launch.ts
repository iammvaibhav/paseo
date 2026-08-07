import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { resolveEffectiveFormPreferences } from "@/create-agent-preferences/preferences";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import {
  resolveUnattendedModeId,
  type UnattendedModeCandidate,
} from "@/history-ask/unattended-mode";
import { buildCommanderBrief } from "./brief";

export const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
export const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * The Commander is host-wide; `~` is the only cwd that always exists on every host.
 * The daemon expands `~` to its own home directory on the create_agent path
 * (session.ts handleCreateAgentRequest, same contract as the provider-snapshot
 * path and the MCP create path), so no app-side lookup of the host's home is needed.
 */
export const COMMANDER_CWD = "~";
export const COMMANDER_TITLE = "Commander";

const DEFAULT_PROVIDER: AgentProvider = "claude";

const COMMANDER_HOST_PREFERENCES_KEY = "@paseo:mission-control-commander-host";

export function commanderLabels(): Record<string, string> {
  return {
    [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
  };
}

export function isCommanderAgent(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE;
}

export interface LaunchCommanderInput {
  client: Pick<DaemonClient, "createAgent" | "getProvidersSnapshot">;
  /** The host the Commander runs on (screen setting, persisted in app storage). */
  serverId: string;
  /** Optional modes from the host provider snapshot; used to pick unattended mode. */
  availableModes?: readonly UnattendedModeCandidate[] | null;
  /** Skip live snapshot fetch when modes already provided. */
  skipProviderSnapshot?: boolean;
}

export interface LaunchCommanderResult {
  agentId: string;
  serverId: string;
}

export async function launchCommander(input: LaunchCommanderInput): Promise<LaunchCommanderResult> {
  const { provider, model } = await resolveCommanderProviderModel();
  const modeId = await resolveCommanderModeId(input, provider);

  const agent = await input.client.createAgent({
    config: {
      provider,
      cwd: COMMANDER_CWD,
      ...(modeId ? { modeId } : {}),
      ...(model ? { model } : {}),
      title: COMMANDER_TITLE,
    },
    initialPrompt: buildCommanderBrief(),
    labels: commanderLabels(),
  });

  return {
    agentId: agent.id,
    serverId: input.serverId,
  };
}

/** Orchestration preferences → default provider. No per-host override: the commander host picker is separate. */
async function resolveCommanderProviderModel(): Promise<{
  provider: AgentProvider;
  model: string | undefined;
}> {
  const preferences = await createAgentPreferencesService.load();
  const effective = resolveEffectiveFormPreferences(preferences, {
    workspaceId: null,
    projectKey: null,
  });
  const provider = (effective.provider?.trim() || DEFAULT_PROVIDER) as AgentProvider;
  const providerPrefs = effective.providerPreferences?.[provider];
  const model = providerPrefs?.model?.trim() || undefined;
  return { provider, model };
}

async function resolveCommanderModeId(
  input: LaunchCommanderInput,
  provider: AgentProvider,
): Promise<string | undefined> {
  let availableModes = input.availableModes ?? null;
  if (!availableModes && !input.skipProviderSnapshot) {
    availableModes = await fetchModesForProvider(input.client, provider);
  }
  return resolveUnattendedModeId(provider, availableModes);
}

async function fetchModesForProvider(
  client: Pick<DaemonClient, "getProvidersSnapshot">,
  provider: string,
): Promise<UnattendedModeCandidate[] | null> {
  try {
    const snapshot = await client.getProvidersSnapshot({ cwd: COMMANDER_CWD });
    const entry = snapshot.entries.find((item) => item.provider === provider);
    if (!entry) {
      return null;
    }
    const modes = entry.modes ?? [];
    return modes.map((mode) => ({
      id: mode.id,
      isUnattended: mode.id === "paseo-allow-all" ? true : undefined,
    }));
  } catch {
    return null;
  }
}

export async function loadCommanderHostServerId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(COMMANDER_HOST_PREFERENCES_KEY);
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

export async function saveCommanderHostServerId(serverId: string): Promise<void> {
  const trimmed = serverId.trim();
  if (!trimmed) {
    return;
  }
  await AsyncStorage.setItem(COMMANDER_HOST_PREFERENCES_KEY, trimmed);
}
