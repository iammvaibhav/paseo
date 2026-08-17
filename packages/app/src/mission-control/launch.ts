import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { resolveEffectiveFormPreferences } from "@/create-agent-preferences/preferences";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import {
  resolveUnattendedModeId,
  type UnattendedModeCandidate,
} from "@/history-ask/unattended-mode";
import { commanderLabels } from "./labels";

/**
 * The Commander is host-wide; `~` is the only cwd that always exists on every
 * host. The daemon expands `~` to its own home directory on the create_agent
 * path (session.ts handleCreateAgentRequest, same contract as the
 * provider-snapshot path and the MCP create path), so no app-side lookup of
 * the host's home is needed.
 *
 * M2 reserved-home contract: the app sends the "~" sentinel and the DAEMON
 * redirects commander-labeled creates (`paseo.mission-control=commander`) to
 * the reserved home (`<paseoHome>/commander` — commander-boot's
 * commanderHomeCwd) instead of the legacy home-rooted workspace. The app
 * cannot compute that path itself (no RPC exposes the daemon's paseoHome), so
 * this sentinel is the app half of the contract; the redirect lives in the
 * server create path. Never hardcode `~/.paseo/commander` here — the dev
 * daemon's PASEO_HOME differs and must never write into `~/.paseo`.
 */
export const COMMANDER_CWD = "~";
export const COMMANDER_TITLE = "Commander";

const DEFAULT_PROVIDER: AgentProvider = "claude";

const COMMANDER_HOST_PREFERENCES_KEY = "@paseo:mission-control-commander-host";
const COMMANDER_MODEL_PREFERENCES_KEY = "@paseo:mission-control-commander-model";

/**
 * The Commander's hard tool restriction (spec: Commander contract, user
 * decision "fleet-wide only"). Only Paseo FLEET tools; no host-specific
 * tools, no bash, no file editing, no task subagents. The daemon filters the
 * injected Paseo host-tool catalog to these names and the omp provider
 * launches with builtin tools disabled. Mirrors the daemon-side
 * COMMANDER_TOOL_ALLOWLIST (commander-contract.ts) — keep in sync.
 */
export const COMMANDER_TOOL_ALLOWLIST = [
  "fleet_list_agents",
  "fleet_list_models",
  "fleet_create_agent",
  "fleet_send_prompt",
  "fleet_get_agent_activity",
  "fleet_search",
  "tag_message",
  "clarify",
  "post_answer",
  // 04 meta split: the flat per-action tools replace fleet_meta.
  "fleet_rename_project",
  "fleet_rename_workspace",
  "fleet_rename_agent_title",
  "fleet_archive_project",
  "fleet_archive_workspace",
  "fleet_archive_agent",
  "fleet_create_project",
  "fleet_move_agent",
  "fleet_promote_workspace",
  "fleet_adopt_agent",
  "fleet_release_agent",
  "fleet_recall",
  "fleet_context",
] as const;

interface CommanderModelMemory {
  provider: AgentProvider;
  model: string;
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
  const { provider, model } = await resolveCommanderProviderModel(input.serverId);
  const modeId = await resolveCommanderModeId(input, provider);

  const agent = await input.client.createAgent({
    config: {
      provider,
      cwd: COMMANDER_CWD,
      ...(modeId ? { modeId } : {}),
      ...(model ? { model } : {}),
      title: COMMANDER_TITLE,
      // The daemon builds a static system prompt at create time (bundled
      // commander-prompt.md + central commanderInstructions) and injects the
      // fleet context pack as the first conversation message. No brief is sent
      // from here.
      systemPromptMode: "replace",
      toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST],
    },
    labels: commanderLabels(),
  });

  return {
    agentId: agent.id,
    serverId: input.serverId,
  };
}

/** Last model the user picked for the Commander on this host, else orchestration preferences. */
async function resolveCommanderProviderModel(serverId: string): Promise<{
  provider: AgentProvider;
  model: string | undefined;
}> {
  const remembered = await loadCommanderModel(serverId);
  if (remembered) {
    return { provider: remembered.provider, model: remembered.model };
  }
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

/**
 * Per-host "last commander model" memory: the model the user last picked for
 * the Commander via the normal agent picker. The screen's model picker saves
 * here; launch prefers it over orchestration preferences.
 */
export async function saveCommanderModel(
  serverId: string,
  memory: CommanderModelMemory,
): Promise<void> {
  const trimmedServerId = serverId.trim();
  if (!trimmedServerId || !memory.model.trim()) {
    return;
  }
  const current = await loadCommanderModels();
  await AsyncStorage.setItem(
    COMMANDER_MODEL_PREFERENCES_KEY,
    JSON.stringify({ ...current, [trimmedServerId]: memory }),
  );
}

export async function loadCommanderModel(serverId: string): Promise<CommanderModelMemory | null> {
  const models = await loadCommanderModels();
  const memory = models[serverId];
  if (!memory || typeof memory.provider !== "string" || typeof memory.model !== "string") {
    return null;
  }
  return memory;
}

async function loadCommanderModels(): Promise<Record<string, CommanderModelMemory>> {
  try {
    const raw = await AsyncStorage.getItem(COMMANDER_MODEL_PREFERENCES_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, CommanderModelMemory>;
  } catch {
    return {};
  }
}
