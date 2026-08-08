import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "@getpaseo/client";
import type {
  MissionControlCentralConfig,
  MissionControlContextAgentSummary,
  MissionControlEvent,
  MissionControlInventory,
  MissionControlInventoryProject,
  MissionControlInventoryProjectWorkspace,
  MissionControlModels,
} from "@getpaseo/protocol/mission-control/types";
import type { Logger } from "pino";
import YAML from "yaml";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { buildCommanderSystemPrompt } from "./commander-contract.js";
import { hasMissionControlLabels } from "./naming.js";
import type { MissionControlReviewStateRecord, MissionControlReviewStateValue } from "./store.js";
import type { MissionControlDigestContextProvider } from "./digest.js";

const OMP_CONFIG_RELATIVE_PATH = join(".omp", "agent", "config.yml");
// Reserved MissionControlModels key carrying omp modelRoles (role → model) as
// "role: model" strings. The renderer prints it as the roles block, never as a
// provider's model list.
const OMP_MODEL_ROLES_KEY = "omp.modelRoles";
// Spec: roster is one line per live agent (running + ready-for-review only).
const ROSTER_LIMIT = 30;

export interface MissionControlContextPayload {
  inventory: MissionControlInventory;
  models: MissionControlModels;
  recentAgents: MissionControlContextAgentSummary[];
  /** This host's own missionControl.hostAlias declaration, if set. */
  hostAlias?: string;
}

export interface LocalInventoryInput {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  projectRegistry: Pick<ProjectRegistry, "list">;
  serverId: string;
}

export interface LocalModelsInput {
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "listProviders" | "listRegisteredProviderIds"
  >;
}

export interface LocalRecentAgentsInput {
  agentStorage: Pick<AgentStorage, "list">;
  agentManager: Pick<AgentManager, "listAgents">;
  serverId: string;
  /**
   * Lazy review-state map (running + ready-for-review roster filter). Resolved
   * at call time so the provider can be constructed before the mission-control
   * service is; absent → every live agent is a roster candidate.
   */
  getReviewStates?: () => ReadonlyMap<string, MissionControlReviewStateRecord> | null;
  /**
   * Lazy mission-control events, for each agent's last self-reported headline.
   * Absent → roster lines omit the headline.
   */
  getReportEvents?: () => MissionControlEvent[] | null;
}

export interface LocalContextInput
  extends LocalInventoryInput, LocalModelsInput, LocalRecentAgentsInput {
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
}

/**
 * Every project and workspace on this daemon, grouped by project, with titles
 * and cwd/kind. Workspaces whose project is archived or missing get a synthetic
 * project entry so nothing on disk silently vanishes from the fleet map.
 */
export async function buildLocalInventory(
  input: LocalInventoryInput,
): Promise<MissionControlInventory> {
  const [projects, workspaces] = await Promise.all([
    input.projectRegistry.list(),
    input.workspaceRegistry.list(),
  ]);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const workspacesByProject = new Map<string, MissionControlInventoryProjectWorkspace[]>();
  const orphanProjects = new Map<string, MissionControlInventoryProject>();

  for (const workspace of workspaces) {
    if (workspace.archivedAt) {
      continue;
    }
    const entry: MissionControlInventoryProjectWorkspace = {
      id: workspace.workspaceId,
      title: workspace.title ?? workspace.displayName,
      cwd: workspace.cwd,
      kind: workspace.kind,
    };
    const project = projectById.get(workspace.projectId);
    if (!project || project.archivedAt) {
      const orphan = orphanProjects.get(workspace.projectId) ?? {
        id: workspace.projectId,
        title: project?.displayName ?? workspace.displayName,
        hostServerId: input.serverId,
        workspaces: [],
      };
      orphan.workspaces.push(entry);
      orphanProjects.set(workspace.projectId, orphan);
      continue;
    }
    const projectWorkspaces = workspacesByProject.get(project.projectId) ?? [];
    projectWorkspaces.push(entry);
    workspacesByProject.set(project.projectId, projectWorkspaces);
  }

  const projectEntries: MissionControlInventoryProject[] = [];
  for (const project of projects) {
    if (project.archivedAt) {
      continue;
    }
    projectEntries.push({
      id: project.projectId,
      title: project.customName ?? project.displayName,
      ...(project.description ? { description: project.description } : {}),
      hostServerId: input.serverId,
      workspaces: workspacesByProject.get(project.projectId) ?? [],
    });
  }
  projectEntries.push(...orphanProjects.values());
  return { projects: projectEntries };
}

/**
 * Providers/models available on this daemon plus omp modelRoles defaults parsed
 * from the local ~/.omp/agent/config.yml. A missing or unparsable config.yml is
 * normal (only omp users have one) and yields no roles.
 */
export async function buildLocalModels(input: LocalModelsInput): Promise<MissionControlModels> {
  const entries = await input.providerSnapshotManager.listProviders({ wait: true });
  const models: MissionControlModels = {};
  for (const entry of entries) {
    models[entry.provider] = (entry.models ?? []).map((model) => model.id);
  }
  const roles = readOmpModelRoles();
  if (Object.keys(roles).length > 0) {
    models[OMP_MODEL_ROLES_KEY] = Object.entries(roles).map(([role, model]) => `${role}: ${model}`);
  }
  return models;
}

/**
 * Live agents for the Commander's roster: running or ready-for-review only
 * (spec), with identity fields (name/title/living description), the last
 * self-reported headline, and last-activity time for the age column. The
 * Commander and other mission-control-labeled agents are excluded — they are
 * not fleet work.
 */
export async function buildLocalRecentAgents(
  input: LocalRecentAgentsInput,
): Promise<MissionControlContextAgentSummary[]> {
  const [records, live, reviewStates, events] = await Promise.all([
    input.agentStorage.list(),
    Promise.resolve(input.agentManager.listAgents()),
    Promise.resolve(input.getReviewStates?.() ?? null),
    Promise.resolve(input.getReportEvents?.() ?? null),
  ]);
  const lifecycleById = new Map(live.map((agent) => [agent.id, agent.lifecycle]));
  const headlineByAgent = collectLatestSelfReports(events ?? []);
  const summaries: MissionControlContextAgentSummary[] = [];
  for (const record of records) {
    if (record.archivedAt || record.internal === true || hasMissionControlLabels(record.labels)) {
      continue;
    }
    const summary = summarizeRecentAgent(
      record,
      lifecycleById.get(record.id),
      reviewStates?.get(record.id)?.reviewState,
      headlineByAgent.get(record.id),
      input.serverId,
    );
    if (summary) {
      summaries.push(summary);
    }
  }
  const updatedAtMs = new Map(
    records.map((record) => {
      const parsed = Date.parse(record.updatedAt);
      return [record.id, Number.isNaN(parsed) ? 0 : parsed] as const;
    }),
  );
  summaries.sort((a, b) => (updatedAtMs.get(b.agentId) ?? 0) - (updatedAtMs.get(a.agentId) ?? 0));
  return summaries.slice(0, ROSTER_LIMIT);
}

/** Latest self-reported headline per agent, keyed by agentId. */
function collectLatestSelfReports(
  events: readonly MissionControlEvent[],
): Map<string, { headline: string; at: string }> {
  const headlineByAgent = new Map<string, { headline: string; at: string }>();
  for (const event of events) {
    if (event.source !== "self") {
      continue;
    }
    const current = headlineByAgent.get(event.agentId);
    if (!current || event.ts > current.at) {
      headlineByAgent.set(event.agentId, { headline: event.headline, at: event.ts });
    }
  }
  return headlineByAgent;
}

/** One roster row: running/ready-for-review agents only, else null. */
function summarizeRecentAgent(
  record: StoredAgentRecord,
  lifecycle: string | undefined,
  reviewState: MissionControlReviewStateValue | undefined,
  report: { headline: string; at: string } | undefined,
  serverId: string,
): MissionControlContextAgentSummary | null {
  const running = lifecycle === "running";
  const readyForReview = reviewState === "ready";
  if (!running && !readyForReview) {
    return null;
  }
  let status: string;
  if (running) {
    status = "running";
  } else if (readyForReview) {
    status = "ready for review";
  } else {
    status = lifecycle ?? record.lastStatus;
  }
  return {
    agentId: record.id,
    hostServerId: serverId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.shortDescription !== undefined ? { description: record.shortDescription } : {}),
    ...(status ? { status } : {}),
    ...(report ? { lastReportHeadline: report.headline } : {}),
    ...(report ? { lastActivityAt: report.at } : { lastActivityAt: record.updatedAt }),
  };
}

export async function buildLocalContextPayload(
  input: LocalContextInput,
): Promise<MissionControlContextPayload> {
  const [inventory, models, recentAgents] = await Promise.all([
    buildLocalInventory(input),
    buildLocalModels(input),
    buildLocalRecentAgents(input),
  ]);
  // Spec: the fleet map assembles aliases from each host's own declaration —
  // this host's missionControl.hostAlias. Never a hardcoded machine list.
  const hostAlias = input.daemonConfigStore.get().missionControl?.hostAlias?.trim() || undefined;
  return { inventory, models, recentAgents, ...(hostAlias ? { hostAlias } : {}) };
}

export interface FleetHostContext {
  hostName: string;
  serverId: string | null;
  machineName: string | null;
  alias: string | null;
  reachable: boolean;
  lastSeenAt: string | null;
  inventory: MissionControlInventory;
  models: MissionControlModels;
  recentAgents: MissionControlContextAgentSummary[];
}

export interface FleetContextData {
  hosts: FleetHostContext[];
  defaultHost: string | null;
}

export interface FleetContextDependencies {
  agentManager: Pick<AgentManager, "listAgents">;
  agentStorage: Pick<AgentStorage, "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  projectRegistry: Pick<ProjectRegistry, "list">;
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "listProviders" | "listRegisteredProviderIds"
  >;
  peerManager?: PeerManager | null | (() => PeerManager | null);
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  /**
   * Central mission-control config: the resolved config itself, a store
   * exposing get(), or a lazy accessor. Lazy so the context provider can be
   * built before the store is; absent → central defaults.
   */
  centralConfig?:
    | MissionControlCentralConfig
    | { get(): MissionControlCentralConfig }
    | (() => MissionControlCentralConfig | { get(): MissionControlCentralConfig } | null)
    | null;
  /**
   * Lazy review-state map (roster "running + review only" filter). Resolved at
   * call time so the provider can be constructed before the mission-control
   * service is; absent → every live agent is a roster candidate.
   */
  getReviewStates?: () => ReadonlyMap<string, MissionControlReviewStateRecord> | null;
  /** Lazy mission-control events, for each agent's last self-reported headline. */
  getReportEvents?: () => MissionControlEvent[] | null;
  serverId: string;
  hostName: string;
  logger: Logger;
}

function resolvePeerManager(deps: FleetContextDependencies): PeerManager | null {
  const peerManager = deps.peerManager;
  return typeof peerManager === "function" ? peerManager() : (peerManager ?? null);
}

function resolveCentralConfig(deps: FleetContextDependencies): MissionControlCentralConfig | null {
  const source = deps.centralConfig;
  if (!source) {
    return null;
  }
  if (typeof source === "function") {
    const resolved = source();
    if (resolved === null) {
      return null;
    }
    return "get" in resolved ? resolved.get() : resolved;
  }
  return "get" in source ? source.get() : source;
}

/**
 * Assembles the Commander's worldview: the local daemon's inventory/models/
 * roster plus every online peer's mission_control.context.fetch payload.
 * Unreachable peers and failed fetches degrade to empty host entries — the
 * fleet map still shows them as unreachable, never throws.
 */
export async function buildFleetContextData(
  input: FleetContextDependencies,
): Promise<FleetContextData> {
  const local = await buildLocalContextPayload(input);
  const hosts: FleetHostContext[] = [
    {
      hostName: "local",
      serverId: input.serverId,
      machineName: input.hostName,
      alias: local.hostAlias ?? null,
      reachable: true,
      lastSeenAt: null,
      ...local,
    },
  ];

  const peerManager = resolvePeerManager(input);
  for (const status of peerManager?.getPeerStatuses() ?? []) {
    const client = peerManager?.getPeerClient(status.name) ?? null;
    let payload: MissionControlContextPayload | null = null;
    if (status.state === "online" && client) {
      try {
        payload = await fetchPeerContextPayload(client);
      } catch (error) {
        input.logger.warn({ err: error, peer: status.name }, "Failed to fetch context from peer");
      }
    }
    const serverId = derivePeerServerId(payload);
    hosts.push({
      hostName: status.name,
      serverId,
      machineName: null,
      alias: payload?.hostAlias ?? null,
      reachable: payload !== null,
      lastSeenAt: status.lastSeenAt,
      inventory: payload?.inventory ?? { projects: [] },
      models: payload?.models ?? {},
      recentAgents: payload?.recentAgents ?? [],
    });
  }

  return {
    hosts,
    defaultHost: resolveDefaultDispatchHost(input, hosts),
  };
}

/**
 * Central config's defaultDispatchHost wins; the legacy per-host defaultHost
 * key stays accepted as a COMPAT fallback until it is retired.
 * COMPAT(defaultHost): added v0.3, remove once daemon floor stops sending it.
 */
function resolveDefaultDispatchHost(
  input: FleetContextDependencies,
  hosts: readonly FleetHostContext[],
): string | null {
  const central = resolveCentralConfig(input);
  let configured = central?.defaultDispatchHost ?? null;
  if (!configured) {
    configured = input.daemonConfigStore.get().missionControl?.defaultHost ?? null;
  }
  if (!configured) {
    return null;
  }
  // configured may be a serverId (settings card) — map to the host name the
  // Commander actually dispatches with.
  for (const host of hosts) {
    if (host.serverId && host.serverId === configured) {
      return host.hostName;
    }
  }
  return configured;
}

async function fetchPeerContextPayload(
  client: DaemonClient,
): Promise<MissionControlContextPayload> {
  const response = await client.missionControlContextFetch();
  return {
    inventory: response.inventory,
    models: response.models,
    recentAgents: response.recentAgents,
    ...(response.hostAlias ? { hostAlias: response.hostAlias } : {}),
  };
}

function derivePeerServerId(payload: MissionControlContextPayload | null): string | null {
  const projectServerId = payload?.inventory.projects[0]?.hostServerId;
  if (projectServerId) {
    return projectServerId;
  }
  return payload?.recentAgents[0]?.hostServerId ?? null;
}

/**
 * Renders the context-pack sections: fleet map, inventory, models+roles,
 * roster, routing defaults. Inline-sized by design — the whole fleet is ~10
 * projects / ~30 workspaces — so the Commander never queries for what the
 * daemon already knows. Delivered as the first conversation message at spawn
 * and re-injected whole after compaction/session restart.
 */
export function buildContextPack(context: FleetContextData): string {
  return [
    buildFleetMapSection(context),
    buildInventorySection(context),
    buildModelsSection(context),
    buildRosterSection(context),
    buildRoutingDefaultsSection(context),
  ].join("\n\n");
}

/**
 * The Commander's system prompt, static by construction: the bundled shipped
 * prompt (identity, playbook, safety, tool contract — no fleet state) plus the
 * central commanderInstructions. The fleet worldview never enters here; it
 * rides the context pack as the first conversation message. Two builds with
 * different fleet state produce identical output. Owned by the contract
 * module (commander-contract) so reloads re-derive the same prompt; re-exported
 * here for callers that referenced it from context.
 */
export { buildCommanderSystemPrompt } from "./commander-contract.js";

/**
 * Everything the daemon needs to launch the Commander: a static system prompt
 * and the context pack as the first conversation message. Fleet state is
 * snapshot at spawn; deltas ride digests afterwards.
 */
export async function buildCommanderLaunchConfig(
  input: FleetContextDependencies,
): Promise<{ systemPrompt: string; firstMessage: string }> {
  const central = resolveCentralConfig(input);
  const systemPrompt = buildCommanderSystemPrompt(central?.commanderInstructions ?? undefined);
  const context = await buildFleetContextData(input);
  const contextPack = buildContextPack(context);
  const firstMessage = `<paseo-system>\nFleet context snapshot:\n${contextPack.trim()}\n</paseo-system>`;
  return { systemPrompt, firstMessage };
}

// --- Context delta (digest refresh) ---

export interface ContextCanonicalEntry {
  category: "host" | "project" | "workspace" | "models" | "omp-role" | "agent";
  host: string;
  id: string;
  line: string;
}

function canonicalEntries(context: FleetContextData): ContextCanonicalEntry[] {
  const entries: ContextCanonicalEntry[] = [];
  for (const host of context.hosts) {
    entries.push({
      category: "host",
      host: host.hostName,
      id: host.hostName,
      line: `host: ${host.hostName}${host.alias ? ` (alias "${host.alias}")` : ""} — ${describeReachability(host)}`,
    });
    for (const project of host.inventory.projects) {
      const description = project.description?.trim();
      const projectLine = `project: ${project.title} (${project.id})${
        description ? ` — ${description}` : ""
      }`;
      entries.push({
        category: "project",
        host: host.hostName,
        id: project.id,
        line: projectLine,
      });
      for (const workspace of project.workspaces) {
        entries.push({
          category: "workspace",
          host: host.hostName,
          id: workspace.id,
          line: `workspace: ${workspace.title} [${workspace.kind}] ${workspace.cwd} (${workspace.id})`,
        });
      }
    }
    for (const [provider, modelIds] of Object.entries(host.models)) {
      if (provider === OMP_MODEL_ROLES_KEY) {
        continue;
      }
      entries.push({
        category: "models",
        host: host.hostName,
        id: provider,
        line: `models: ${modelIds.map((modelId) => `${provider}/${modelId}`).join(", ")}`,
      });
    }
    const roles = host.models[OMP_MODEL_ROLES_KEY];
    if (roles && roles.length > 0) {
      entries.push({
        category: "omp-role",
        host: host.hostName,
        id: OMP_MODEL_ROLES_KEY,
        line: `omp roles: ${roles.join("; ")}`,
      });
    }
    for (const agent of host.recentAgents) {
      entries.push({
        category: "agent",
        host: host.hostName,
        id: agent.agentId,
        line: `agent: ${agent.name ?? agent.title ?? agent.agentId} (${agent.agentId})`,
      });
    }
  }
  return entries;
}

function entryKey(entry: ContextCanonicalEntry): string {
  return `${entry.category}|${entry.host}|${entry.id}`;
}

export function computeContextFingerprint(context: FleetContextData): string {
  const serialized = canonicalEntries(context)
    .map((entry) => `${entry.category}|${entry.host}|${entry.id}|${entry.line}`)
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Compact "Context update:" block listing only the entries that changed
 * between two canonical snapshots; null when nothing changed. Removed entries
 * are listed with a "gone" marker so the Commander notices archives. INNER
 * content only — the digest composer wraps the whole message in exactly one
 * <paseo-system> envelope.
 */
export function buildContextDeltaBlock(
  previous: readonly ContextCanonicalEntry[],
  current: readonly ContextCanonicalEntry[],
): string | null {
  const currentByKey = new Map(current.map((entry) => [entryKey(entry), entry]));
  const previousByKey = new Map(previous.map((entry) => [entryKey(entry), entry]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [key, entry] of currentByKey) {
    const prior = previousByKey.get(key);
    if (!prior) {
      added.push(entry.line);
    } else if (prior.line !== entry.line) {
      changed.push(entry.line);
    }
  }
  for (const [key, entry] of previousByKey) {
    if (!currentByKey.has(key)) {
      removed.push(entry.line);
    }
  }

  const lines: string[] = [];
  for (const line of added) {
    lines.push(`- added ${line}`);
  }
  for (const line of changed) {
    lines.push(`- changed ${line}`);
  }
  for (const line of removed) {
    lines.push(`- gone ${line}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return `Context update:\n${lines.join("\n")}`;
}

/**
 * Digest-facing context provider: caches the fleet context (peer fetches and
 * provider warmups are not free) and emits a compact delta on the first change
 * after boot. The first call primes the baseline — the Commander launch already
 * injected the full pack — and yields no block. `fresh: true` (after omp
 * compaction or a session restart wiped the first message) returns the whole
 * snapshot again and re-baselines so the next digest is a delta again.
 */
export function createFleetContextDigestProvider(
  input: FleetContextDependencies,
): MissionControlDigestContextProvider {
  const CONTEXT_CACHE_TTL_MS = 60_000;
  let cached: { at: number; context: FleetContextData } | null = null;
  let previousEntries: ContextCanonicalEntry[] | null = null;

  async function fetchContext(): Promise<FleetContextData> {
    const now = Date.now();
    if (cached && now - cached.at < CONTEXT_CACHE_TTL_MS) {
      return cached.context;
    }
    const context = await buildFleetContextData(input);
    cached = { at: now, context };
    return context;
  }

  return {
    async deltaBlock(fresh: boolean = false): Promise<string | null> {
      const context = await fetchContext();
      const entries = canonicalEntries(context);
      if (fresh) {
        previousEntries = entries;
        return `Fleet context snapshot:\n${buildContextPack(context).trim()}`;
      }
      if (previousEntries === null) {
        previousEntries = entries;
        return null;
      }
      const block = buildContextDeltaBlock(previousEntries, entries);
      previousEntries = entries;
      return block;
    },
  };
}

// --- Section renderers ---

function buildFleetMapSection(context: FleetContextData): string {
  const lines = context.hosts.map((host) => {
    const label = host.alias ? `${host.hostName} (alias "${host.alias}")` : host.hostName;
    if (host.hostName === "local") {
      const machine = host.machineName ? ` on ${host.machineName}` : "";
      return `- ${label} — this daemon${machine}, reachable`;
    }
    return host.reachable
      ? `- ${label} — reachable`
      : `- ${label} — unreachable${host.lastSeenAt ? ` since ${formatLastSeen(host.lastSeenAt)}` : ""} (likely asleep; retry after it wakes)`;
  });
  return `# Fleet map\n${lines.join("\n")}`;
}

function buildInventorySection(context: FleetContextData): string {
  const sections: string[] = [];
  for (const host of context.hosts) {
    const label = hostLabel(host);
    if (host.inventory.projects.length === 0) {
      sections.push(`## ${label}\n- (no active projects)`);
      continue;
    }
    const projectLines = host.inventory.projects.map((project) => {
      const description = project.description?.trim();
      const header = `- ${project.title} (${project.id})${description ? ` — ${description}` : ""}`;
      if (project.workspaces.length === 0) {
        return `${header} — no workspaces`;
      }
      const workspaceLines = project.workspaces
        .map(
          (workspace) =>
            `  - ${workspace.title} [${workspace.kind}] ${workspace.cwd} (${workspace.id})`,
        )
        .join("\n");
      return `${header}\n${workspaceLines}`;
    });
    sections.push(`## ${label}\n${projectLines.join("\n")}`);
  }
  return `# Inventory\n${sections.join("\n\n")}`;
}

function buildModelsSection(context: FleetContextData): string {
  const sections = context.hosts.map((host) =>
    buildHostModelsSection(host.models, hostLabel(host)),
  );
  return `# Models\n${sections.join("\n\n")}`;
}

/**
 * One host's Models block. Every line is a verbatim invocable provider/model
 * string — exactly what create_agent/fleet_create_agent accept — plus the omp
 * modelRoles translated into the same invocable form (effort split out), and
 * roles whose model is absent from this host's provider snapshot marked
 * explicitly unavailable. A "default worker model" line (the omp `task` role,
 * invocable, with fallback when the role's model is missing) gives the
 * Commander the spawn default without derivation. Exported so tests can drive
 * the renderer directly.
 */
export function buildHostModelsSection(models: MissionControlModels, label: string): string {
  const entries = Object.entries(models).filter(([provider]) => provider !== OMP_MODEL_ROLES_KEY);
  if (entries.length === 0 && !models[OMP_MODEL_ROLES_KEY]) {
    return `## ${label}\n- (no provider snapshot)`;
  }
  const lines = entries.flatMap(([provider, modelIds]) =>
    modelIds.map((modelId) => `- ${provider}/${modelId}`),
  );
  const defaultWorkerLine = buildDefaultWorkerModelLine(models);
  if (defaultWorkerLine) {
    lines.push(defaultWorkerLine);
  }
  const roles = models[OMP_MODEL_ROLES_KEY];
  if (roles && roles.length > 0) {
    lines.push(
      "- omp modelRoles → role mappings in invocable provider/model form, exactly what create_agent/fleet_create_agent accept:",
    );
    for (const entry of roles) {
      const parsed = parseRoleEntry(entry);
      if (!parsed) {
        continue;
      }
      const { model, effort } = splitOmpEffortSuffix(parsed.model);
      const resolved = resolveRoleInvocable(models, model);
      if (resolved) {
        lines.push(
          `  - role "${parsed.role}" → ${resolved.invocable}${effort ? ` (effort: ${effort})` : ""}`,
        );
      } else {
        // The role's model is not in this host's provider snapshot: present
        // it as unavailable instead of an invocable string that would fail.
        lines.push(`  - role "${parsed.role}" → ${model} (not available on this host)`);
      }
    }
  }
  return `## ${label}\n${lines.join("\n")}`;
}

/**
 * The Commander's spawn default for a host: the omp `task` role model in
 * invocable form. When the task role's model is missing from the host's
 * snapshot (live case: role default referencing a model the host does not
 * have), fall back to the first invocable model and say so — a default the
 * Commander can actually spawn with beats an unavailable one.
 */
function buildDefaultWorkerModelLine(models: MissionControlModels): string | null {
  const firstAvailable = firstInvocableModel(models);
  const taskRole = (models[OMP_MODEL_ROLES_KEY] ?? [])
    .map(parseRoleEntry)
    .find((entry): entry is { role: string; model: string } => entry?.role === "task");
  if (!taskRole) {
    return firstAvailable ? `- default worker model: ${firstAvailable}` : null;
  }
  const { model } = splitOmpEffortSuffix(taskRole.model);
  const resolved = resolveRoleInvocable(models, model);
  if (resolved) {
    return `- default worker model: ${resolved.invocable} (omp task role)`;
  }
  if (firstAvailable) {
    return `- default worker model: ${firstAvailable} (omp task role "${model}" is not available on this host; using first available model)`;
  }
  return `- default worker model: none (omp task role "${model}" is not available on this host)`;
}

/** First invocable provider/model string in the snapshot, if any. */
function firstInvocableModel(models: MissionControlModels): string | null {
  for (const [provider, modelIds] of Object.entries(models)) {
    if (provider === OMP_MODEL_ROLES_KEY) {
      continue;
    }
    const first = modelIds[0];
    if (first) {
      return `${provider}/${first}`;
    }
  }
  return null;
}

function buildRosterSection(context: FleetContextData): string {
  const entries: Array<{ line: string; at: number }> = [];
  for (const host of context.hosts) {
    for (const agent of host.recentAgents) {
      const identity = [agent.name, agent.title].filter(Boolean).join(" — ");
      const headline = agent.lastReportHeadline?.trim();
      const detail = headline
        ? `${identity || agent.agentId}: "${headline}"`
        : identity || agent.agentId;
      const age = agent.lastActivityAt ? formatAge(agent.lastActivityAt) : null;
      const status = agent.status ?? "idle";
      const atMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : NaN;
      entries.push({
        line: `- ${detail} — ${status}${age ? `, ${age} ago` : ""} — ${hostLabel(host)} (paseo://h/${agent.hostServerId}/agent/${agent.agentId})`,
        at: Number.isNaN(atMs) ? 0 : atMs,
      });
    }
  }
  if (entries.length === 0) {
    return "# Roster\n- (no running or ready-for-review agents)";
  }
  entries.sort((left, right) => right.at - left.at);
  return `# Roster\n${entries
    .slice(0, ROSTER_LIMIT)
    .map((entry) => entry.line)
    .join("\n")}`;
}

function buildRoutingDefaultsSection(context: FleetContextData): string {
  const lines = [
    "- The user's wording always wins: when they name a host, workspace, or agent, use exactly that.",
    "- Reuse a matching existing workspace; only create when nothing matches.",
    "- Dispatch, don't discuss: state the dispatch in one line and call the tool. No plan narration, no permission-seeking for routine dispatches.",
  ];
  if (context.defaultHost) {
    lines.push(
      `- Default dispatch host (central config): "${context.defaultHost}" — use it when the user names no host.`,
    );
  } else {
    lines.push(
      "- No default dispatch host configured: choose from the fleet map by where the project lives, then capability, then load.",
    );
  }
  return `# Routing defaults\n${lines.join("\n")}`;
}

// --- Helpers ---

function formatAge(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function hostLabel(host: FleetHostContext): string {
  return host.alias ?? host.hostName;
}

function describeReachability(host: FleetHostContext): string {
  if (host.reachable) {
    return "reachable";
  }
  if (host.lastSeenAt) {
    return `unreachable since ${formatLastSeen(host.lastSeenAt)}`;
  }
  return "unreachable";
}

function formatLastSeen(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readOmpModelRoles(): Record<string, string> {
  try {
    const content = readFileSync(join(homedir(), OMP_CONFIG_RELATIVE_PATH), "utf8");
    const parsed: unknown = YAML.parse(content);
    if (!isRecord(parsed)) {
      return {};
    }
    const roles = parsed["modelRoles"];
    if (!isRecord(roles)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [role, model] of Object.entries(roles)) {
      if (typeof model === "string" && model.trim()) {
        result[role] = model;
      }
    }
    return result;
  } catch {
    // Missing or unparsable config.yml is normal on non-omp hosts.
    return {};
  }
}

/**
 * Split a stored "role: model" entry (the OMP_MODEL_ROLES_KEY format) into the
 * role name and the raw model value. Malformed entries yield null and are
 * skipped by the renderer.
 */
function parseRoleEntry(entry: string): { role: string; model: string } | null {
  const separator = entry.indexOf(": ");
  if (separator <= 0) {
    return null;
  }
  const role = entry.slice(0, separator).trim();
  const model = entry.slice(separator + 2).trim();
  return role && model ? { role, model } : null;
}

/**
 * omp's modelRoles values are the INTERNAL `provider/model:effort` form — the
 * `:effort` suffix is not part of any invocable string. Split it off (last
 * colon so model ids without a suffix pass through untouched); a missing
 * suffix means no effort annotation.
 */
function splitOmpEffortSuffix(modelValue: string): { model: string; effort: string | null } {
  const colonIndex = modelValue.lastIndexOf(":");
  if (colonIndex <= 0) {
    return { model: modelValue, effort: null };
  }
  return {
    model: modelValue.slice(0, colonIndex),
    effort: modelValue.slice(colonIndex + 1),
  };
}

/**
 * The invocable form of a role's model on a given host, or null when the model
 * is absent from that host's provider snapshot. The model list renders
 * `provider/modelId`; a role value is `family/model`. Prefer the direct
 * provider/model form when the snapshot actually has that provider+model, else
 * the provider whose model list owns the full 2-segment id — both are exactly
 * the strings create_agent/fleet_create_agent accept.
 */
function resolveRoleInvocable(
  hostModels: MissionControlModels,
  model: string,
): { invocable: string } | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex > 0) {
    const provider = model.slice(0, slashIndex);
    const modelId = model.slice(slashIndex + 1);
    if (hostModels[provider]?.includes(modelId)) {
      return { invocable: model };
    }
  }
  for (const [provider, modelIds] of Object.entries(hostModels)) {
    if (provider === OMP_MODEL_ROLES_KEY) {
      continue;
    }
    if (modelIds.includes(model)) {
      return { invocable: `${provider}/${model}` };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
