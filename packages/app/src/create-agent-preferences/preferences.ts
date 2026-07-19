import { z } from "zod";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

export interface FavoriteModelPreference {
  provider: string;
  modelId: string;
}

export interface FavoriteModelRow {
  favoriteKey: string;
  provider: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description?: string;
}

/**
 * Where create-agent selection (provider/model/mode/thinking) is remembered.
 * Workspace wins over project; project seeds new workspaces; global is the
 * last-resort fallback (and still used by schedules/webhooks).
 */
export interface FormPreferenceScope {
  workspaceId?: string | null;
  projectKey?: string | null;
}

const providerPreferencesSchema = z.object({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingByModel: z.record(z.string(), z.string()).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});

const selectionScopeSchema = z.object({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
});

const favoriteModelSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
});

const formPreferencesSchema = z.object({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  // COMPAT(globalFavoriteModels): pre-host-scoped favorites. Used as a fallback
  // until a host has its own list written under favoriteModelsByHost.
  favoriteModels: z.array(favoriteModelSchema).optional(),
  favoriteModelsByHost: z.record(z.string(), z.array(favoriteModelSchema)).optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  byWorkspace: z.record(z.string(), selectionScopeSchema).optional(),
  byProject: z.record(z.string(), selectionScopeSchema).optional(),
});

export type ProviderPreferences = z.infer<typeof providerPreferencesSchema>;
export type FormSelectionScope = z.infer<typeof selectionScopeSchema>;
export type FormPreferences = z.infer<typeof formPreferencesSchema>;

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = formPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_FORM_PREFERENCES;
}

function normalizeScopeKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeFormPreferenceScope(scope: FormPreferenceScope | null | undefined): {
  workspaceId: string | null;
  projectKey: string | null;
} {
  return {
    workspaceId: normalizeScopeKey(scope?.workspaceId),
    projectKey: normalizeScopeKey(scope?.projectKey),
  };
}

function mergeDefinedRecord<T>(
  existing: Record<string, T> | undefined,
  updates: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (updates === undefined) {
    return existing;
  }
  return {
    ...existing,
    ...updates,
  };
}

function applyProviderPreferenceUpdates(
  existing: ProviderPreferences,
  updates: Partial<ProviderPreferences>,
): ProviderPreferences {
  const next: ProviderPreferences = { ...existing };
  const nextThinkingByModel = mergeDefinedRecord(existing.thinkingByModel, updates.thinkingByModel);
  const nextFeatureValues = mergeDefinedRecord(existing.featureValues, updates.featureValues);

  if (updates.model !== undefined) {
    next.model = updates.model;
  }
  if (updates.mode !== undefined) {
    next.mode = updates.mode;
  }
  if (nextThinkingByModel !== undefined) {
    next.thinkingByModel = nextThinkingByModel;
  }
  if (nextFeatureValues !== undefined) {
    next.featureValues = nextFeatureValues;
  }

  return next;
}

function mergeProviderPreferencesIntoSelection(args: {
  selection: FormSelectionScope | undefined;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
}): FormSelectionScope {
  const existingProviderPreferences = args.selection?.providerPreferences ?? {};
  const existing = existingProviderPreferences[args.provider] ?? {};

  return {
    provider: args.provider,
    providerPreferences: {
      ...existingProviderPreferences,
      [args.provider]: applyProviderPreferenceUpdates(existing, args.updates),
    },
  };
}

export function mergeProviderPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
}): FormPreferences {
  const selection = mergeProviderPreferencesIntoSelection({
    selection: {
      provider: args.preferences.provider,
      providerPreferences: args.preferences.providerPreferences,
    },
    provider: args.provider,
    updates: args.updates,
  });

  return {
    ...args.preferences,
    provider: selection.provider,
    providerPreferences: selection.providerPreferences,
  };
}

/**
 * Resolve the effective create-form selection for a workspace/project.
 * Order: workspace → project → global. Favorites and isolation stay global.
 */
export function resolveEffectiveFormPreferences(
  preferences: FormPreferences,
  scope?: FormPreferenceScope | null,
): FormPreferences {
  const { workspaceId, projectKey } = normalizeFormPreferenceScope(scope);
  const workspaceSelection = workspaceId ? preferences.byWorkspace?.[workspaceId] : undefined;
  const projectSelection = projectKey ? preferences.byProject?.[projectKey] : undefined;

  if (!workspaceSelection && !projectSelection) {
    return preferences;
  }

  return {
    ...preferences,
    provider: workspaceSelection?.provider ?? projectSelection?.provider ?? preferences.provider,
    providerPreferences: {
      ...preferences.providerPreferences,
      ...projectSelection?.providerPreferences,
      ...workspaceSelection?.providerPreferences,
    },
  };
}

/**
 * Persist a provider/model selection into every applicable scope:
 * workspace (when known), project (when known), and global fallback.
 */
export function mergeProviderPreferencesWithScope(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
  scope?: FormPreferenceScope | null;
}): FormPreferences {
  const { preferences, provider, updates, scope } = args;
  const { workspaceId, projectKey } = normalizeFormPreferenceScope(scope);

  let next = mergeProviderPreferences({ preferences, provider, updates });

  if (projectKey) {
    const existing = next.byProject?.[projectKey];
    next = {
      ...next,
      byProject: {
        ...next.byProject,
        [projectKey]: mergeProviderPreferencesIntoSelection({
          selection: existing,
          provider,
          updates,
        }),
      },
    };
  }

  if (workspaceId) {
    const existing = next.byWorkspace?.[workspaceId];
    next = {
      ...next,
      byWorkspace: {
        ...next.byWorkspace,
        [workspaceId]: mergeProviderPreferencesIntoSelection({
          selection: existing,
          provider,
          updates,
        }),
      },
    };
  }

  return next;
}

export function mergeCreateAgentSelectionPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider | null;
  modelId?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
  scope?: FormPreferenceScope | null;
}): FormPreferences {
  if (!args.provider) {
    return args.preferences;
  }

  const modelId = args.modelId?.trim() ?? "";
  const modeId = args.modeId?.trim() ?? "";
  const thinkingOptionId = args.thinkingOptionId?.trim() ?? "";

  return mergeProviderPreferencesWithScope({
    preferences: args.preferences,
    provider: args.provider,
    updates: {
      model: modelId || undefined,
      mode: modeId || undefined,
      ...(modelId && thinkingOptionId ? { thinkingByModel: { [modelId]: thinkingOptionId } } : {}),
      ...(args.featureValues ? { featureValues: args.featureValues } : {}),
    },
    scope: args.scope,
  });
}

export function buildFavoriteModelKey(input: FavoriteModelPreference): string {
  return `${input.provider}:${input.modelId}`;
}

/**
 * Favorites are host-scoped (keyed by daemon serverId). If a host has never
 * been customized, fall back to the legacy global list so existing stars still
 * show until the user toggles on that host.
 */
export function resolveFavoriteModels(
  preferences: FormPreferences,
  serverId?: string | null,
): FavoriteModelPreference[] {
  const hostId = normalizeScopeKey(serverId);
  if (hostId && preferences.favoriteModelsByHost && hostId in preferences.favoriteModelsByHost) {
    return preferences.favoriteModelsByHost[hostId] ?? [];
  }
  return preferences.favoriteModels ?? [];
}

export function isFavoriteModel(args: {
  preferences: FormPreferences;
  provider: string;
  modelId: string;
  serverId?: string | null;
}): boolean {
  const favoriteKey = buildFavoriteModelKey({ provider: args.provider, modelId: args.modelId });
  return resolveFavoriteModels(args.preferences, args.serverId).some(
    (favorite) => buildFavoriteModelKey(favorite) === favoriteKey,
  );
}

export function toggleFavoriteModel(args: {
  preferences: FormPreferences;
  provider: string;
  modelId: string;
  /** Host (daemon serverId) that owns this favorite list. */
  serverId?: string | null;
}): FormPreferences {
  const favorite = { provider: args.provider, modelId: args.modelId };
  const favoriteKey = buildFavoriteModelKey(favorite);
  const hostId = normalizeScopeKey(args.serverId);
  const existingFavorites = resolveFavoriteModels(args.preferences, hostId);
  const hasFavorite = existingFavorites.some(
    (entry) => buildFavoriteModelKey(entry) === favoriteKey,
  );
  const nextFavorites = hasFavorite
    ? existingFavorites.filter((entry) => buildFavoriteModelKey(entry) !== favoriteKey)
    : [...existingFavorites, favorite];

  // No host context: keep writing the legacy global list.
  if (!hostId) {
    return {
      ...args.preferences,
      favoriteModels: nextFavorites,
    };
  }

  return {
    ...args.preferences,
    favoriteModelsByHost: {
      ...args.preferences.favoriteModelsByHost,
      [hostId]: nextFavorites,
    },
  };
}
