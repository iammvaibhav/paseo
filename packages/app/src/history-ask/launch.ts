import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { resolveEffectiveFormPreferences } from "@/create-agent-preferences/preferences";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import { buildHistorySearchRoots } from "./paths";
import { buildHistoryAskBrief } from "./brief";
import { historyAskLabels } from "./labels";
import type { HistoryAskScope } from "./scope";
import { resolveUnattendedModeId, type UnattendedModeCandidate } from "./unattended-mode";

const TITLE_QUESTION_MAX = 50;
const DEFAULT_PROVIDER: AgentProvider = "claude";

export interface LaunchHistoryAskInput {
  client: Pick<DaemonClient, "createAgent" | "getProvidersSnapshot">;
  scope: HistoryAskScope;
  question: string;
  /** Override primary cwd when scope.cwds is empty (host-wide). */
  primaryCwd?: string | null;
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

  const primaryCwd = resolvePrimaryCwd(input.scope, input.primaryCwd);
  if (!primaryCwd) {
    throw new Error("History Ask needs a working directory to launch an agent");
  }

  const preferences = await createAgentPreferencesService.load();
  const effective = resolveEffectiveFormPreferences(preferences, {
    workspaceId: input.scope.workspaceId ?? null,
    projectKey: input.scope.projectId ?? null,
  });

  const provider = (effective.provider?.trim() || DEFAULT_PROVIDER) as AgentProvider;
  const providerPrefs = effective.providerPreferences?.[provider];
  const model = providerPrefs?.model?.trim() || undefined;

  let availableModes = input.availableModes ?? null;
  if (!availableModes && !input.skipProviderSnapshot) {
    availableModes = await fetchModesForProvider(input.client, provider, primaryCwd);
  }

  const modeId = resolveUnattendedModeId(provider, availableModes);
  if (!modeId) {
    throw new Error(`No unattended mode available for provider ${provider}`);
  }

  const roots = buildHistorySearchRoots(input.scope.cwds);
  const brief = buildHistoryAskBrief({
    scope: input.scope,
    question,
    roots,
  });

  const labels = historyAskLabels({
    scope: input.scope.kind,
    projectId: input.scope.projectId,
    workspaceId: input.scope.workspaceId,
  });

  const title = buildHistoryAskTitle(question);

  const agent = await input.client.createAgent({
    config: {
      provider,
      cwd: primaryCwd,
      modeId,
      ...(model ? { model } : {}),
      title,
    },
    ...(input.scope.kind === "workspace" && input.scope.workspaceId
      ? { workspaceId: input.scope.workspaceId }
      : {}),
    initialPrompt: brief,
    labels,
  });

  return {
    agentId: agent.id,
    serverId: input.scope.serverId,
  };
}

function resolvePrimaryCwd(scope: HistoryAskScope, override?: string | null): string | null {
  const fromOverride = override?.trim();
  if (fromOverride) {
    return fromOverride;
  }
  const first = scope.cwds.find((cwd) => cwd.trim().length > 0)?.trim();
  return first ?? null;
}

async function fetchModesForProvider(
  client: Pick<DaemonClient, "getProvidersSnapshot">,
  provider: string,
  cwd: string,
): Promise<UnattendedModeCandidate[] | null> {
  try {
    const snapshot = await client.getProvidersSnapshot({ cwd });
    const entry = snapshot.entries.find((item) => item.provider === provider);
    if (!entry?.modes) {
      return null;
    }
    return entry.modes.map((mode) => ({
      id: mode.id,
      // Wire AgentMode has no isUnattended; ACP allow-all is identified by id.
      isUnattended: mode.id === "paseo-allow-all" ? true : undefined,
    }));
  } catch {
    return null;
  }
}
