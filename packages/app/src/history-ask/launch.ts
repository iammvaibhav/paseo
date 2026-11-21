import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { resolveEffectiveFormPreferences } from "@/create-agent-preferences/preferences";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import { buildHistorySearchRoots } from "./paths";
import { buildHistoryAskBrief } from "./brief";
import { loadHistoryAskHostPreferences, resolveHistoryAskHostSelection } from "./host-preferences";
import { historyAskLabels } from "./labels";
import type { HistoryAskScope } from "./scope";
import { resolveUnattendedModeId, type UnattendedModeCandidate } from "./unattended-mode";

const TITLE_QUESTION_MAX = 50;
const DEFAULT_PROVIDER: AgentProvider = "claude";

export interface LaunchHistoryAskInput {
  client: Pick<DaemonClient, "createAgent" | "createProjectForPrompt" | "getProvidersSnapshot">;
  scope: HistoryAskScope;
  question: string;
  /** UI selection; falls back to host prefs / create-agent preferences when omitted. */
  provider?: string | null;
  model?: string | null;
  /** Optional modes from host provider snapshot; used to pick unattended mode. */
  availableModes?: readonly UnattendedModeCandidate[] | null;
  /** Skip live snapshot fetch when modes already provided. */
  skipProviderSnapshot?: boolean;
}

export interface LaunchHistoryAskResult {
  agentId: string;
  serverId: string;
}

export function buildHistoryAskTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return "Ask: history";
  }
  if (cleaned.length <= TITLE_QUESTION_MAX) {
    return `Ask: ${cleaned}`;
  }
  return `Ask: ${cleaned.slice(0, TITLE_QUESTION_MAX - 1)}…`;
}

export async function launchHistoryAsk(
  input: LaunchHistoryAskInput,
): Promise<LaunchHistoryAskResult> {
  const question = input.question.trim();
  if (!question) {
    throw new Error("Question is required");
  }

  // The agent runs in the host's scratch (experiments) project, in its base
  // workspace, whatever the search scope: the brief carries the scope, and
  // Ask agents never pile up inside the projects they search.
  const scratch = await input.client.createProjectForPrompt({ prompt: question, scratch: true });
  const workspaceId = scratch.baseWorkspaceId;
  if (!workspaceId) {
    throw new Error("Update the host to run History Ask in its experiments project.");
  }
  const cwd = scratch.rootPath;

  const { provider, model } = await resolveLaunchProviderModel(input);
  const modeId = await resolveLaunchModeId(input, provider, cwd);

  const agent = await input.client.createAgent({
    config: {
      provider,
      cwd,
      ...(modeId ? { modeId } : {}),
      ...(model ? { model } : {}),
      title: buildHistoryAskTitle(question),
    },
    workspaceId,
    initialPrompt: buildHistoryAskBrief({
      scope: input.scope,
      question,
      roots: buildHistorySearchRoots(input.scope.cwds),
    }),
    labels: historyAskLabels({
      scope: input.scope.kind,
      projectId: input.scope.projectId,
      workspaceId: input.scope.workspaceId,
    }),
  });

  return {
    agentId: agent.id,
    serverId: input.scope.serverId,
  };
}

/** Explicit UI → History Ask per-host prefs → create-form prefs → default. */
async function resolveLaunchProviderModel(input: LaunchHistoryAskInput): Promise<{
  provider: AgentProvider;
  model: string | undefined;
}> {
  const hostPrefs = await loadHistoryAskHostPreferences();
  const hostSelection = resolveHistoryAskHostSelection(hostPrefs, input.scope.serverId);
  const preferences = await createAgentPreferencesService.load();
  const effective = resolveEffectiveFormPreferences(preferences, {
    workspaceId: input.scope.workspaceId ?? null,
    projectKey: input.scope.projectId ?? null,
  });

  const provider = (input.provider?.trim() ||
    hostSelection.provider?.trim() ||
    effective.provider?.trim() ||
    DEFAULT_PROVIDER) as AgentProvider;
  const providerPrefs = effective.providerPreferences?.[provider];
  const model =
    input.model?.trim() || hostSelection.model?.trim() || providerPrefs?.model?.trim() || undefined;
  return { provider, model };
}

async function resolveLaunchModeId(
  input: LaunchHistoryAskInput,
  provider: AgentProvider,
  cwd: string,
): Promise<string | undefined> {
  let availableModes = input.availableModes ?? null;
  if (!availableModes && !input.skipProviderSnapshot) {
    availableModes = await fetchModesForProvider(input.client, provider, cwd);
  }
  // May be undefined for providers with no modes (e.g. some ACP/Grok snapshots).
  return resolveUnattendedModeId(provider, availableModes);
}

async function fetchModesForProvider(
  client: Pick<DaemonClient, "getProvidersSnapshot">,
  provider: string,
  cwd: string,
): Promise<UnattendedModeCandidate[] | null> {
  try {
    const snapshot = await client.getProvidersSnapshot({ cwd });
    const entry = snapshot.entries.find((item) => item.provider === provider);
    if (!entry) {
      return null;
    }
    // Empty array is meaningful: provider reported no modes. Do not treat as "unknown".
    const modes = entry.modes ?? [];
    return modes.map((mode) => ({
      id: mode.id,
      // Wire AgentMode has no isUnattended; ACP allow-all is identified by id.
      isUnattended: mode.id === "paseo-allow-all" ? true : undefined,
    }));
  } catch {
    return null;
  }
}
