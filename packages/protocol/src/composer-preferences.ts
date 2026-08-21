import { z } from "zod";

// The composer's remembered provider/model selection, persisted per daemon as
// `daemon.composerPreferences` in config.json. Same shape as the app-side
// `formPreferencesSchema` (packages/app/src/create-agent-preferences/preferences.ts)
// so a daemon round-trips the exact blob the app writes. Every object is
// `.passthrough()` so fields added by newer clients survive a config write
// instead of being stripped by the protocol parse.
const ComposerProviderPreferencesSchema = z
  .object({
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingByModel: z.record(z.string(), z.string()).optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ComposerSelectionAskSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    thinkingOptionId: z.string().optional(),
  })
  .passthrough();

// Per-workspace / per-project scope: mirrors FormSelectionScope. The scope key
// is the workspaceId (byWorkspace) or projectKey (byProject) the app uses.
const ComposerSelectionScopeSchema = z
  .object({
    provider: z.string().optional(),
    providerPreferences: z.record(z.string(), ComposerProviderPreferencesSchema).optional(),
    isolation: z.enum(["local", "worktree"]).optional(),
    selectionAsk: ComposerSelectionAskSchema.optional(),
  })
  .passthrough();

const ComposerFavoriteModelSchema = z
  .object({
    provider: z.string(),
    modelId: z.string(),
  })
  .passthrough();

const ComposerLaunchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat") }),
  z.object({ kind: z.literal("terminal"), profileId: z.string() }),
]);

export const ComposerPreferencesSchema = z
  .object({
    provider: z.string().optional(),
    providerPreferences: z.record(z.string(), ComposerProviderPreferencesSchema).optional(),
    // COMPAT(agentProfileFavoriteMigration / globalFavoriteModels): legacy
    // favourites kept alive until every capable host has imported them; never
    // erased by ordinary preference writes.
    favoriteModels: z.array(ComposerFavoriteModelSchema).optional(),
    favoriteModelsByHost: z.record(z.string(), z.array(ComposerFavoriteModelSchema)).optional(),
    isolation: z.enum(["local", "worktree"]).optional(),
    byWorkspace: z.record(z.string(), ComposerSelectionScopeSchema).optional(),
    byProject: z.record(z.string(), ComposerSelectionScopeSchema).optional(),
    selectionAsk: ComposerSelectionAskSchema.optional(),
    launchTarget: ComposerLaunchTargetSchema.optional(),
  })
  .passthrough();

export type ComposerPreferences = z.infer<typeof ComposerPreferencesSchema>;
