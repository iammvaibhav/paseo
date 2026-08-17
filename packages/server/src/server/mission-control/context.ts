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
} from "@getpaseo/protocol/mission-control/types";
import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import type { Logger } from "pino";
import YAML from "yaml";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { buildCommanderSystemPrompt } from "./commander-contract.js";
import type { MissionControlReviewStateRecord, MissionControlReviewStateValue } from "./store.js";

const OMP_CONFIG_RELATIVE_PATH = join(".omp", "agent", "config.yml");
// Reserved MissionControlModels key carrying omp modelRoles (role → model) as
// "role: model" strings. The renderer prints it as the roles block, never as a
// provider's model list.
const OMP_MODEL_ROLES_KEY = "omp.modelRoles";
// Spec: roster is one line per agent active in the last 24 hours, bucketed by
// lifecycle (running/needs-you/ready/done). Running agents always qualify
// regardless of age — a long-running worker is the hot set even when its last
// self-report is older than the window.
const ROSTER_LIMIT = 30;
const ROSTER_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
// The world snapshot's stamp line; the snapshot injector retracts the previous
// snapshot row by matching rows that carry this marker.
export const WORLD_SNAPSHOT_MARKER = "# Fleet state as of ";

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
  /** Lazy stop-origin lookup. */
  getStopOrigin?: (agentId: string) => "user" | "machinery" | "system" | null;
  /** Lazy pending-proposal count lookup. */
  getPendingProposalCount?: (agentId: string) => number;
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
    buildLocalModels(input),
    buildLocalRosterData(input),
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
    bucketCounts: roster.bucketCounts,
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
  /** Lazy stop-origin lookup. */
  getStopOrigin?: (agentId: string) => "user" | "machinery" | "system" | null;
  /** Lazy pending-proposal count lookup. */
  getPendingProposalCount?: (agentId: string) => number;
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
      ...(payload?.bucketCounts ? { bucketCounts: payload.bucketCounts } : {}),
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

/**
 * The world snapshot: a compact fleet-state block computed at turn start and
 * injected before every Commander turn (docs/commander.md "Runtime model").
 * Never accreted, never deltas — the snapshot is regenerated fresh each turn
 * and the previous snapshot row is superseded in place by the injector.
 */
export interface WorldSnapshot {
  /** Generation time (ISO). Also stamped into the block's header line. */
  at: string;
  /** The compact block, headed by `# Fleet state as of <at>`. */
  block: string;
}

/**
 * Assemble the world snapshot: fleet map (hosts + aliases), project/workspace
 * index with descriptions, last-24h agents bucketed by lifecycle, invocable
 * models, and routing defaults — a few KB, computed at delivery, stamped with
 * its generation time. Renders the same sections the launch-time context pack
 * used, minus the digest-era delta machinery.
 */
export async function buildWorldSnapshot(input: FleetContextDependencies): Promise<WorldSnapshot> {
  const at = new Date().toISOString();
  const context = await buildFleetContextData(input);
  return { at, block: buildSnapshotBlock(context, at) };
}

/**
 * Renders the world-snapshot sections: fleet map, inventory, roster, models+
 * roles, routing defaults, headed by the generation stamp. Inline-sized by
 * design — the whole fleet is ~10 projects / ~30 workspaces — so the Commander
 * never queries for what the daemon already knows. The header line carries
 * WORLD_SNAPSHOT_MARKER so the injector can identify snapshot rows for
 * supersede-in-place retraction.
 */
export function buildSnapshotBlock(context: FleetContextData, at: string): string {
  return [
    `${WORLD_SNAPSHOT_MARKER}${at}`,
    buildFleetMapSection(context),
    buildInventorySection(context),
    buildRosterSection(context),
    buildModelsSection(context),
    buildRoutingDefaultsSection(context),
  ].join("\n\n");
}

/**
 * The Commander's system prompt, static by construction: the bundled shipped
 * prompt (identity, playbook, safety, tool contract — no fleet state) plus the
 * central commanderInstructions. The fleet worldview never enters here; it
 * rides the launch snapshot as the first conversation message. Two builds with
 * different fleet state produce identical output. Owned by the contract
 * module (commander-contract) so reloads re-derive the same prompt; re-exported
 * here for callers that referenced it from context.
 */
export { buildCommanderSystemPrompt } from "./commander-contract.js";

/**
 * Everything the daemon needs to launch the Commander: a static system prompt
 * and the launch world snapshot as the first conversation message. Fleet state
 * is snapshot at spawn; every later turn re-injects a fresh snapshot through
 * the same <paseo-system> machinery path.
 */
export async function buildCommanderLaunchConfig(
  input: FleetContextDependencies,
): Promise<{ systemPrompt: string; firstMessage: string }> {
  const central = resolveCentralConfig(input);
  const systemPrompt = buildCommanderSystemPrompt(central?.commanderInstructions ?? undefined);
  const { block } = await buildWorldSnapshot(input);
  const firstMessage = `<paseo-system>\n${block.trim()}\n</paseo-system>`;
  return { systemPrompt, firstMessage };
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

export interface DefaultWorkerModelResolution {
  /** The invocable provider/model string to spawn with, or null when the host has none. */
  invocable: string | null;
  /** How the default was derived, for the snapshot line's parenthetical. */
  note: string | null;
}

/**
 * The Commander's spawn default for a host: the composer's remembered last
 * provider/model pick (daemon.composerPreferences, resolved workspace →
 * project → global like the app's resolveEffectiveFormPreferences) in
 * invocable form, falling back to the omp `task` role model. When the task
 * role's model is missing from the host's snapshot (live case: role default
 * referencing a model the host does not have), fall back to the first
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
 * or null when there is none. Mirrors the app's resolveEffectiveFormPreferences
 * scope resolution for provider + providerPreferences: workspace wins over
 * project wins over the global fallback, per provider.
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

function resolveComposerDefaultModel(
  preferences: ComposerPreferences | null | undefined,
  scope: { workspaceId?: string | null; projectKey?: string | null } | null | undefined,
): string | null {
  if (!preferences) {
    return null;
  }
  const { workspace, project } = composerScopeSelection(preferences, scope);
  const provider = workspace?.provider ?? project?.provider ?? preferences.provider;
  if (!provider) {
    return null;
  }
  const model =
    workspace?.providerPreferences?.[provider]?.model ??
    project?.providerPreferences?.[provider]?.model ??
    preferences.providerPreferences?.[provider]?.model;
  if (!model) {
    return null;
  }
  return `${provider}/${model}`;
}

function buildDefaultWorkerModelLine(models: MissionControlModels): string | null {
  const { invocable, note } = resolveDefaultWorkerModel(models);
  if (!invocable) {
    return note ? `- default worker model: none (${note})` : null;
  }
  return note
    ? `- default worker model: ${invocable} (${note})`
    : `- default worker model: ${invocable}`;
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

/** Roster status labels for the world snapshot (spec 01 bucket wording). */
const ROSTER_STATUS_LABELS: Record<string, string> = {
  needs_you: "needs you",
  ready: "ready for review",
};

/**
 * Fleet-truth bucket totals summed over every reachable host that reports
 * them (no recency window), rendered ahead of the windowed roster rows so
 * the Commander never states a windowed count as the fleet total.
 */
function buildBucketTotalsLine(context: FleetContextData): string | null {
  const totals: Record<string, number> = {};
  let reported = false;
  for (const host of context.hosts) {
    if (!host.bucketCounts) {
      continue;
    }
    reported = true;
    for (const [bucket, count] of Object.entries(host.bucketCounts)) {
      totals[bucket] = (totals[bucket] ?? 0) + count;
    }
  }
  if (!reported) {
    return null;
  }
  const parts = ["needs_you", "running", "ready", "done", "idle"]
    .filter((bucket) => (totals[bucket] ?? 0) > 0)
    .map((bucket) => `${ROSTER_STATUS_LABELS[bucket] ?? bucket} ${totals[bucket]}`);
  return `- Fleet totals (full retention): ${parts.length > 0 ? parts.join(", ") : "none"}`;
}

function buildRosterSection(context: FleetContextData): string {
  const totalsLine = buildBucketTotalsLine(context);
  const entries: Array<{ line: string; at: number }> = [];
  for (const host of context.hosts) {
    for (const agent of host.recentAgents) {
      const identity = [agent.name, agent.title].filter(Boolean).join(" — ");
      const headline = agent.lastReportHeadline?.trim();
      const detail = headline
        ? `${identity || agent.agentId}: "${headline}"`
        : identity || agent.agentId;
      const age = agent.lastActivityAt ? formatAge(agent.lastActivityAt) : null;
      const rawStatus = agent.status ?? "idle";
      const status = ROSTER_STATUS_LABELS[rawStatus] ?? rawStatus;
      const atMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : NaN;
      entries.push({
        line: `- ${detail} — ${status}${age ? `, ${age} ago` : ""} — ${hostLabel(host)} (paseo://h/${agent.hostServerId}/agent/${agent.agentId})`,
        at: Number.isNaN(atMs) ? 0 : atMs,
      });
    }
  }
  const header = totalsLine ? `# Roster\n${totalsLine}` : "# Roster";
  if (entries.length === 0) {
    return totalsLine
      ? `${header}\n- (no agents active in the last 24h; totals above are the full fleet)`
      : `${header}\n- (no running or ready-for-review agents)`;
  }
  entries.sort((left, right) => right.at - left.at);
  return `${header}\n${entries
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
