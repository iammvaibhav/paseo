import { deriveLifecycleBucket, type LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MissionControlCentralConfig,
  MissionControlContextAgentSummary,
  MissionControlEvent,
  MissionControlInventory,
  MissionControlInventoryProject,
  MissionControlInventoryProjectWorkspace,
  MissionControlModels,
  MissionControlPeerStatus,
} from "@getpaseo/protocol/mission-control/types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import type { Logger } from "pino";
import YAML from "yaml";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import type { MissionControlReviewStateRecord, MissionControlReviewStateValue } from "./store.js";
import { resolveProjectCommanderInstructions } from "../../utils/project-instructions.js";

const OMP_CONFIG_RELATIVE_PATH = join(".omp", "agent", "config.yml");
// Reserved MissionControlModels key carrying omp modelRoles (role → model) as
// "role: model" strings. The renderer prints it as the roles block, never as a
// provider's model list.
export const OMP_MODEL_ROLES_KEY = "omp.modelRoles";
// Spec: roster is one line per agent active in the last 24 hours, bucketed by
// lifecycle (running/needs-you/ready/done). Running agents always qualify
// regardless of age — a long-running worker is the hot set even when its last
// self-report is older than the window.
const ROSTER_LIMIT = 30;
const ROSTER_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MissionControlContextPayload {
  inventory: MissionControlInventory;
  models: MissionControlModels;
  recentAgents: MissionControlContextAgentSummary[];
  /** Full-fleet lifecycle bucket counts on this host — no recency window. */
  bucketCounts?: Record<string, number>;
  /** This host's own missionControl.hostAlias declaration, if set. */
  hostAlias?: string;
  /** This host's composer last-pick (daemon.composerPreferences), if set. */
  composerPreferences?: ComposerPreferences;
}

export interface LocalInventoryInput {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  projectRegistry: Pick<ProjectRegistry, "list">;
  serverId: string;
  composerPreferences?: ComposerPreferences;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
}

export interface LocalModelsInput {
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "listProviders" | "listRegisteredProviderIds"
  >;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
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
  /** Lazy stop-origin lookup. */
  getStopOrigin?: (agentId: string) => "user" | "machinery" | "system" | null;
  /** Lazy pending-proposal count lookup. */
  getPendingProposalCount?: (agentId: string) => number;
  getReportEvents?: () => MissionControlEvent[] | null;
}

export interface LocalContextInput
  extends LocalInventoryInput, LocalModelsInput, LocalRecentAgentsInput {
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  /**
   * Skip models and roster: placement routing needs only the inventory, and
   * the models list waits on provider discovery, which takes 15 s or more
   * right after a daemon boot.
   */
  inventoryOnly?: boolean;
}

/**
 * Every project and workspace on this daemon, grouped by project, with titles
 * and cwd/kind. Workspaces whose project is archived or missing get a synthetic
 * project entry so nothing on disk silently vanishes from the fleet map.
 */
interface PartitionedWorkspaces {
  workspacesByProject: Map<string, MissionControlInventoryProjectWorkspace[]>;
  orphanProjects: Map<string, MissionControlInventoryProject>;
}

function partitionInventoryWorkspaces(
  workspaces: readonly PersistedWorkspaceRecord[],
  projectById: Map<string, PersistedProjectRecord>,
  serverId: string,
): PartitionedWorkspaces {
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
      const orphan: MissionControlInventoryProject = {
        id: workspace.projectId,
        title: project?.displayName ?? workspace.displayName,
        hostServerId: serverId,
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
  return { workspacesByProject, orphanProjects };
}

async function buildInventoryProjectEntry(
  project: PersistedProjectRecord,
  serverId: string,
  workspaces: MissionControlInventoryProjectWorkspace[],
  composerPrefs?: ComposerPreferences,
): Promise<MissionControlInventoryProject> {
  const commanderInstructions =
    (await resolveProjectCommanderInstructions(project.rootPath)) ?? undefined;
  const defaultBaseBranch =
    resolveRememberedBaseBranch(composerPrefs, {
      projectKey: project.projectKey,
      projectId: project.projectId,
    }) ?? undefined;
  return {
    id: project.projectId,
    title: project.customName ?? project.displayName,
    ...(project.description ? { description: project.description } : {}),
    ...(commanderInstructions ? { commanderInstructions } : {}),
    ...(defaultBaseBranch ? { defaultBaseBranch } : {}),
    ...(project.projectKey ? { key: project.projectKey } : {}),
    rootPath: project.rootPath,
    kind: project.kind,
    hostServerId: serverId,
    workspaces,
  };
}

export async function buildLocalInventory(
  input: LocalInventoryInput,
): Promise<MissionControlInventory> {
  const [projects, workspaces] = await Promise.all([
    input.projectRegistry.list(),
    input.workspaceRegistry.list(),
  ]);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const { workspacesByProject, orphanProjects } = partitionInventoryWorkspaces(
    workspaces,
    projectById,
    input.serverId,
  );

  const composerPrefs =
    input.composerPreferences ?? input.daemonConfigStore?.get().composerPreferences;
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const projectEntries = await Promise.all(
    activeProjects.map((project) =>
      buildInventoryProjectEntry(
        project,
        input.serverId,
        workspacesByProject.get(project.projectId) ?? [],
        composerPrefs,
      ),
    ),
  );

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
  const visibleModels = input.daemonConfigStore?.get().visibleModels;
  if (visibleModels && visibleModels.length > 0) {
    const visibleSet = new Set(visibleModels);
    const filtered: MissionControlModels = {};
    for (const [provider, modelIds] of Object.entries(models)) {
      if (provider === OMP_MODEL_ROLES_KEY) {
        filtered[provider] = modelIds;
        continue;
      }
      const matching = modelIds.filter((id) => visibleSet.has(`${provider}:${id}`));
      if (matching.length > 0) {
        filtered[provider] = matching;
      }
    }
    return filtered;
  }
  return models;
}

/**
 * The local roster data: agents active in the last 24 hours (bucketed by
 * lifecycle, with identity fields, last self-reported headline, and
 * last-activity time), plus full-fleet bucket counts with NO window — the
 * snapshot states true totals even though its rows are recency-trimmed.
 * Running agents always qualify for rows (the hot set). The Commander and
 * other system-owned agents are excluded — they are not fleet work.
 */
export interface LocalRosterData {
  agents: MissionControlContextAgentSummary[];
  bucketCounts: Record<string, number>;
}

export async function buildLocalRosterData(
  input: LocalRecentAgentsInput,
): Promise<LocalRosterData> {
  const [records, live, reviewStates, events] = await Promise.all([
    input.agentStorage.list(),
    Promise.resolve(input.agentManager.listAgents()),
    Promise.resolve(input.getReviewStates?.() ?? null),
    Promise.resolve(input.getReportEvents?.() ?? null),
  ]);
  const liveById = new Map(live.map((agent) => [agent.id, agent]));
  const headlineByAgent = collectLatestSelfReports(events ?? []);
  const summaries: MissionControlContextAgentSummary[] = [];
  const bucketCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.archivedAt || record.internal === true || isSystemOwnedAgentLabels(record.labels)) {
      continue;
    }
    const liveAgent = liveById.get(record.id);
    const reviewState = reviewStates?.get(record.id)?.reviewState;
    const stopOrigin = input.getStopOrigin?.(record.id) ?? null;
    const pendingProposalCount = input.getPendingProposalCount?.(record.id) ?? 0;
    const bucket = lifecycleBucket(
      record,
      liveAgent,
      reviewState,
      stopOrigin,
      pendingProposalCount,
    );
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    const summary = summarizeRecentAgent(
      record,
      liveAgent,
      reviewState,
      headlineByAgent.get(record.id),
      input.serverId,
      stopOrigin,
      pendingProposalCount,
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
  return { agents: summaries.slice(0, ROSTER_LIMIT), bucketCounts };
}

export async function buildLocalRecentAgents(
  input: LocalRecentAgentsInput,
): Promise<MissionControlContextAgentSummary[]> {
  return (await buildLocalRosterData(input)).agents;
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

/** One roster row for an agent active in the window, bucketed by lifecycle, else null. */
function summarizeRecentAgent(
  record: StoredAgentRecord,
  live:
    | {
        lifecycle: string;
        attention?: {
          requiresAttention?: boolean;
          attentionReason?: "finished" | "error" | "permission" | null;
        };
        pendingPermissions?: { size: number };
      }
    | undefined,
  reviewState: MissionControlReviewStateValue | undefined,
  report: { headline: string; at: string } | undefined,
  serverId: string,
  stopOrigin: "user" | "machinery" | "system" | null = null,
  pendingProposalCount = 0,
): MissionControlContextAgentSummary | null {
  // The roster age is real user-visible activity: the latest self-report when
  // there is one, else the last user message. Never record.updatedAt — boot,
  // restore, and reconciliation rewrite it, so it is not "when this really
  // happened" (production rule: machinery never rewrites user-visible
  // timestamps). With neither a report nor a user message, the age is omitted
  // from the roster line rather than showing a boot-stamped one.
  const lastActivityAt = report ? report.at : record.lastUserMessageAt;
  const running = live?.lifecycle === "running" || live?.lifecycle === "initializing";
  if (!running && lastActivityAt) {
    const parsed = Date.parse(lastActivityAt);
    if (!Number.isNaN(parsed) && Date.now() - parsed > ROSTER_ACTIVITY_WINDOW_MS) {
      return null;
    }
  } else if (!running) {
    // No real-activity signal at all: not active, not in the snapshot.
    return null;
  }
  const status = lifecycleBucket(record, live, reviewState, stopOrigin, pendingProposalCount);
  return {
    agentId: record.id,
    hostServerId: serverId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.shortDescription !== undefined ? { description: record.shortDescription } : {}),
    ...(status ? { status } : {}),
    ...(report ? { lastReportHeadline: report.headline } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

/**
 * The snapshot's canonical lifecycle bucket for an agent (spec 01).
 * Computed via the protocol's canonical deriveLifecycleBucket function.
 */
function lifecycleBucket(
  record: StoredAgentRecord,
  live:
    | {
        lifecycle: string;
        attention?: {
          requiresAttention?: boolean;
          attentionReason?: "finished" | "error" | "permission" | null;
        };
        pendingPermissions?: { size: number };
      }
    | undefined,
  reviewState: MissionControlReviewStateValue | undefined,
  stopOrigin: "user" | "machinery" | "system" | null = null,
  pendingProposalCount = 0,
): LifecycleBucket {
  const pendingPermissionCount = live?.pendingPermissions?.size ?? 0;
  const attentionReason = live?.attention?.requiresAttention
    ? (live.attention.attentionReason ?? null)
    : null;
  const lastStatus = live ? live.lifecycle : (record.lastStatus ?? null);
  const running = live ? live.lifecycle === "running" || live.lifecycle === "initializing" : false;
  return deriveLifecycleBucket({
    pendingPermissionCount,
    pendingProposalCount,
    attentionReason,
    lastStatus,
    running,
    reviewState: reviewState ?? "none",
    stopOrigin,
  });
}

export async function buildLocalContextPayload(
  input: LocalContextInput,
): Promise<MissionControlContextPayload> {
  const [inventory, models, roster] = await Promise.all([
    buildLocalInventory(input),
    input.inventoryOnly ? {} : buildLocalModels(input),
    input.inventoryOnly ? { agents: [], bucketCounts: undefined } : buildLocalRosterData(input),
  ]);
  // Spec: the fleet map assembles aliases from each host's own declaration —
  // this host's missionControl.hostAlias. Never a hardcoded machine list.
  const daemonConfig = input.daemonConfigStore.get();
  const hostAlias = daemonConfig.missionControl?.hostAlias?.trim() || undefined;
  const composerPreferences = daemonConfig.composerPreferences;
  return {
    inventory,
    models,
    recentAgents: roster.agents,
    ...(roster.bucketCounts ? { bucketCounts: roster.bucketCounts } : {}),
    ...(hostAlias ? { hostAlias } : {}),
    ...(composerPreferences ? { composerPreferences } : {}),
  };
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
  /** Full-fleet bucket counts on this host; absent for old/unreachable peers. */
  bucketCounts?: Record<string, number>;
  /**
   * This host's daemon-config agent profiles (name + notes, the Commander's
   * model menu). Populated locally from daemonConfigStore — never fetched
   * over the peer wire, so a peer host only carries this when a future
   * change adds it to the context.fetch payload; absent = no profiles shown.
   */
  agentProfiles?: AgentProfile[];
}

export interface FleetContextData {
  hosts: FleetHostContext[];
  defaultHost: string | null;
  /** Resolved central Mission Control config, for section renderers that need
   *  fleet policy (e.g. per-project PR settings). Null when unavailable. */
  centralConfig: MissionControlCentralConfig | null;
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
  /** Lazy stop-origin lookup. */
  getStopOrigin?: (agentId: string) => "user" | "machinery" | "system" | null;
  /** Lazy pending-proposal count lookup. */
  getPendingProposalCount?: (agentId: string) => number;
  getReportEvents?: () => MissionControlEvent[] | null;
  serverId: string;
  hostName: string;
  logger: Logger;
  /** Every host's inventory only (see LocalContextInput.inventoryOnly). */
  inventoryOnly?: boolean;
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
      agentProfiles: input.daemonConfigStore.get().agentProfiles ?? [],
    },
  ];

  const peerManager = resolvePeerManager(input);
  const peers = await Promise.all(
    (peerManager?.getPeerStatuses() ?? []).map((status) =>
      buildPeerHostContext(input, peerManager, status),
    ),
  );
  hosts.push(...peers);

  return {
    hosts,
    defaultHost: resolveDefaultDispatchHost(input, hosts),
    centralConfig: resolveCentralConfig(input),
  };
}

async function buildPeerHostContext(
  input: FleetContextDependencies,
  peerManager: PeerManager | null,
  status: MissionControlPeerStatus,
): Promise<FleetHostContext> {
  const client = peerManager?.getPeerClient(status.name) ?? null;
  let payload: MissionControlContextPayload | null = null;
  if (status.state === "online" && client) {
    try {
      payload = await fetchPeerContextPayload(client, input.inventoryOnly === true);
    } catch (error) {
      input.logger.warn({ err: error, peer: status.name }, "Failed to fetch context from peer");
    }
  }
  return {
    hostName: status.name,
    serverId: derivePeerServerId(payload),
    machineName: null,
    alias: payload?.hostAlias ?? null,
    reachable: payload !== null,
    lastSeenAt: status.lastSeenAt,
    inventory: payload?.inventory ?? { projects: [] },
    models: payload?.models ?? {},
    recentAgents: payload?.recentAgents ?? [],
    ...(payload?.bucketCounts ? { bucketCounts: payload.bucketCounts } : {}),
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
  inventoryOnly: boolean,
): Promise<MissionControlContextPayload> {
  const response = await client.missionControlContextFetch({ inventoryOnly });
  return {
    inventory: response.inventory,
    models: response.models,
    recentAgents: response.recentAgents,
    ...(response.bucketCounts ? { bucketCounts: response.bucketCounts } : {}),
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

// --- Section renderers ---

export interface DefaultWorkerModelResolution {
  /** The invocable provider/model string to spawn with, or null when the host has none. */
  invocable: string | null;
  /** How the default was derived, for the snapshot line's parenthetical. */
  note: string | null;
}

/**
 * The Commander's spawn default for a host: the composer's remembered last
 * provider/model pick (daemon.composerPreferences, global-only like the app's
 * resolveEffectiveFormPreferences) in invocable form, falling back to the omp
 * `task` role model. When the task role's model is missing from the host's
 * snapshot (live case: role default referencing a model the host does not
 * have), fall back to the first
 * invocable model — a default the Commander can actually spawn with beats an
 * unavailable one. Structured so the world snapshot renderer and the
 * fleet_list_models catalog tool share ONE derivation (exported for
 * paseo-tools and tests).
 */
export function resolveDefaultWorkerModel(
  models: MissionControlModels,
  composerPreferences?: ComposerPreferences | null,
  scope?: { workspaceId?: string | null; projectKey?: string | null } | null,
): DefaultWorkerModelResolution {
  const composerPick = resolveComposerDefaultModel(composerPreferences, scope);
  if (composerPick) {
    return { invocable: composerPick, note: "composer last pick" };
  }
  const firstAvailable = firstInvocableModel(models);
  const taskRole = (models[OMP_MODEL_ROLES_KEY] ?? [])
    .map(parseRoleEntry)
    .find((entry): entry is { role: string; model: string } => entry?.role === "task");
  if (!taskRole) {
    return { invocable: firstAvailable, note: null };
  }
  const { model } = splitOmpEffortSuffix(taskRole.model);
  const resolved = resolveRoleInvocable(models, model);
  if (resolved) {
    return { invocable: resolved.invocable, note: "omp task role" };
  }
  if (firstAvailable) {
    return {
      invocable: firstAvailable,
      note: `omp task role "${model}" is not available on this host; using first available model`,
    };
  }
  return { invocable: null, note: `omp task role "${model}" is not available on this host` };
}

/**
 * The composer's remembered pick as an invocable `${provider}/${model}` string,
 * or null when there is none. Global-only: scoped copies are legacy dead
 * weight and never override the host's last pick.
 */
function composerScopeSelection(
  preferences: ComposerPreferences,
  scope: { workspaceId?: string | null; projectKey?: string | null } | null | undefined,
) {
  const workspaceId = scope?.workspaceId?.trim() || "";
  const projectKey = scope?.projectKey?.trim() || "";
  return {
    workspace: workspaceId ? preferences.byWorkspace?.[workspaceId] : undefined,
    project: projectKey ? preferences.byProject?.[projectKey] : undefined,
  };
}

/**
 * The composer's remembered baseBranch for a scope (workspace -> project -> global).
 */
export function resolveRememberedBaseBranch(
  preferences: ComposerPreferences | null | undefined,
  scope?: {
    workspaceId?: string | null;
    projectKey?: string | null;
    projectId?: string | null;
  } | null,
): string | null {
  if (!preferences) {
    return null;
  }
  const { workspace, project } = composerScopeSelection(preferences, scope);
  const projectIdScope = scope?.projectId ? preferences.byProject?.[scope.projectId] : undefined;
  const rawBranch =
    workspace?.baseBranch ??
    project?.baseBranch ??
    projectIdScope?.baseBranch ??
    preferences.baseBranch;
  return typeof rawBranch === "string" && rawBranch.trim().length > 0 ? rawBranch.trim() : null;
}

function resolveComposerDefaultModel(
  preferences: ComposerPreferences | null | undefined,
  _scope: { workspaceId?: string | null; projectKey?: string | null } | null | undefined,
): string | null {
  if (!preferences) {
    return null;
  }
  // Model selection is global-only: scoped copies are legacy dead weight and
  // never override the host's last pick.
  const provider = preferences.provider;
  if (!provider) {
    return null;
  }
  const model = preferences.providerPreferences?.[provider]?.model;
  if (!model) {
    return null;
  }
  return `${provider}/${model}`;
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

// --- Helpers ---

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
