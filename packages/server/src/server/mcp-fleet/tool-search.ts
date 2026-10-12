import { judgeChoices } from "../routing/llm-clients.js";
import { createVaultSecretResolver, type ResolveSecret } from "../secrets/vault-secret.js";
import { serializePaseoToolInputParameters } from "../agent/tools/paseo-tool-serialization.js";
import type { PaseoToolCatalog, PaseoToolDefinition } from "../agent/tools/types.js";
import type { MissionControlService } from "../mission-control/service.js";

export const CORE_FLEET_TOOL_NAMES = [
  "fleet_list_inventory",
  "fleet_list_agents",
  "fleet_agent_status",
  "fleet_get_agent_activity",
  "fleet_search",
  "fleet_list_models",
  "suggest_placement",
  "fleet_create_agent",
  "fleet_send_prompt",
] as const;

export const META_FLEET_TOOL_NAMES = [
  "paseo_tool_search",
  "paseo_tool_call",
  "paseo_skill",
] as const;

export const TOOL_GROUP_CRITERIA: Record<string, string> = {
  agents_read: "Read agents, status, activity, workspaces, or schedules",
  dispatch: "Create or start agents, send prompts, run workspace scripts, or manage schedules",
  control: "Cancel, kill, update, session mode, or permissions of agents",
  meta: "Move, rename, archive, adopt, promote projects, workspaces, or agents",
  history: "Search past conversations, memory, or historical activity",
  models: "Inspect providers, models, agent profiles, or placement routing",
  mission_control: "Mission control cards, user clarification, and worker verdicts",
  other: "Terminals, scripts, and any other utilities",
};

const META_TOOL_NAMES = new Set([
  "fleet_move_agent",
  "fleet_promote_workspace",
  "fleet_adopt_agent",
  "fleet_release_agent",
  "fleet_create_project",
  "rename_workspace",
  "archive_workspace",
  "archive_agent",
  "fleet_meta",
]);

const MISSION_CONTROL_TOOL_NAMES = new Set([
  "clarify",
  "post_answer",
  "tag_message",
  "report_status",
  "contact_worker",
  "submit_verdict",
]);

interface ToolClassificationRule {
  group: string;
  matches: (name: string) => boolean;
}

const CLASSIFICATION_RULES: ToolClassificationRule[] = [
  {
    group: "meta",
    matches: (name) =>
      name.startsWith("fleet_rename_") ||
      name.startsWith("fleet_archive_") ||
      META_TOOL_NAMES.has(name),
  },
  {
    group: "control",
    matches: (name) =>
      name.includes("cancel") ||
      name.includes("kill") ||
      name.includes("update_agent") ||
      name === "set_agent_mode" ||
      name.includes("permission"),
  },
  {
    group: "history",
    matches: (name) => name.includes("recall") || name.includes("history"),
  },
  {
    group: "models",
    matches: (name) =>
      name.includes("model") ||
      name.includes("provider") ||
      name.includes("profile") ||
      name.includes("placement"),
  },
  {
    group: "mission_control",
    matches: (name) => MISSION_CONTROL_TOOL_NAMES.has(name),
  },
  {
    group: "dispatch",
    matches: (name) =>
      name === "create_agent" ||
      name === "send_agent_prompt" ||
      name === "create_workspace" ||
      name.includes("script") ||
      name.includes("schedule") ||
      name.includes("heartbeat"),
  },
  {
    group: "agents_read",
    matches: (name) =>
      name.startsWith("list_") ||
      name.startsWith("get_") ||
      name.includes("status") ||
      name === "fleet_context" ||
      name === "fleet_monitor",
  },
];

export function classifyTool(name: string): string {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.matches(name)) {
      return rule.group;
    }
  }
  return "other";
}

export function computeLexicalScore(name: string, description: string, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();

  let score = 0;
  if (nameLower === normalizedQuery) {
    score += 100;
  } else if (nameLower.includes(normalizedQuery)) {
    score += 50;
  }

  if (descLower.includes(normalizedQuery)) {
    score += 25;
  }

  const queryTokens = normalizedQuery.split(/[\s_-]+/).filter((token) => token.length > 1);

  for (const token of queryTokens) {
    if (nameLower.includes(token)) {
      score += 10;
    }
    if (descLower.includes(token)) {
      score += 3;
    }
  }

  return score;
}

export async function resolveTypeSafeApiKey(options: {
  missionControlService?: Pick<MissionControlService, "getCentralConfig"> | null;
  resolveSecret?: ResolveSecret;
}): Promise<string | undefined> {
  const centralConfig = options.missionControlService?.getCentralConfig();
  const apiKeyRef = centralConfig?.routingSecrets?.typesafeApiKey;
  if (!apiKeyRef) {
    return undefined;
  }
  const resolveSecret = options.resolveSecret ?? createVaultSecretResolver();
  return resolveSecret(apiKeyRef);
}

export interface SearchCatalogToolsInput {
  catalog: PaseoToolCatalog;
  query: string;
  limit?: number;
  typesafeApiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SearchedToolItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function searchCatalogTools(
  input: SearchCatalogToolsInput,
): Promise<SearchedToolItem[]> {
  const limit = Math.max(1, input.limit ?? 12);
  const excluded = new Set<string>([...CORE_FLEET_TOOL_NAMES, ...META_FLEET_TOOL_NAMES]);
  const candidates: PaseoToolDefinition[] = [];

  for (const tool of input.catalog.tools.values()) {
    if (!excluded.has(tool.name)) {
      candidates.push(tool);
    }
  }

  let groupProbabilities: Record<string, number> | null = null;
  if (input.typesafeApiKey) {
    try {
      const timeoutSignal = AbortSignal.timeout(2000);
      const combinedSignal = input.signal
        ? AbortSignal.any([input.signal, timeoutSignal])
        : timeoutSignal;
      const answers = await judgeChoices({
        apiKey: input.typesafeApiKey,
        state: { query: input.query },
        questions: {
          tool_group: {
            type: "choice",
            instructions: "Which category best matches the user's tool search intent?",
            criteria: TOOL_GROUP_CRITERIA,
          },
        },
        signal: combinedSignal,
        fetchImpl: input.fetchImpl,
      });
      groupProbabilities = answers.tool_group?.probabilities ?? null;
    } catch {
      groupProbabilities = null;
    }
  }

  const scored = candidates.map((tool) => {
    const group = classifyTool(tool.name);
    const prob = groupProbabilities?.[group] ?? 0;
    const isQualified = prob >= 0.1;
    const lexical = computeLexicalScore(tool.name, tool.description, input.query);
    return {
      tool,
      group,
      prob,
      isQualified,
      lexical,
    };
  });

  const hasJevMatch = scored.some((item) => item.isQualified);

  scored.sort((a, b) => {
    if (hasJevMatch) {
      if (a.isQualified && !b.isQualified) return -1;
      if (!a.isQualified && b.isQualified) return 1;
      if (a.isQualified && b.isQualified && a.prob !== b.prob) {
        return b.prob - a.prob;
      }
    }
    if (a.lexical !== b.lexical) {
      return b.lexical - a.lexical;
    }
    return a.tool.name.localeCompare(b.tool.name);
  });

  return scored.slice(0, limit).map((item) => ({
    name: item.tool.name,
    description: item.tool.description,
    inputSchema: serializePaseoToolInputParameters(item.tool),
  }));
}
