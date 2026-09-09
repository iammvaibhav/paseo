import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Logger } from "pino";
import pLimit, { type LimitFunction } from "p-limit";

import { expandTilde } from "../../utils/path.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import {
  filterSelectableAgentModels,
  type AgentClient,
  type AgentCreateConfigParent,
  type AgentMode,
  type AgentModelDefinition,
  type AgentProvider,
  type FetchCatalogOptions,
  type ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import {
  raceProviderRefreshAbort,
  runProviderRefreshWithDeadline,
} from "./provider-refresh-deadline.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type { OpenCodeBridge } from "./providers/opencode/bridge.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./provider-launch-config.js";
import {
  buildProviderRegistry,
  shutdownAgentClients,
  type ProviderDefinition,
} from "./provider-registry.js";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { applyMutableProviderConfigToOverrides } from "../daemon-config-store.js";
import {
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./providers/diagnostic-utils.js";
import type { MutableDaemonConfig } from "../daemon-config-store.js";
import type { HubExecutionAgentValidationIssue } from "@getpaseo/protocol/messages";
import {
  type AgentConfigurationValidationInput,
  validateAgentConfigurationAgainstProvider,
} from "./agent-configuration-validator.js";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import { ProviderCatalogStore } from "./provider-catalog-store.js";

const DEFAULT_REFRESH_TIMEOUT_MS = 120_000;
const MAX_REFRESH_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 120_000;
const PROVIDER_REFRESH_DEADLINE_ENV = "PASEO_PROVIDER_REFRESH_TIMEOUT_MS";
export const GLOBAL_PROVIDER_SNAPSHOT_KEY = "paseo:global";

function validRefreshDeadline(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REFRESH_TIMEOUT_MS
    ? value
    : undefined;
}

function providerRefreshDeadline(configured: number | undefined): number {
  const explicit = validRefreshDeadline(configured);
  if (explicit !== undefined) return explicit;
  return (
    validRefreshDeadline(Number(process.env[PROVIDER_REFRESH_DEADLINE_ENV])) ??
    DEFAULT_REFRESH_TIMEOUT_MS
  );
}

function resolveDiagnosticTimeoutMs(option: number | undefined, refreshTimeoutMs: number): number {
  if (typeof option === "number" && Number.isFinite(option) && option > 0) {
    return option;
  }
  return Math.max(refreshTimeoutMs, DEFAULT_DIAGNOSTIC_TIMEOUT_MS);
}

function omitProviderOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides || providers.length === 0) return overrides;
  const nextOverrides = { ...overrides };
  for (const provider of providers) delete nextOverrides[provider];
  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

/**
 * The subset of a provider's resolved configuration that actually changes
 * what a catalog fetch would return: command/args, env, params (baseUrl,
 * apiKey, etc. flow through these), the explicit model list overrides, the
 * enabled flag, and which base provider this one derives from. Everything
 * else on `ProviderDefinition.configuration` — label, description, order —
 * is display-only and must never invalidate an already-fetched catalog.
 */
function catalogRelevantConfiguration(configuration: ProviderDefinition["configuration"]): unknown {
  if (!configuration) return null;
  return {
    command: configuration.runtimeSettings?.command,
    env: configuration.runtimeSettings?.env,
    profileModels: configuration.profileModels,
    additionalModels: configuration.additionalModels,
    profileModelsAreAdditive: configuration.profileModelsAreAdditive,
    enabled: configuration.enabled,
    derivedFromProviderId: configuration.derivedFromProviderId,
    providerParams: configuration.providerParams,
  };
}

/** Published values are shared read-only; provider-owned data is detached at publication. */
export interface ProviderSnapshotRecord {
  readonly entry: ProviderSnapshotEntry;
  readonly contentHash: string;
}

export interface ProviderSnapshot {
  readonly cwd: string;
  readonly records: readonly ProviderSnapshotRecord[];
}

export interface ProviderSnapshotTransition {
  readonly previous: ProviderSnapshot;
  readonly current: ProviderSnapshot;
}

type ProviderSnapshotChangeListener = (transition: ProviderSnapshotTransition) => void;

export interface ProviderSnapshotManagerOptions {
  logger: Logger;
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  extraClients?: Partial<Record<AgentProvider, AgentClient>>;
  refreshTimeoutMs?: number;
  diagnosticTimeoutMs?: number;
  openCodeBridge?: OpenCodeBridge;
  /** Enables a ready-at-boot, no-fetch first snapshot; see provider-catalog-store.ts. */
  catalogStore?: ProviderCatalogStore;
}

interface ProviderSnapshotRefreshOptions {
  cwd: string;
  providers?: AgentProvider[];
}

interface ProviderSnapshotWarmUpOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
}

interface ProviderSnapshotReadOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
  wait?: boolean;
}

interface ApplyMutableProviderConfigOptions {
  removeProviders?: readonly string[];
  replace?: boolean;
}

export interface PreparedMutableProviderConfig {
  agentManagerState: AgentManagerProviderState;
  commit(): void;
}

interface ProviderSnapshotProviderOptions {
  cwd?: string | null;
  provider: AgentProvider;
  wait?: boolean;
}

export interface ResolveProviderCreateConfigOptions {
  cwd?: string | null;
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: ManagedAgent | null;
  unattended: boolean;
}

export interface ResolvedProviderCreateConfig {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

interface ResolveDefaultModelOptions {
  provider: AgentProvider;
  requestedModel?: string | null;
  cwd?: string;
}

export interface ProviderDiagnosticResult {
  provider: AgentProvider;
  diagnostic: string;
}

export interface AgentManagerProviderState {
  providerDefinitions: Partial<
    Record<
      AgentProvider,
      Pick<
        ProviderDefinition,
        "enabled" | "derivedFromProviderId" | "validateOptions" | "applyOptions" | "applyToolPolicy"
      >
    >
  >;
  clients: Partial<Record<AgentProvider, AgentClient>>;
}

interface ProviderLoadOptions {
  snapshotCwd: string;
  providers: AgentProvider[];
  catalogScope: ProviderCatalogScope;
  force: boolean;
}
interface CatalogBinding {
  key?: string;
  failure?: ProviderSnapshotRecord;
  /** Refresh intent survives reads that supersede an unfinished key lookup. */
  force: boolean;
  promise: Promise<void>;
}

interface ProviderCatalog {
  result?: ProviderSnapshotRecord;
  stale?: boolean;
  load?: Promise<void>;
}

interface RegistryGeneration {
  definitions: Record<AgentProvider, ProviderDefinition>;
  order: readonly AgentProvider[];
  providerStates: ReadonlyMap<
    AgentProvider,
    { initial: ProviderSnapshotRecord; discoveryLimit: LimitFunction }
  >;
}

interface Target {
  bindings: Map<AgentProvider, CatalogBinding>;
  snapshot: ProviderSnapshot;
}

type ProviderCatalogScope = { scope: "global" } | { scope: "workspace"; cwd: string };

interface ProviderSnapshotTarget {
  snapshotCwd: string;
  catalogScope: ProviderCatalogScope;
}

export class ProviderSnapshotManager {
  private readonly catalogs = new Map<string, Map<AgentProvider, ProviderCatalog>>();
  private readonly targets = new Map<string, Target>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  private refreshTimeoutMs: number;
  private diagnosticTimeoutMs: number;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly openCodeBridge?: OpenCodeBridge;
  private readonly isDev: boolean;
  private readonly extraClients: Partial<Record<AgentProvider, AgentClient>>;
  private runtimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private providerOverrides: Record<string, ProviderOverride> | undefined;
  private baseProviderOverrides: Record<string, ProviderOverride> | undefined;
  private generation: RegistryGeneration;
  private providerClients: Record<AgentProvider, AgentClient>;
  private readonly ownedClients = new Set<AgentClient>();
  private readonly pluginProviders: PluginAgentClientRegistry;
  private readonly catalogStore: ProviderCatalogStore | undefined;

  constructor(options: ProviderSnapshotManagerOptions) {
    this.logger = options.logger;
    this.pluginProviders = new PluginAgentClientRegistry(
      options.logger.child({ module: "plugin-providers" }),
    );
    this.workspaceGitService = options.workspaceGitService;
    this.managedProcesses = options.managedProcesses;
    this.openCodeBridge = options.openCodeBridge;
    this.isDev = options.isDev === true;
    this.extraClients = options.extraClients ?? {};
    this.runtimeSettings = options.runtimeSettings;
    this.providerOverrides = options.providerOverrides;
    this.baseProviderOverrides = options.providerOverrides;
    this.refreshTimeoutMs = providerRefreshDeadline(options.refreshTimeoutMs);
    this.diagnosticTimeoutMs = resolveDiagnosticTimeoutMs(
      options.diagnosticTimeoutMs,
      this.refreshTimeoutMs,
    );
    this.generation = this.createGeneration(
      this.buildRegistry(this.runtimeSettings, this.providerOverrides),
      this.providerOverrides,
    );
    this.providerClients = {
      ...this.extraClients,
      ...this.pluginProviders.clients(),
    } as Record<AgentProvider, AgentClient>;
    for (const client of Object.values(this.providerClients)) this.ownedClients.add(client);
    this.catalogStore = options.catalogStore;
    if (this.catalogStore) this.restoreCatalogsFromStore(this.catalogStore);
  }

  /**
   * Seeds the global target with the last persisted successful catalog for
   * each still-configured, host-scoped provider, so boot-time readers
   * (identity backfill, first app mount) find an already-`ready` snapshot
   * instead of triggering a first-fill provider fetch. Only host-scoped
   * keys are restored: a workspace-scoped catalog belongs to one exact cwd,
   * which may not exist or match any open target on this boot.
   */
  private restoreCatalogsFromStore(catalogStore: ProviderCatalogStore): void {
    const restored = catalogStore.loadSync();
    if (restored.size === 0) return;
    const target = this.getOrCreateTarget(GLOBAL_PROVIDER_SNAPSHOT_KEY);
    for (const [provider, persisted] of restored) {
      if (!this.generation.definitions[provider] || !isSharedCatalogKey(persisted.cacheKey))
        continue;
      let catalogs = this.catalogs.get(persisted.cacheKey);
      if (!catalogs) {
        catalogs = new Map();
        this.catalogs.set(persisted.cacheKey, catalogs);
      }
      catalogs.set(provider, { result: identifyEntry(persisted.result), stale: false });
      target.bindings.set(provider, {
        key: persisted.cacheKey,
        force: false,
        promise: Promise.resolve(),
      });
    }
    this.publishTargets([GLOBAL_PROVIDER_SNAPSHOT_KEY]);
  }

  getSnapshot(cwd?: string): ProviderSnapshot {
    const target = resolveProviderSnapshotTarget(cwd);
    return this.getSnapshotForTarget(target);
  }

  async refreshSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveSnapshotCwd(options.cwd);
    const target = createWorkspaceSnapshotTarget(snapshotCwd);
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();
    await this.refreshProviders(target, providersToRefresh);
  }

  async refreshSettingsSnapshot(
    options: Omit<ProviderSnapshotRefreshOptions, "cwd"> = {},
  ): Promise<void> {
    const target = createGlobalSnapshotTarget();
    const homeCwd = target.snapshotCwd;
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();

    this.getOrCreateTarget(homeCwd);
    for (const catalogs of this.catalogs.values()) {
      for (const provider of providersToRefresh) {
        const catalog = catalogs.get(provider);
        if (catalog) catalogs.set(provider, { result: catalog.result, stale: true });
      }
    }
    // Refresh each known target: provider keys coalesce reads, while target-scoped
    // providers must discover again in their own execution context.
    await this.refreshProviders(target, providersToRefresh);
    await Promise.all(
      [...this.targets.keys()]
        .filter((cwd) => cwd !== homeCwd)
        .map((cwd) => this.warmUp(createWorkspaceSnapshotTarget(cwd), providersToRefresh)),
    );
  }

  async warmUpSnapshotForCwd(options: ProviderSnapshotWarmUpOptions): Promise<void> {
    const target = resolveProviderSnapshotTarget(options.cwd);
    const snapshotCwd = target.snapshotCwd;
    const providers = this.resolveRefreshProviders(options.providers);
    if (options.providers && providers?.length === 0) {
      return;
    }

    const providersToWarm = this.resolveProvidersToWarm(snapshotCwd, providers);
    if (providersToWarm.length === 0) {
      return;
    }
    await this.warmUp(target, providersToWarm);
  }

  async refresh(options: ProviderSnapshotRefreshOptions): Promise<void> {
    await this.refreshSnapshotForCwd(options);
  }

  listRegisteredProviderIds(): AgentProvider[] {
    return this.getProviderIds();
  }

  hasProvider(provider: AgentProvider): boolean {
    return Object.prototype.hasOwnProperty.call(this.generation.definitions, provider);
  }
  isProviderEnabled(provider: AgentProvider): boolean {
    return this.generation.definitions[provider]?.enabled ?? false;
  }

  getProviderLabel(provider: AgentProvider): string {
    return this.generation.definitions[provider]?.label ?? provider;
  }

  getAgentManagerProviderState(): AgentManagerProviderState {
    return this.createAgentManagerState(this.generation.definitions, this.providerClients);
  }

  private createAgentManagerState(
    definitions: Record<AgentProvider, ProviderDefinition>,
    providerClients: Record<AgentProvider, AgentClient>,
  ): AgentManagerProviderState {
    const providerDefinitions: AgentManagerProviderState["providerDefinitions"] = {};
    const clients: AgentManagerProviderState["clients"] = {};
    for (const [provider, definition] of Object.entries(definitions)) {
      providerDefinitions[provider] = {
        enabled: definition.enabled,
        derivedFromProviderId: definition.derivedFromProviderId,
        validateOptions: definition.validateOptions,
        applyOptions: definition.applyOptions,
        applyToolPolicy: definition.applyToolPolicy,
      };
      if (definition.enabled) {
        clients[provider] = this.ensureClient(provider, definition, providerClients);
      }
    }
    for (const [provider, client] of Object.entries(this.extraClients)) {
      if (client) {
        clients[provider] = client;
      }
    }
    return { providerDefinitions, clients };
  }

  replacePluginProviders(
    registrations: readonly ProviderRegistration[],
  ): AgentManagerProviderState {
    for (const registration of registrations) {
      if (
        (this.generation.definitions[registration.id] || this.extraClients[registration.id]) &&
        !this.pluginProviders.has(registration.id)
      ) {
        throw new Error(
          `Plugin provider '${registration.id}' conflicts with a configured provider`,
        );
      }
    }
    const previousPlugins = this.pluginProviders.definitions();
    const clients = { ...this.providerClients };
    // Materialize fallible installed clients before retiring any plugin runtime.
    this.createAgentManagerState(this.generation.definitions, clients);
    this.pluginProviders.replace(registrations);
    const plugins = this.pluginProviders.definitions();
    const definitions = { ...this.generation.definitions };
    const changed = new Set<AgentProvider>();
    for (const provider of new Set([...Object.keys(previousPlugins), ...Object.keys(plugins)])) {
      if (previousPlugins[provider] !== plugins[provider]) changed.add(provider);
      delete definitions[provider];
      delete clients[provider];
    }
    Object.assign(definitions, plugins);
    Object.assign(clients, this.pluginProviders.clients());
    for (const client of Object.values(clients)) this.ownedClients.add(client);
    const generation = this.createGeneration(definitions, this.providerOverrides);
    const state = this.createAgentManagerState(definitions, clients);
    this.installGeneration(generation, clients, changed);
    return state;
  }

  private ensureClient(
    provider: AgentProvider,
    definition: ProviderDefinition,
    clients = this.providerClients,
  ): AgentClient {
    const existing = clients[provider];
    if (existing) {
      return existing;
    }
    const client = definition.createClient(this.logger);
    clients[provider] = client;
    this.ownedClients.add(client);
    return client;
  }

  async listProviders(input: ProviderSnapshotReadOptions = {}): Promise<ProviderSnapshotEntry[]> {
    const target = resolveProviderSnapshotTarget(input.cwd);
    if (input.wait) {
      await this.warmUpSnapshotForCwd({ cwd: input.cwd, providers: input.providers });
    }
    const providerFilter = input.providers ? new Set(input.providers) : null;
    const snapshot = input.wait
      ? this.getOrCreateTarget(target.snapshotCwd).snapshot
      : this.getSnapshotForTarget(target, input.providers);
    const entries = snapshot.records.map(({ entry }) => entry);
    return providerFilter ? entries.filter((entry) => providerFilter.has(entry.provider)) : entries;
  }

  async getProvider(input: ProviderSnapshotProviderOptions): Promise<ProviderSnapshotEntry> {
    const entry = (await this.listProviders({ ...input, providers: [input.provider] })).find(
      (candidate) => candidate.provider === input.provider,
    );
    if (!entry) {
      throw new Error(`Provider ${input.provider} is not configured`);
    }
    return entry;
  }

  async validateAgentConfiguration(
    input: AgentConfigurationValidationInput,
  ): Promise<HubExecutionAgentValidationIssue[]> {
    if (!this.hasProvider(input.provider)) {
      return [
        {
          path: ["provider"],
          message: `Provider '${input.provider}' is not configured`,
        },
      ];
    }

    const provider = await this.getProvider({
      provider: input.provider,
      wait: true,
    });
    if (!provider.enabled) {
      return [{ path: ["provider"], message: `Provider '${input.provider}' is disabled` }];
    }
    if (provider.status !== "ready") {
      return [
        {
          path: ["provider"],
          message:
            provider.status === "error" && provider.error
              ? provider.error
              : `Provider '${input.provider}' is not available`,
        },
      ];
    }

    const definition = this.requireProvider(input.provider);
    return validateAgentConfigurationAgainstProvider({
      input,
      provider,
      validateOptions: definition.validateOptions,
    });
  }

  async listModels(input: ProviderSnapshotProviderOptions): Promise<AgentModelDefinition[]> {
    const entry = await this.getReadyProvider(input);
    return filterSelectableAgentModels(entry.models);
  }

  async listModes(input: ProviderSnapshotProviderOptions): Promise<AgentMode[]> {
    const entry = await this.getReadyProvider(input);
    return entry.modes ?? [];
  }

  async resolveDefaultModel(input: ResolveDefaultModelOptions): Promise<string | undefined> {
    try {
      const trimmed = input.requestedModel?.trim();
      if (trimmed) {
        return trimmed;
      }
      const models = await this.listModels({
        provider: input.provider,
        cwd: input.cwd ? expandTilde(input.cwd) : undefined,
        wait: true,
      });
      const preferred = models.find((model) => model.isDefault) ?? models[0];
      return preferred?.id;
    } catch (error) {
      this.logger.warn({ err: error, provider: input.provider }, "Failed to resolve default model");
      return undefined;
    }
  }

  async resolveCreateConfig(
    input: ResolveProviderCreateConfigOptions,
  ): Promise<ResolvedProviderCreateConfig> {
    const readyStartedAt = Date.now();
    // Create must not wait on a workspace-scoped catalog refresh. A brand-new
    // worktree has no snapshot, and OMP answers by cold-booting a throwaway
    // process in that cwd (~7s). Modes/models used here are provider-global.
    const entry = await this.getReadyProviderForCreate(input.provider);
    const readyMs = Date.now() - readyStartedAt;
    const definition = this.requireProvider(input.provider);
    const parent = input.parent ? this.resolveParent(input.parent) : null;
    const resolved = definition.resolveCreateConfig({
      provider: input.provider,
      requestedMode: input.requestedMode,
      featureValues: input.featureValues,
      parent,
      unattended: input.unattended || parent?.isUnattended === true,
      availableModes: entry.modes ?? [],
    });
    // How long the create waited for the provider snapshot (a cold catalog
    // fetch when the snapshot was missing/stale) before mode resolution.
    // Info normally; warn when the wait was >=1s.
    const timingFields = {
      provider: input.provider,
      cwd: input.cwd,
      readyMs,
      status: entry.status,
    };
    if (readyMs >= 1_000) {
      this.logger.warn(timingFields, "provider.resolve_create_config_slow");
    } else {
      this.logger.info(timingFields, "provider.resolve_create_config");
    }
    return resolved;
  }

  async getProviderDiagnostic(provider: AgentProvider): Promise<ProviderDiagnosticResult> {
    const definition = this.generation.definitions[provider];
    if (!definition) {
      return {
        provider,
        diagnostic: formatProviderDiagnostic(provider, [
          { label: "Error", value: `Provider ${provider} is not configured` },
        ]),
      };
    }

    const baseDiagnosticPromise = this.getBaseProviderDiagnostic(provider, definition);
    const snapshotEntryPromise = this.readDiagnosticSnapshotEntry(provider);
    const [baseDiagnostic, entry] = await Promise.all([
      baseDiagnosticPromise,
      snapshotEntryPromise,
    ]);

    const modelCount = entry.status === "ready" ? String(entry.models?.length ?? 0) : "—";
    const status = formatProviderStatus(entry);
    const diagnostic = `${baseDiagnostic}\n  Models: ${modelCount}\n  Status: ${status}`;
    return { provider, diagnostic };
  }

  applyMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
    options: ApplyMutableProviderConfigOptions = {},
  ): AgentManagerProviderState {
    const prepared = this.prepareMutableProviderConfig(mutableProviders, options);
    prepared.commit();
    return prepared.agentManagerState;
  }

  prepareMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
    options: ApplyMutableProviderConfigOptions = {},
  ): PreparedMutableProviderConfig {
    const baseProviderOverrides = options.replace
      ? undefined
      : omitProviderOverrides(this.baseProviderOverrides, options.removeProviders ?? []);
    const runtimeSettings = options.replace ? undefined : this.runtimeSettings;
    const providerOverrides = applyMutableProviderConfigToOverrides(
      baseProviderOverrides,
      mutableProviders,
    );
    const definitions = this.buildRegistry(runtimeSettings, providerOverrides);
    const changed = new Set<AgentProvider>();
    const catalogChanged = new Set<AgentProvider>();
    const clients = { ...this.providerClients };
    for (const provider of new Set([...this.generation.order, ...Object.keys(definitions)])) {
      const before = this.generation.definitions[provider];
      const after = definitions[provider];
      if (!before || !after) {
        changed.add(provider);
        catalogChanged.add(provider);
        delete clients[provider];
        continue;
      }
      if (isDeepStrictEqual(before.configuration, after.configuration)) {
        definitions[provider] = before;
        continue;
      }
      changed.add(provider);
      delete clients[provider];
      if (
        !isDeepStrictEqual(
          catalogRelevantConfiguration(before.configuration),
          catalogRelevantConfiguration(after.configuration),
        )
      ) {
        catalogChanged.add(provider);
      }
    }
    Object.assign(clients, this.extraClients, this.pluginProviders.clients());
    const generation = this.createGeneration(definitions, providerOverrides);
    const agentManagerState = this.createAgentManagerState(definitions, clients);
    return {
      agentManagerState,
      commit: () => {
        this.baseProviderOverrides = baseProviderOverrides;
        this.runtimeSettings = runtimeSettings;
        this.providerOverrides = providerOverrides;
        this.installGeneration(generation, clients, changed, catalogChanged);
      },
    };
  }

  /**
   * `changed` discards each provider's queued discovery work — any config
   * replace makes queued probes stale, whether or not the catalog itself
   * is affected. `catalogChanged` (defaulting to `changed` for callers
   * that don't distinguish, e.g. plugin registration replacement) drives
   * catalog invalidation and rewarm; a provider in `changed` alone instead
   * gets its already-cached catalog patched in place via
   * `patchCachedProviderDisplay`, without ever touching a fetched catalog.
   */
  private installGeneration(
    generation: RegistryGeneration,
    clients: Record<AgentProvider, AgentClient>,
    changed: ReadonlySet<AgentProvider>,
    catalogChanged: ReadonlySet<AgentProvider> = changed,
  ): void {
    for (const provider of changed) {
      this.generation.providerStates.get(provider)?.discoveryLimit.clearQueue();
      if (!catalogChanged.has(provider)) {
        this.patchCachedProviderDisplay(provider, generation.definitions[provider]);
      }
    }
    this.generation = generation;
    this.providerClients = clients;
    for (const [key, catalogs] of this.catalogs) {
      for (const provider of catalogChanged) catalogs.delete(provider);
      if (catalogs.size === 0) this.catalogs.delete(key);
    }
    for (const target of this.targets.values()) {
      for (const provider of catalogChanged) target.bindings.delete(provider);
    }
    this.publishTargets(this.targets.keys());
    const providers = [...catalogChanged].filter((provider) => generation.definitions[provider]);
    if (providers.length === 0) return;
    // Per-cwd warmUp naturally dedupes to one real fetch for a shared/
    // host-scoped catalog key (each target resolves the same cache-key
    // entry and finds the first target's fetch already in flight); a
    // workspace-scoped provider genuinely needs its own fetch per cwd.
    for (const cwd of this.targets.keys()) {
      void this.warmUp(
        resolveProviderSnapshotTarget(cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY ? undefined : cwd),
        providers,
      );
    }
  }

  /**
   * Applies a display-only definition change (label/description/icon) to
   * already-cached catalog results and failure records, so open snapshots
   * reflect it immediately without invalidating or refetching anything.
   */
  private patchCachedProviderDisplay(
    provider: AgentProvider,
    definition: ProviderDefinition | undefined,
  ): void {
    if (!definition) return;
    const patch = {
      label: definition.label,
      description: definition.description,
      iconSvg: definition.iconSvg,
    };
    for (const catalogs of this.catalogs.values()) {
      const catalog = catalogs.get(provider);
      if (catalog?.result) {
        catalog.result = identifyEntry({ ...catalog.result.entry, ...patch });
      }
    }
    for (const target of this.targets.values()) {
      const binding = target.bindings.get(provider);
      if (binding?.failure) {
        binding.failure = identifyEntry({ ...binding.failure.entry, ...patch });
      }
    }
  }

  setRefreshTimeoutMs(refreshTimeoutMs: number | undefined): void {
    this.refreshTimeoutMs = providerRefreshDeadline(refreshTimeoutMs);
    this.diagnosticTimeoutMs = resolveDiagnosticTimeoutMs(undefined, this.refreshTimeoutMs);
  }

  on(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;
    for (const state of this.generation.providerStates.values()) state.discoveryLimit.clearQueue();
    // Materialize a client per enabled provider so provider-owned resources
    // (background processes, sockets, etc.) get a chance to release even when
    // a given provider hasn't been touched yet during this daemon's lifetime.
    this.getAgentManagerProviderState();
    await shutdownAgentClients(this.ownedClients, this.logger);
  }

  destroy(): void {
    this.destroyed = true;
    for (const state of this.generation.providerStates.values()) state.discoveryLimit.clearQueue();
    this.catalogs.clear();
    this.targets.clear();
    this.events.removeAllListeners();
  }

  private buildRegistry(
    runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
    providerOverrides: Record<string, ProviderOverride> | undefined,
  ): Record<AgentProvider, ProviderDefinition> {
    const registry = buildProviderRegistry(this.logger, {
      runtimeSettings,
      providerOverrides,
      workspaceGitService: this.workspaceGitService,
      managedProcesses: this.managedProcesses,
      openCodeBridge: this.openCodeBridge,
      isDev: this.isDev,
    });

    for (const [provider, definition] of Object.entries(this.pluginProviders.definitions())) {
      if (registry[provider]) {
        throw new Error(`Plugin provider '${provider}' conflicts with a configured provider`);
      }
      registry[provider] = definition;
    }

    for (const [provider, client] of Object.entries(this.extraClients) as Array<
      [AgentProvider, AgentClient]
    >) {
      const definition = registry[provider];
      if (!definition) continue;
      registry[provider] = {
        ...definition,
        createClient: () => client,
        resolveCreateConfig:
          client.resolveCreateConfig?.bind(client) ?? definition.resolveCreateConfig,
        isCreateConfigUnattended:
          client.isCreateConfigUnattended?.bind(client) ?? definition.isCreateConfigUnattended,
        fetchCatalog: (options, _client, context) => client.fetchCatalog(options, context),
      };
    }

    return registry;
  }

  private resolveParent(parent: ManagedAgent): AgentCreateConfigParent {
    const definition = this.requireProvider(parent.provider);
    return {
      provider: parent.provider,
      modeId: parent.currentModeId,
      isUnattended: definition.isCreateConfigUnattended({
        modeId: parent.currentModeId,
        config: parent.config,
        features: parent.features,
        availableModes: parent.availableModes ?? definition.modes ?? [],
      }),
    };
  }

  private getSnapshotForTarget(
    target: ProviderSnapshotTarget,
    providers?: AgentProvider[],
  ): ProviderSnapshot {
    this.getOrCreateTarget(target.snapshotCwd);
    this.bindSharedCatalogs(target.snapshotCwd);
    const providersToWarm = this.resolveProvidersToWarm(target.snapshotCwd, providers).filter(
      (provider) => this.shouldAutoWarmProvider(target.snapshotCwd, provider),
    );
    if (providersToWarm.length > 0) {
      void this.warmUp(target, providersToWarm);
    }
    return this.getOrCreateTarget(target.snapshotCwd).snapshot;
  }

  /**
   * Snapshot used at agent-create time. Prefer the already-warm global
   * catalog; never kick off a per-cwd refresh that would stall the create.
   */
  private async getReadyProviderForCreate(provider: AgentProvider): Promise<ProviderSnapshotEntry> {
    const global = await this.getProvider({ provider, wait: false });
    if (global.enabled && global.status === "ready") {
      return global;
    }
    return this.getReadyProvider({ provider, wait: true });
  }

  private async getReadyProvider(
    input: ProviderSnapshotProviderOptions,
  ): Promise<ProviderSnapshotEntry> {
    const entry = await this.getProvider(input);
    if (!entry.enabled) {
      throw new Error(`Provider '${entry.provider}' is disabled`);
    }
    if (entry.status === "ready") {
      return entry;
    }
    if (entry.status === "error") {
      throw new Error(entry.error ?? `Failed to load provider '${entry.provider}'`);
    }
    throw new Error(`Provider '${entry.provider}' is not available`);
  }

  private requireProvider(provider: AgentProvider): ProviderDefinition {
    const definition = this.generation.definitions[provider];
    if (!definition) {
      throw new Error(`Provider ${provider} is not configured`);
    }
    return definition;
  }

  /**
   * Reads the provider's current global-scope snapshot entry without
   * forcing a catalog refetch. When no catalog exists yet for this provider
   * (never warmed this boot), this falls through to the same first-fill
   * path `getSnapshotForTarget` uses for any other snapshot read — never a
   * forced refresh.
   */
  private async readDiagnosticSnapshotEntry(
    provider: AgentProvider,
  ): Promise<ProviderSnapshotEntry> {
    try {
      const target = createGlobalSnapshotTarget();
      this.getSnapshotForTarget(target, [provider]);
      // getSnapshotForTarget starts warm-up fire-and-forget only for a
      // missing/never-fetched catalog; awaiting the (possibly already
      // resolved) binding promise lets the diagnostic reflect that result
      // instead of racing it.
      await this.getOrCreateTarget(target.snapshotCwd).bindings.get(provider)?.promise;
      return await this.getProvider({ provider, wait: false });
    } catch (error) {
      return {
        ...this.generation.providerStates.get(provider)!.initial.entry,
        status: "error",
        error: toErrorMessage(error),
      };
    }
  }

  private async getBaseProviderDiagnostic(
    provider: AgentProvider,
    definition: ProviderDefinition,
  ): Promise<string> {
    try {
      const client = this.ensureClient(provider, definition);
      if (client.getDiagnostic) {
        return (
          await withTimeout(
            client.getDiagnostic(),
            this.diagnosticTimeoutMs,
            `Timed out collecting ${definition.label ?? provider} diagnostic after ${
              this.diagnosticTimeoutMs
            }ms`,
          )
        ).diagnostic;
      }
      return formatProviderDiagnostic(definition.label ?? provider, [
        { label: "Diagnostic", value: "No diagnostic available" },
      ]);
    } catch (error) {
      return formatProviderDiagnosticError(definition.label ?? provider, error);
    }
  }

  private createGeneration(
    definitions: Record<AgentProvider, ProviderDefinition>,
    overrides: Record<string, ProviderOverride> | undefined,
  ): RegistryGeneration {
    const order = Object.keys(definitions);
    const providerStates = new Map<
      AgentProvider,
      { initial: ProviderSnapshotRecord; discoveryLimit: LimitFunction }
    >();
    for (const provider of order) {
      const definition = definitions[provider]!;
      const previous = this.generation?.providerStates.get(provider);
      if (this.generation?.definitions[provider] === definition) {
        providerStates.set(provider, previous!);
        continue;
      }
      const custom =
        this.pluginProviders.has(provider) ||
        (!BUILTIN_PROVIDER_IDS.includes(provider) && !!overrides?.[provider]?.extends);
      providerStates.set(provider, {
        discoveryLimit: previous?.discoveryLimit ?? pLimit({ concurrency: 4, rejectOnClear: true }),
        initial: identifyEntry({
          provider,
          status: definition.enabled ? "loading" : "unavailable",
          enabled: definition.enabled,
          source: custom ? "custom" : "builtin",
          label: definition.label,
          description: definition.description,
          iconSvg: definition.iconSvg,
          defaultModeId: definition.defaultModeId ?? null,
        }),
      });
    }
    return { definitions, order, providerStates };
  }

  private async warmUp(target: ProviderSnapshotTarget, providers?: AgentProvider[]): Promise<void> {
    const providersToRefresh = providers ?? this.getProviderIds();

    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers: providersToRefresh,
      force: false,
    });
  }

  private async refreshProviders(
    target: ProviderSnapshotTarget,
    providers: AgentProvider[],
  ): Promise<void> {
    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers,
      force: true,
    });
  }

  private resolveProvidersToWarm(cwd: string, providers?: AgentProvider[]): AgentProvider[] {
    this.getOrCreateTarget(cwd);
    // Identity is provider-owned and may change without a daemon config reload.
    return providers ?? this.getProviderIds();
  }

  /**
   * Host-scoped catalogues (OMP, Claude, Codex) share one cache key. Copy that
   * binding onto a new cwd so getSnapshot() is already `ready` instead of
   * kicking a throwaway provider boot in the worktree.
   */
  private bindSharedCatalogs(snapshotCwd: string): void {
    const target = this.getOrCreateTarget(snapshotCwd);
    let changed = false;
    for (const provider of this.getProviderIds()) {
      const existing = target.bindings.get(provider);
      if (existing?.key && isSharedCatalogKey(existing.key)) {
        continue;
      }
      const shared = this.findSharedCatalogBinding(provider, snapshotCwd);
      if (!shared?.key) {
        continue;
      }
      target.bindings.set(provider, {
        key: shared.key,
        failure: shared.failure,
        force: false,
        promise: shared.promise,
      });
      changed = true;
    }
    if (changed) {
      this.publishTargets([snapshotCwd]);
    }
  }

  private findSharedCatalogBinding(
    provider: AgentProvider,
    excludeCwd?: string,
  ): CatalogBinding | undefined {
    const global = this.targets.get(GLOBAL_PROVIDER_SNAPSHOT_KEY)?.bindings.get(provider);
    if (global?.key && isSharedCatalogKey(global.key)) {
      return global;
    }
    for (const [cwd, target] of this.targets) {
      if (cwd === excludeCwd) {
        continue;
      }
      const binding = target.bindings.get(provider);
      if (binding?.key && isSharedCatalogKey(binding.key)) {
        return binding;
      }
    }
    return undefined;
  }

  private shouldAutoWarmProvider(cwd: string, provider: AgentProvider): boolean {
    const binding = this.targets.get(cwd)?.bindings.get(provider);
    if (binding?.key && isSharedCatalogKey(binding.key)) {
      const catalog = this.catalogs.get(binding.key)?.get(provider);
      if (catalog?.load || (catalog?.result && !catalog.stale)) {
        return false;
      }
    }
    const shared = this.findSharedCatalogBinding(provider, cwd);
    if (shared?.key) {
      const catalog = this.catalogs.get(shared.key)?.get(provider);
      if (catalog?.load || (catalog?.result && !catalog.stale)) {
        return false;
      }
    }
    return true;
  }

  private async loadProviders(options: ProviderLoadOptions): Promise<void> {
    await Promise.allSettled(
      options.providers.map((provider) => this.loadProvider({ ...options, provider })),
    );
  }

  private loadProvider(options: ProviderLoadOptions & { provider: AgentProvider }): Promise<void> {
    if (this.destroyed || !this.generation.definitions[options.provider]) return Promise.resolve();
    const { bindings } = this.getOrCreateTarget(options.snapshotCwd);
    const binding: CatalogBinding = {
      key: bindings.get(options.provider)?.key,
      failure: bindings.get(options.provider)?.failure,
      force: options.force || bindings.get(options.provider)?.force === true,
      promise: Promise.resolve(),
    };
    bindings.set(options.provider, binding);
    binding.promise = this.resolveCatalog({ ...options, force: binding.force }, binding);
    return binding.promise;
  }

  private async resolveCatalog(
    options: ProviderLoadOptions & { provider: AgentProvider },
    binding: CatalogBinding,
  ): Promise<void> {
    const { provider, snapshotCwd, force } = options;
    const definition = this.generation.definitions[provider]!;
    const initial = this.generation.providerStates.get(provider)!.initial.entry;
    this.getOrCreateTarget(snapshotCwd);
    if (!definition.enabled) return;
    const currentBinding = () => this.targets.get(snapshotCwd)?.bindings.get(provider);
    const client = this.ensureClient(provider, definition);
    const catalogOptions = createFetchCatalogOptions(options.catalogScope, force);
    let key: string;
    try {
      const sharedKey = client.getCatalogCacheKey
        ? await withTimeout(
            client.getCatalogCacheKey(catalogOptions),
            this.refreshTimeoutMs,
            `Timed out resolving ${provider} catalogue key`,
          )
        : await Promise.resolve(undefined);
      key = JSON.stringify(
        sharedKey === undefined ? ["target", snapshotCwd] : ["provider", sharedKey],
      );
    } catch (error) {
      if (currentBinding() !== binding) return currentBinding()?.promise;
      binding.force = false;
      binding.key = undefined;
      binding.failure = identifyEntry({
        ...this.generation.providerStates.get(provider)!.initial.entry,
        status: "error",
        error: toErrorMessage(error),
      });
      this.publishTargets([snapshotCwd]);
      return;
    }
    // Only the latest key resolution for this target may bind it to a catalogue.
    if (currentBinding() !== binding) return currentBinding()?.promise;
    binding.force = false;
    binding.key = key;
    binding.failure = undefined;
    let catalogs = this.catalogs.get(key);
    if (!catalogs) {
      catalogs = new Map();
      this.catalogs.set(key, catalogs);
    }
    let catalog = catalogs.get(provider);
    if (!catalog) {
      catalog = {};
      catalogs.set(provider, catalog);
    }
    this.publishTargets([snapshotCwd]);
    if (!force && (catalog.load || (catalog.result && !catalog.stale))) return catalog.load;
    catalog.stale = false;

    const current = catalog;
    const isCurrent = (): boolean =>
      !this.destroyed && this.catalogs.get(key)?.get(provider) === current && current.load === load;
    const load = this.generation.providerStates
      .get(provider)!
      .discoveryLimit(() => {
        if (!isCurrent()) return;
        return this.refreshProvider({
          catalogOptions,
          provider,
          definition,
          initial,
          client,
          publish: (entry) => {
            if (!isCurrent()) return false;
            current.result = identifyEntry(structuredClone(entry));
            const boundTargets = [...this.targets].flatMap(([cwd, target]) =>
              target.bindings.get(provider)?.key === key ? [cwd] : [],
            );
            this.publishTargets(boundTargets);
            if (entry.status === "ready" && this.catalogStore && isSharedCatalogKey(key)) {
              void this.catalogStore.persist(provider, key, entry).catch((error) => {
                this.logger.warn({ err: error, provider }, "Failed to persist provider catalog");
              });
            }
            return true;
          },
        });
      })
      .finally(() => {
        if (current.load === load) current.load = undefined;
      });
    current.load = load;
    return load;
  }

  private async refreshProvider(options: {
    catalogOptions: FetchCatalogOptions;
    provider: AgentProvider;
    definition: ProviderDefinition;
    initial: ProviderSnapshotEntry;
    client: AgentClient;
    publish: (entry: ProviderSnapshotEntry) => boolean;
  }): Promise<void> {
    const {
      catalogOptions,
      provider,
      definition,
      initial: base,
      client,
      publish: setEntry,
    } = options;

    try {
      const catalog = await runProviderRefreshWithDeadline({
        label: definition.label,
        timeoutMs: this.refreshTimeoutMs,
        operation: async (context) => {
          const available = await context.runActivity("availability", () =>
            raceProviderRefreshAbort(
              context.signal,
              client.isAvailable(context.signal, catalogOptions),
            ),
          );
          if (!available) {
            return null;
          }

          return await definition.fetchCatalog(catalogOptions, client, context);
        },
      });
      if (!catalog) {
        setEntry({ ...base, status: "unavailable", enabled: true });
        return;
      }

      setEntry({
        ...base,
        defaultModeId:
          catalog.defaultModeId === undefined ? base.defaultModeId : catalog.defaultModeId,
        status: "ready",
        enabled: true,
        models: catalog.models,
        modes: catalog.modes,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      const emitted = setEntry({
        ...base,
        status: "error",
        enabled: true,
        error: toErrorMessage(error),
      });
      if (emitted) {
        this.logger.warn(
          { err: error, provider, target: catalogOptions },
          "Failed to refresh provider snapshot",
        );
      }
    }
  }

  private publishTargets(cwds: Iterable<string>): void {
    if (this.destroyed) return;
    const transitions: ProviderSnapshotTransition[] = [];
    for (const cwd of cwds) {
      const target = this.targets.get(cwd)!;
      const records = this.generation.order.map((provider) => {
        const binding = target.bindings.get(provider);
        const result = binding?.key
          ? this.catalogs.get(binding.key)?.get(provider)?.result
          : undefined;
        return binding?.failure ?? result ?? this.generation.providerStates.get(provider)!.initial;
      });
      const previous = target.snapshot;
      if (sameSnapshotRecords(previous.records, records)) continue;
      const current = { cwd, records };
      target.snapshot = current;
      transitions.push({ previous, current });
    }
    for (const transition of transitions) {
      for (const listener of this.events.listeners("change")) {
        try {
          listener(transition);
        } catch (error) {
          this.logger.error(
            { err: error, cwd: transition.current.cwd },
            "Provider snapshot subscriber failed",
          );
        }
      }
    }
  }

  private getOrCreateTarget(cwd: string): Target {
    let target = this.targets.get(cwd);
    if (!target) {
      target = {
        bindings: new Map(),
        snapshot: {
          cwd,
          records: this.generation.order.map(
            (provider) => this.generation.providerStates.get(provider)!.initial,
          ),
        },
      };
      this.targets.set(cwd, target);
    }
    return target;
  }

  private getProviderIds(): AgentProvider[] {
    return [...this.generation.order];
  }

  private resolveRefreshProviders(providers?: AgentProvider[]): AgentProvider[] | undefined {
    if (!providers || providers.length === 0) {
      return undefined;
    }

    const providerIds = new Set(this.getProviderIds());
    return Array.from(new Set(providers)).filter((provider) => providerIds.has(provider));
  }
}

export function resolveSnapshotCwd(cwd?: string | null): string {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return homedir();
  }
  let expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(expanded)) {
    expanded = `${expanded}\\`;
  }
  let resolved = resolve(expanded);
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(resolved)) {
    resolved = `${resolved}\\`;
  }
  return resolved;
}

function resolveProviderSnapshotTarget(cwd?: string | null): ProviderSnapshotTarget {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return createGlobalSnapshotTarget();
  }
  return createWorkspaceSnapshotTarget(resolveSnapshotCwd(trimmed));
}

function createGlobalSnapshotTarget(): ProviderSnapshotTarget {
  return {
    snapshotCwd: GLOBAL_PROVIDER_SNAPSHOT_KEY,
    catalogScope: { scope: "global" },
  };
}

function createWorkspaceSnapshotTarget(cwd: string): ProviderSnapshotTarget {
  const snapshotCwd = resolveSnapshotCwd(cwd);
  return {
    snapshotCwd,
    catalogScope: { scope: "workspace", cwd: snapshotCwd },
  };
}

function createFetchCatalogOptions(
  scope: ProviderCatalogScope,
  force: boolean,
): FetchCatalogOptions {
  return scope.scope === "global"
    ? { scope: "global", force }
    : { scope: "workspace", cwd: scope.cwd, force };
}

function isSharedCatalogKey(key: string): boolean {
  return key.startsWith('["provider"');
}

export function isGlobalProviderSnapshotKey(cwd: string): boolean {
  return cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY;
}

function identifyEntry(entry: ProviderSnapshotEntry): ProviderSnapshotRecord {
  const { fetchedAt: _fetchedAt, ...content } = entry;
  const contentHash = createHash("sha256")
    .update(JSON.stringify(["paseo.provider-result/1", content]))
    .digest("base64url");
  return { entry, contentHash };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown error";
}

function formatProviderStatus(entry: ProviderSnapshotEntry): string {
  if (entry.status === "ready") return "Ready";
  if (entry.status === "error") return `Error: ${entry.error ?? "Unknown error"}`;
  if (entry.status === "unavailable") return "Unavailable";
  return "Loading";
}

export function sameSnapshotRecords(
  previous: readonly ProviderSnapshotRecord[],
  current: readonly ProviderSnapshotRecord[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((before, index) => {
      const after = current[index]!;
      return (
        before === after ||
        (before.entry.provider === after.entry.provider &&
          before.contentHash === after.contentHash &&
          before.entry.fetchedAt === after.entry.fetchedAt)
      );
    })
  );
}
