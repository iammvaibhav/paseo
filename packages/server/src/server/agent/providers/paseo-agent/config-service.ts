import type { Logger } from "pino";
import type {
  PaseoAgentOAuthCredential,
  PaseoAgentProviderAuthState,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";

import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "../../../persisted-config.js";
import {
  PaseoAgentConfigSchema,
  type PaseoAgentConfig,
  type PaseoAgentProviderType,
  resolvePaseoAgentProviderTypeDefaults,
} from "./config.js";
import { hasStoredOAuthCredential, storeCodexOAuthCredential } from "./oauth-store.js";
import { isRefreshTokenExpressionConfigured } from "./oauth-credentials.js";
import { findEnvReferences } from "./env-references.js";

interface PaseoAgentConfigServiceOptions {
  paseoHome: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  onConfigChanged?: (config: PaseoAgentConfig | undefined) => void;
}

interface SetProviderInput {
  name: string;
  providerType: PaseoAgentProviderType;
  options: {
    apiKey?: string;
    baseUrl?: string;
    api?: string;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models: Array<{
      id: string;
      label?: string;
      api?: string;
      reasoning?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
}

function resolveEnv(paseoHome: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? { ...process.env, PASEO_HOME: paseoHome };
}

function authStateForApiKey(
  value: string | undefined,
  fallbackEnvVar: string | undefined,
  env: NodeJS.ProcessEnv,
): PaseoAgentProviderAuthState {
  if (!value && fallbackEnvVar) {
    return {
      kind: "api_key",
      configured: Boolean(env[fallbackEnvVar]),
      source: "default_env",
      hint: fallbackEnvVar,
    };
  }
  if (!value) {
    return { kind: "none", configured: false };
  }
  if (value.startsWith("!")) {
    return { kind: "api_key", configured: true, source: "command" };
  }
  const referencedVars = findEnvReferences(value);
  if (referencedVars.length > 0) {
    return {
      kind: "api_key",
      configured: referencedVars.every((name) => Boolean(env[name])),
      source: "env",
      hint: referencedVars.join(","),
    };
  }
  return { kind: "api_key", configured: true, source: "literal" };
}

function readPaseoAgentConfig(persisted: PersistedConfig): PaseoAgentConfig {
  return PaseoAgentConfigSchema.parse(persisted.agents?.paseo ?? {});
}

function redactedProviders(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv,
): RedactedPaseoAgentProviderConfig[] {
  return Object.entries(config.providers ?? {}).map(([name, entry]) => {
    const defaults = resolvePaseoAgentProviderTypeDefaults(entry.type);
    let auth: PaseoAgentProviderAuthState;
    if (entry.type === "openai-codex") {
      const hasRefreshToken =
        entry.options.refreshToken &&
        isRefreshTokenExpressionConfigured(entry.options.refreshToken, env);
      if (hasRefreshToken) {
        auth = { kind: "oauth", configured: true, source: "refresh_token" };
      } else {
        const stored = hasStoredOAuthCredential(name, env);
        auth = stored
          ? { kind: "oauth", configured: true, source: "stored" }
          : { kind: "oauth", configured: false };
      }
    } else {
      auth = authStateForApiKey(entry.options.apiKey, defaults.envVar, env);
    }
    const provider: RedactedPaseoAgentProviderConfig = {
      name,
      providerType: entry.type,
      models: entry.options.models.map((model) => ({ ...model })),
      auth,
      available: auth.configured && entry.options.models.length > 0,
      error: null,
    };
    const baseUrl = entry.options.baseUrl ?? defaults.baseUrl;
    if (baseUrl) {
      provider.baseUrl = baseUrl;
    }
    const api = entry.options.api ?? defaults.api;
    if (api) {
      provider.api = api;
    }
    return provider;
  });
}

function mergePaseoAgentConfig(
  persisted: PersistedConfig,
  paseoConfig: PaseoAgentConfig | undefined,
): PersistedConfig {
  return {
    ...persisted,
    agents: {
      ...persisted.agents,
      paseo: paseoConfig,
    },
  };
}

export class PaseoAgentConfigService {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onConfigChanged: ((config: PaseoAgentConfig | undefined) => void) | undefined;

  constructor(options: PaseoAgentConfigServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "paseo-agent-config-service" });
    this.env = resolveEnv(options.paseoHome, options.env);
    this.onConfigChanged = options.onConfigChanged;
  }

  getProviders(): { defaultModel: string | null; providers: RedactedPaseoAgentProviderConfig[] } {
    const config = readPaseoAgentConfig(loadPersistedConfig(this.paseoHome, this.logger));
    return {
      defaultModel: config.defaultModel ?? null,
      providers: redactedProviders(config, this.env),
    };
  }

  setProvider(input: SetProviderInput): RedactedPaseoAgentProviderConfig {
    const next = this.updateConfig((current) =>
      PaseoAgentConfigSchema.parse({
        ...current,
        providers: {
          ...current.providers,
          [input.name]: {
            type: input.providerType,
            options: input.options,
          },
        },
      }),
    );
    return this.requireRedactedProvider(next, input.name);
  }

  removeProvider(name: string): boolean {
    let removed = false;
    this.updateConfig((current) => {
      const providers = { ...current.providers };
      removed = Object.prototype.hasOwnProperty.call(providers, name);
      delete providers[name];
      return PaseoAgentConfigSchema.parse({
        ...current,
        ...(Object.keys(providers).length > 0 ? { providers } : { providers: undefined }),
        ...(current.defaultModel?.startsWith(`${name}/`) ? { defaultModel: undefined } : {}),
      });
    });
    return removed;
  }

  storeChatGptCredential(providerName: string, credential: PaseoAgentOAuthCredential): void {
    storeCodexOAuthCredential({
      providerInstance: providerName,
      credential,
      env: this.env,
    });
    const config = readPaseoAgentConfig(loadPersistedConfig(this.paseoHome, this.logger));
    this.onConfigChanged?.(config);
  }

  private requireRedactedProvider(
    config: PaseoAgentConfig,
    name: string,
  ): RedactedPaseoAgentProviderConfig {
    const provider = redactedProviders(config, this.env).find((entry) => entry.name === name);
    if (!provider) {
      throw new Error(`Paseo Agent provider '${name}' was not found after update.`);
    }
    return provider;
  }

  private updateConfig(update: (current: PaseoAgentConfig) => PaseoAgentConfig): PaseoAgentConfig {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const next = update(readPaseoAgentConfig(persisted));
    savePersistedConfig(this.paseoHome, mergePaseoAgentConfig(persisted, next), this.logger);
    this.onConfigChanged?.(next);
    return next;
  }
}
