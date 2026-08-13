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

const featureValuesSchema = z.record(z.string(), z.union([z.boolean(), z.string(), z.null()]));

export interface ProviderPreferences {
  model?: string;
  mode?: string;
  thinkingByModel?: Record<string, string>;
  featureValues?: Record<string, unknown>;
}

export type LaunchTarget = { kind: "chat" } | { kind: "terminal"; profileId: string };

export interface SelectionAskModelPreference {
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
}

export interface FormSelectionScope {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  isolation?: "local" | "worktree";
  selectionAsk?: SelectionAskModelPreference;
}

export interface FormPreferences {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  favoriteModels?: Array<{ provider: string; modelId: string }>;
  favoriteModelsByHost?: Record<string, Array<{ provider: string; modelId: string }>>;
  isolation?: "local" | "worktree";
  byWorkspace?: Record<string, FormSelectionScope>;
  byProject?: Record<string, FormSelectionScope>;
  selectionAsk?: SelectionAskModelPreference;
  launchTarget?: LaunchTarget;
}

const providerPreferencesSchema: z.ZodType<ProviderPreferences> = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingByModel: z.record(z.string(), z.string()).optional(),
  featureValues: featureValuesSchema.optional(),
});

const selectionAskSchema: z.ZodType<SelectionAskModelPreference> = z.strictObject({
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const selectionScopeSchema: z.ZodType<FormSelectionScope> = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  // Last isolation choice for this project (New workspace form). Global
  // `isolation` remains the cross-project fallback for older data / no scope.
  isolation: z.enum(["local", "worktree"]).optional(),
  // Model preference for the selection Ask popover. Lives under every
  // applicable scope (workspace, project, global) and resolves workspace >
  // project > global, matching composer persistence. The source agent's model
  // seeds the popover only when no scope has a remembered choice.
  selectionAsk: selectionAskSchema.optional(),
});

const favoriteModelSchema = z.strictObject({
  provider: z.string(),
  modelId: z.string(),
});

const launchTargetSchema: z.ZodType<LaunchTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("terminal"), profileId: z.string() }),
]);

export const FormPreferencesSchema = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  // COMPAT(agentProfileFavoriteMigration / globalFavoriteModels): favourites
  // were removed in v0.3.2 in favour of agent profiles. Keep the legacy payload
  // (and this fork's host-scoped list) alive until every capable host has had a
  // chance to import it; ordinary preference writes must not erase it first.
  favoriteModels: z.array(favoriteModelSchema).optional(),
  favoriteModelsByHost: z.record(z.string(), z.array(favoriteModelSchema)).optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  byWorkspace: z.record(z.string(), selectionScopeSchema).optional(),
  byProject: z.record(z.string(), selectionScopeSchema).optional(),
  // Global fallback for the selection Ask popover model; used when no
  // workspace or project scope has a remembered choice.
  selectionAsk: selectionAskSchema.optional(),
  // What the New workspace composer submits to: the chat agent (default) or a
  // terminal profile. See `@/new-workspace-launch` for resolution/fallback.
  launchTarget: launchTargetSchema.optional(),
}) satisfies z.ZodType<FormPreferences>;

const LegacyProviderPreferencesSchema = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const LegacyFormPreferencesSchema = z
  .strictObject({
    workingDir: z.string().optional(),
    provider: z.string().optional(),
    serverId: z.string().optional(),
    providerPreferences: z.record(z.string(), LegacyProviderPreferencesSchema).optional(),
  })
  .transform(({ provider, providerPreferences }): FormPreferences => {
    const migratedProviderPreferences: Record<string, ProviderPreferences> = {};
    for (const [providerId, legacy] of Object.entries(providerPreferences ?? {})) {
      const model = legacy.model;
      migratedProviderPreferences[providerId] = {
        ...(model !== undefined ? { model } : {}),
        ...(legacy.mode !== undefined ? { mode: legacy.mode } : {}),
        ...(model !== undefined && legacy.thinkingOptionId !== undefined
          ? { thinkingByModel: { [model]: legacy.thinkingOptionId } }
          : {}),
      };
    }
    return {
      ...(provider !== undefined ? { provider } : {}),
      ...(providerPreferences !== undefined
        ? { providerPreferences: migratedProviderPreferences }
        : {}),
    };
  });

export const StoredFormPreferencesSchema: z.ZodType<FormPreferences> = z.union([
  FormPreferencesSchema,
  LegacyFormPreferencesSchema,
]);

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = StoredFormPreferencesSchema.safeParse(value);
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
 * Order: workspace → project → global. Favorites stay global. Isolation is
 * project-scoped when a projectKey is known (so New workspace remembers the
 * last worktree/local choice per project), then falls back to global.
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
    isolation:
      workspaceSelection?.isolation ?? projectSelection?.isolation ?? preferences.isolation,
  };
}

/**
 * Persist isolation into the project scope (when known) and the global fallback.
 * Workspace-level isolation is not stored — New workspace creates the workspace.
 */
export function mergeIsolationPreference(args: {
  preferences: FormPreferences;
  isolation: "local" | "worktree";
  scope?: FormPreferenceScope | null;
}): FormPreferences {
  const { preferences, isolation, scope } = args;
  const { projectKey } = normalizeFormPreferenceScope(scope);
  let next: FormPreferences = {
    ...preferences,
    isolation,
  };
  if (projectKey) {
    const existing = next.byProject?.[projectKey];
    next = {
      ...next,
      byProject: {
        ...next.byProject,
        [projectKey]: {
          ...existing,
          isolation,
        },
      },
    };
  }
  return next;
}

function normalizeSelectionAskValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function applySelectionAskField(
  next: SelectionAskModelPreference,
  key: keyof SelectionAskModelPreference,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    // Key absent from the update — preserve the stored value.
    return;
  }
  const normalized = normalizeSelectionAskValue(value);
  if (normalized !== undefined) {
    next[key] = normalized;
  } else {
    // Key present but empty — clear the stored value.
    delete next[key];
  }
}

/**
 * Remember the selection Ask model choice across every applicable scope,
 * matching composer persistence: workspace (when known), project (when
 * known), and the global fallback. Absent fields are preserved from any
 * existing choice; a field passed as an empty string clears that stored field
 * in every scope it lands in.
 */
export function mergeSelectionAskPreference(args: {
  preferences: FormPreferences;
  selectionAsk: SelectionAskModelPreference;
  scope?: FormPreferenceScope | null;
}): FormPreferences {
  const { preferences, selectionAsk } = args;
  const { workspaceId, projectKey } = normalizeFormPreferenceScope(args.scope);

  const globalNext: SelectionAskModelPreference = { ...preferences.selectionAsk };
  applySelectionAskField(globalNext, "provider", selectionAsk.provider);
  applySelectionAskField(globalNext, "model", selectionAsk.model);
  applySelectionAskField(globalNext, "thinkingOptionId", selectionAsk.thinkingOptionId);

  let next: FormPreferences = {
    ...preferences,
    selectionAsk: globalNext,
  };

  if (projectKey) {
    const existing = next.byProject?.[projectKey];
    const projectNext: SelectionAskModelPreference = { ...existing?.selectionAsk };
    applySelectionAskField(projectNext, "provider", selectionAsk.provider);
    applySelectionAskField(projectNext, "model", selectionAsk.model);
    applySelectionAskField(projectNext, "thinkingOptionId", selectionAsk.thinkingOptionId);
    next = {
      ...next,
      byProject: {
        ...next.byProject,
        [projectKey]: {
          ...existing,
          selectionAsk: projectNext,
        },
      },
    };
  }

  if (workspaceId) {
    const existing = next.byWorkspace?.[workspaceId];
    const workspaceNext: SelectionAskModelPreference = { ...existing?.selectionAsk };
    applySelectionAskField(workspaceNext, "provider", selectionAsk.provider);
    applySelectionAskField(workspaceNext, "model", selectionAsk.model);
    applySelectionAskField(workspaceNext, "thinkingOptionId", selectionAsk.thinkingOptionId);
    next = {
      ...next,
      byWorkspace: {
        ...next.byWorkspace,
        [workspaceId]: {
          ...existing,
          selectionAsk: workspaceNext,
        },
      },
    };
  }

  return next;
}

/**
 * Resolve the remembered selection Ask model for a workspace/project. Order:
 * workspace → project → global (matches resolveEffectiveFormPreferences). The
 * global fallback is the last resort, so a user who never touched the popover
 * in a scope still gets a sensible model.
 */
export function resolveEffectiveSelectionAskPreference(
  preferences: FormPreferences,
  scope?: FormPreferenceScope | null,
): SelectionAskModelPreference {
  const { workspaceId, projectKey } = normalizeFormPreferenceScope(scope);
  const workspaceSelection = workspaceId ? preferences.byWorkspace?.[workspaceId] : undefined;
  const projectSelection = projectKey ? preferences.byProject?.[projectKey] : undefined;
  return (
    workspaceSelection?.selectionAsk ??
    projectSelection?.selectionAsk ??
    preferences.selectionAsk ??
    {}
  );
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
  const featureValues = featureValuesSchema.safeParse(args.featureValues);

  return mergeProviderPreferencesWithScope({
    preferences: args.preferences,
    provider: args.provider,
    updates: {
      model: modelId || undefined,
      mode: modeId || undefined,
      ...(modelId && thinkingOptionId ? { thinkingByModel: { [modelId]: thinkingOptionId } } : {}),
      ...(featureValues.success ? { featureValues: featureValues.data } : {}),
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
