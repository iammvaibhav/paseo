import { z } from "zod";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  isRefreshTokenExpressionConfigured,
  resolveRefreshTokenExpression,
} from "./oauth-credentials.js";
import type { PaseoAgentInferenceProvider, PaseoAgentModelReference } from "./pi-services.js";

export const PASEO_AGENT_PROVIDER = "paseo";

// Dedicated Paseo-owned config for the Paseo Agent provider. This is the single
// schema for `agents.paseo`; inference-provider fields are intentionally NOT
// merged into the shared strict ProviderOverrideSchema, and only this provider
// (via the helpers below) consumes it. This module imports no Pi runtime code so
// it stays cheap to load from persisted-config parsing.
//
// Inference providers are typed by `type`. Each known type carries sensible
// defaults (base URL, Pi wire `api`, and the env var its API key is read from),
// so a user only needs to give an `apiKey` (or the env var) and one or more model
// ids. `openai-compatible` covers any OpenAI Chat Completions endpoint (incl.
// OpenCode Zen/Go behind a custom base URL); `custom` is a thin escape hatch for
// directly choosing Pi's wire `api`.
//
// AUTH: API-key and env-var auth work for every type. ChatGPT/OpenAI subscription
// OAuth is supported via the `openai-codex` type. The product path is `paseo login
// chatgpt`, which runs Pi's browser PKCE/callback login by default and stores the
// credential in a Paseo-controlled file (see oauth-store.ts); the session loads it and
// Pi refreshes/persists rotation there. `options.refreshToken` is an advanced, manual
// escape hatch for users supplying their OWN token (literal/`$ENV`/`!cmd`) — it is not
// the normal path. Paseo never reads another tool's auth files. Other OAuth providers
// (e.g. Anthropic Pro/Max) remain unwired.

const PROVIDER_TYPES = [
  "openrouter",
  "openai",
  "anthropic",
  "opencode",
  "openai-compatible",
  "openai-codex",
  "custom",
] as const;

export type PaseoAgentProviderType = (typeof PROVIDER_TYPES)[number];

export interface PaseoAgentProviderTypeDefault {
  /** Pi wire protocol. `undefined` for `custom`, where the user must pick one. */
  api?: string;
  /** Default base URL. `undefined` means the user must supply `options.baseUrl`. */
  baseUrl?: string;
  /** Env var the API key is read from when `options.apiKey` is omitted. */
  envVar?: string;
}

// Defaults mirror Pi's built-in provider definitions (packages/ai models). Pi adds
// its own attribution headers for openrouter/opencode based on the base URL, so we
// deliberately do not inject provider headers here.
const PROVIDER_TYPE_DEFAULTS: Record<PaseoAgentProviderType, PaseoAgentProviderTypeDefault> = {
  openrouter: {
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
  },
  openai: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
  },
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
  },
  opencode: {
    // OpenCode Zen. Some Zen models speak anthropic-messages; override per model
    // with `api` when needed. Go models live behind a custom base URL via
    // `openai-compatible` (or set `options.baseUrl` to .../zen/go/v1 here).
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    envVar: "OPENCODE_API_KEY",
  },
  "openai-compatible": {
    api: "openai-completions",
    baseUrl: undefined,
    envVar: undefined,
  },
  "openai-codex": {
    // ChatGPT/OpenAI subscription via OAuth. Auth is a refresh token, not an API
    // key, so there is no default env var here.
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    envVar: undefined,
  },
  custom: {
    api: undefined,
    baseUrl: undefined,
    envVar: undefined,
  },
};

export function resolvePaseoAgentProviderTypeDefaults(
  type: PaseoAgentProviderType,
): PaseoAgentProviderTypeDefault {
  return PROVIDER_TYPE_DEFAULTS[type];
}

const PaseoAgentModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    // Override the provider's wire api for this model (e.g. an anthropic-messages
    // model served by an otherwise openai-completions provider like OpenCode Zen).
    api: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const PaseoAgentProviderOptionsSchema = z
  .object({
    // API key. Literal value, an env-var reference like `$OPENROUTER_API_KEY` /
    // `${OPENROUTER_API_KEY}`, or a `!command` (resolved by Pi at request time).
    // When omitted, known types fall back to their default env var.
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    // Override the wire api. Required for `custom`; optional elsewhere.
    api: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Advanced: send `Authorization: Bearer <apiKey>` as a header. Only needed for
    // endpoints whose wire api doesn't already attach the key.
    authHeader: z.boolean().optional(),
    // Advanced/manual ONLY: a self-supplied OAuth refresh token for `openai-codex`
    // (literal, `$ENV`/`${ENV}`, or `!command`). The normal path is the Paseo-owned
    // login (`paseo login chatgpt`), which stores the credential for you.
    refreshToken: z.string().min(1).optional(),
    models: z.array(PaseoAgentModelSchema).min(1),
  })
  .strict();

const PaseoAgentInferenceProviderSchema = z
  .object({
    type: z.enum(PROVIDER_TYPES),
    options: PaseoAgentProviderOptionsSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    const defaults = resolvePaseoAgentProviderTypeDefaults(entry.type);
    if (!defaults.baseUrl && !entry.options.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", "baseUrl"],
        message: `Inference provider type "${entry.type}" requires options.baseUrl.`,
      });
    }
    if (!defaults.api && !entry.options.api) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", "api"],
        message: `Inference provider type "${entry.type}" requires options.api.`,
      });
    }
    // `openai-codex` needs no credential field here: auth comes from the Paseo-owned
    // store populated by `paseo login chatgpt`. `options.refreshToken` is an
    // optional advanced override.
  });

export const PaseoAgentConfigSchema = z
  .object({
    // Optional default model as "<inferenceProviderName>/<modelId>".
    defaultModel: z.string().min(1).optional(),
    // Optional default agent definition from $PASEO_HOME/agents/<name>.md.
    defaultAgent: z.string().min(1).optional(),
    // Legacy alias for defaultAgent.
    defaultProfile: z.string().min(1).optional(),
    // Inference providers keyed by instance name. Multiple entries may share a
    // type while pointing at different APIs/base URLs/models.
    providers: z.record(z.string(), PaseoAgentInferenceProviderSchema).optional(),
  })
  .strict();

export type PaseoAgentConfig = z.infer<typeof PaseoAgentConfigSchema>;
type PaseoAgentInferenceProviderEntry = z.infer<typeof PaseoAgentInferenceProviderSchema>;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

interface ResolvedProviderSettings {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

function entries(config: PaseoAgentConfig): [string, PaseoAgentInferenceProviderEntry][] {
  return Object.entries(config.providers ?? {});
}

/** Apply per-type defaults to a raw inference provider entry. */
function resolveProviderSettings(
  entry: PaseoAgentInferenceProviderEntry,
): ResolvedProviderSettings {
  const defaults = resolvePaseoAgentProviderTypeDefaults(entry.type);
  const apiKey = entry.options.apiKey ?? (defaults.envVar ? `$${defaults.envVar}` : undefined);
  return {
    baseUrl: entry.options.baseUrl ?? defaults.baseUrl,
    api: entry.options.api ?? defaults.api,
    apiKey,
    headers: entry.options.headers,
    authHeader: entry.options.authHeader,
  };
}

const ENV_REFERENCE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/**
 * Whether a resolved API-key value is actually configured. Mirrors Pi's config-value
 * semantics without importing Pi: literals and `!command` values count as present;
 * `$ENV` / `${ENV}` references count only when every referenced var is set.
 */
function isAuthConfigured(value: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("!")) {
    return true;
  }
  const referencedVars = Array.from(value.matchAll(ENV_REFERENCE_PATTERN), (match) => match[1]);
  if (referencedVars.length === 0) {
    return true;
  }
  return referencedVars.every((name) => Boolean(env[name]));
}

/** Encode the Paseo-facing model id from an inference provider + Pi model id. */
export function encodePaseoAgentModelId(providerName: string, modelId: string): string {
  return `${providerName}/${modelId}`;
}

/** Parse a Paseo-facing model id back into its inference provider + Pi model id. */
export function parsePaseoAgentModelId(modelId: string): PaseoAgentModelReference | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    return null;
  }
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

function toPiModels(entry: PaseoAgentInferenceProviderEntry, settings: ResolvedProviderSettings) {
  return entry.options.models.map((model) => {
    const api = model.api ?? settings.api;
    return {
      id: model.id,
      name: model.label ?? model.id,
      ...(api ? { api } : {}),
      reasoning: model.reasoning ?? false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

/**
 * Map Paseo-owned config into the in-memory inference providers the Pi seam expects.
 * `openai-codex` entries carry an oauth marker instead of an API key. Their credential
 * normally lives in the Paseo-owned store (populated by `paseo login chatgpt`); an
 * advanced `options.refreshToken` may supply the user's own token instead.
 */
export function paseoAgentInferenceProviders(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): PaseoAgentInferenceProvider[] {
  return entries(config).flatMap(([name, entry]): PaseoAgentInferenceProvider[] => {
    const settings = resolveProviderSettings(entry);
    const models = toPiModels(entry, settings);

    if (entry.type === "openai-codex") {
      const refreshToken = entry.options.refreshToken
        ? resolveRefreshTokenExpression(entry.options.refreshToken, env)
        : undefined;
      return [
        {
          name,
          config: {
            ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
            ...(settings.api ? { api: settings.api } : {}),
            models,
          },
          oauth: { kind: "openai-codex" as const, ...(refreshToken ? { refreshToken } : {}) },
        },
      ];
    }

    return [
      {
        name,
        config: {
          ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
          ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
          ...(settings.api ? { api: settings.api } : {}),
          ...(settings.headers ? { headers: settings.headers } : {}),
          ...(settings.authHeader ? { authHeader: settings.authHeader } : {}),
          models,
        },
      },
    ];
  });
}

/** Enumerate configured models as Paseo model definitions (no Pi disk/auth reads). */
export function listPaseoAgentModels(config: PaseoAgentConfig): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  for (const [name, entry] of entries(config)) {
    for (const model of entry.options.models) {
      const id = encodePaseoAgentModelId(name, model.id);
      models.push({
        provider: PASEO_AGENT_PROVIDER,
        id,
        label: model.label ?? model.id,
        description: `${name} · ${model.id}`,
        isDefault: config.defaultModel === id,
      });
    }
  }
  return models;
}

/**
 * An inference provider is usable when it has at least one model and auth is configured.
 * For API-key types that means a resolvable key (literal, set env var, or command). For
 * `openai-codex`, auth comes from the Paseo-owned store (checked via `isOAuthAuthed`,
 * keyed by provider instance name) or, as an advanced override, a resolvable
 * `options.refreshToken`.
 */
export function paseoAgentHasUsableModel(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
  isOAuthAuthed: (providerInstance: string) => boolean = () => false,
): boolean {
  return entries(config).some(([name, entry]) => {
    if (entry.options.models.length === 0) {
      return false;
    }
    if (entry.type === "openai-codex") {
      if (
        entry.options.refreshToken &&
        isRefreshTokenExpressionConfigured(entry.options.refreshToken, env)
      ) {
        return true;
      }
      return isOAuthAuthed(name);
    }
    return isAuthConfigured(resolveProviderSettings(entry).apiKey, env);
  });
}

/**
 * Resolve which Pi model to launch: the explicit request is honored as-is; implicit
 * default selection only chooses models from the providers actually registered with Pi.
 */
export function resolvePaseoAgentModel(
  config: PaseoAgentConfig,
  requestedModelId: string | null | undefined,
  registeredProviders: PaseoAgentInferenceProvider[] = paseoAgentInferenceProviders(config),
  agentDefaultModelId?: string | null,
): PaseoAgentModelReference | undefined {
  if (requestedModelId) {
    return parsePaseoAgentModelId(requestedModelId) ?? undefined;
  }

  for (const candidate of [agentDefaultModelId, config.defaultModel, firstModelId(config)]) {
    if (!candidate) {
      continue;
    }
    const parsed = parsePaseoAgentModelId(candidate);
    if (parsed && hasRegisteredModel(registeredProviders, parsed)) {
      return parsed;
    }
  }

  return firstRegisteredModel(registeredProviders);
}

function firstModelId(config: PaseoAgentConfig): string | undefined {
  for (const [name, entry] of entries(config)) {
    const first = entry.options.models[0];
    if (first) {
      return encodePaseoAgentModelId(name, first.id);
    }
  }
  return undefined;
}

function hasRegisteredModel(
  providers: PaseoAgentInferenceProvider[],
  model: PaseoAgentModelReference,
): boolean {
  return providers.some(
    (provider) =>
      provider.name === model.provider &&
      provider.config.models?.some((registered) => registered.id === model.id),
  );
}

function firstRegisteredModel(
  providers: PaseoAgentInferenceProvider[],
): PaseoAgentModelReference | undefined {
  for (const provider of providers) {
    const first = provider.config.models?.[0];
    if (first) {
      return { provider: provider.name, id: first.id };
    }
  }
  return undefined;
}
