import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "@getpaseo/client";
import type {
  MissionControlContextAgentSummary,
  MissionControlInventory,
  MissionControlInventoryProject,
  MissionControlInventoryProjectWorkspace,
  MissionControlModels,
} from "@getpaseo/protocol/mission-control/types";
import type { Logger } from "pino";
import YAML from "yaml";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { hasMissionControlLabels } from "./naming.js";
import type { MissionControlDigestContextProvider } from "./digest.js";

const OMP_CONFIG_RELATIVE_PATH = join(".omp", "agent", "config.yml");
// Reserved MissionControlModels key carrying omp modelRoles (role → model) as
// "role: model" strings. The renderer prints it as the roles block, never as a
// provider's model list.
const OMP_MODEL_ROLES_KEY = "omp.modelRoles";
const ROSTER_LIMIT = 100;

export interface MissionControlContextPayload {
  inventory: MissionControlInventory;
  models: MissionControlModels;
  recentAgents: MissionControlContextAgentSummary[];
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
}

export interface LocalContextInput
  extends LocalInventoryInput, LocalModelsInput, LocalRecentAgentsInput {}

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
 * Recent and running agents with their identity fields (name/title/living
 * description), for the Commander's roster. The Commander and other
 * mission-control-labeled agents are excluded — they are not fleet work.
 */
export async function buildLocalRecentAgents(
  input: LocalRecentAgentsInput,
): Promise<MissionControlContextAgentSummary[]> {
  const [records, live] = await Promise.all([
    input.agentStorage.list(),
    Promise.resolve(input.agentManager.listAgents()),
  ]);
  const lifecycleById = new Map(live.map((agent) => [agent.id, agent.lifecycle]));
  const summaries: MissionControlContextAgentSummary[] = [];
  for (const record of records) {
    if (record.archivedAt || record.internal === true || hasMissionControlLabels(record.labels)) {
      continue;
    }
    const status = lifecycleById.get(record.id) ?? record.lastStatus;
    summaries.push({
      agentId: record.id,
      hostServerId: input.serverId,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.title !== undefined ? { title: record.title } : {}),
      ...(record.shortDescription !== undefined ? { description: record.shortDescription } : {}),
      ...(status ? { status } : {}),
    });
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

export async function buildLocalContextPayload(
  input: LocalContextInput,
): Promise<MissionControlContextPayload> {
  const [inventory, models, recentAgents] = await Promise.all([
    buildLocalInventory(input),
    buildLocalModels(input),
    buildLocalRecentAgents(input),
  ]);
  return { inventory, models, recentAgents };
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
  serverId: string;
  hostName: string;
  logger: Logger;
}

function resolvePeerManager(deps: FleetContextDependencies): PeerManager | null {
  const peerManager = deps.peerManager;
  return typeof peerManager === "function" ? peerManager() : (peerManager ?? null);
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
  const missionControl = input.daemonConfigStore.get().missionControl;
  const hostAliases = missionControl?.hostAliases ?? {};

  const local = await buildLocalContextPayload(input);
  const hosts: FleetHostContext[] = [
    {
      hostName: "local",
      serverId: input.serverId,
      machineName: input.hostName,
      alias: resolveHostAlias("local", input.serverId, hostAliases),
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
      alias: resolveHostAlias(status.name, serverId, hostAliases),
      reachable: payload !== null,
      lastSeenAt: status.lastSeenAt,
      inventory: payload?.inventory ?? { projects: [] },
      models: payload?.models ?? {},
      recentAgents: payload?.recentAgents ?? [],
    });
  }

  return {
    hosts,
    defaultHost: resolveDefaultDispatchHost(missionControl?.defaultHost ?? null, hosts),
  };
}

/**
 * Aliases are keyed by fleet host name (peer config name / "local") per the
 * spec, but the app's settings card can only enumerate hosts by serverId, so a
 * serverId key resolves to the same alias.
 */
function resolveHostAlias(
  hostName: string,
  serverId: string | null,
  hostAliases: Record<string, string>,
): string | null {
  if (hostAliases[hostName]) {
    return hostAliases[hostName];
  }
  if (serverId && hostAliases[serverId]) {
    return hostAliases[serverId];
  }
  return null;
}

/**
 * defaultHost may be a fleet host name ("local" or a peer config name) or — when
 * the settings card saved it — a serverId; map serverIds to the host name the
 * Commander actually dispatches with.
 */
function resolveDefaultDispatchHost(
  configured: string | null,
  hosts: readonly FleetHostContext[],
): string | null {
  if (!configured) {
    return null;
  }
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
 * Renders the six context-pack sections: fleet map, inventory, models+roles,
 * roster, playbook, smart defaults. Inline-sized by design — the whole fleet is
 * ~10 projects / ~30 workspaces — so the Commander never queries for what the
 * daemon already knows.
 */
export function buildContextPack(context: FleetContextData): string {
  return [
    buildFleetMapSection(context),
    buildInventorySection(context),
    buildModelsSection(context),
    buildRosterSection(context),
    buildPlaybookSection(),
    buildSmartDefaultsSection(context),
  ].join("\n\n");
}

/**
 * The Commander's replaced system prompt: the shipped/user contract (persona +
 * CAN/CANNOT) followed by the full context pack. This is the strong enforcement
 * layer; the digest reminder line restates the contract on every digest.
 */
export function buildCommanderSystemPrompt(contract: string, contextPack: string): string {
  return `${contract.trim()}\n\n${contextPack.trim()}`;
}

export async function buildCommanderLaunchSystemPrompt(
  input: FleetContextDependencies & { contract: string },
): Promise<string> {
  const context = await buildFleetContextData(input);
  return buildCommanderSystemPrompt(input.contract, buildContextPack(context));
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
      entries.push({
        category: "project",
        host: host.hostName,
        id: project.id,
        line: `project: ${project.title} (${project.id})`,
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
        line: `models: ${provider}: ${modelIds.join(", ")}`,
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
 * Compact "<paseo-system> Context update:" block listing only the entries that
 * changed between two canonical snapshots; null when nothing changed. Removed
 * entries are listed with a "gone" marker so the Commander notices archives.
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
  return `<paseo-system> Context update:\n${lines.join("\n")}`;
}

/**
 * Digest-facing delta provider: caches the fleet context (peer fetches and
 * provider warmups are not free) and emits a compact delta on the first change
 * after boot. The first call primes the baseline — the Commander launch already
 * injected the full pack — and yields no block.
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
    async deltaBlock(): Promise<string | null> {
      const context = await fetchContext();
      const entries = canonicalEntries(context);
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
      if (project.workspaces.length === 0) {
        return `- ${project.title} (${project.id}) — no workspaces`;
      }
      const workspaceLines = project.workspaces
        .map(
          (workspace) =>
            `  - ${workspace.title} [${workspace.kind}] ${workspace.cwd} (${workspace.id})`,
        )
        .join("\n");
      return `- ${project.title} (${project.id})\n${workspaceLines}`;
    });
    sections.push(`## ${label}\n${projectLines.join("\n")}`);
  }
  return `# Inventory\n${sections.join("\n\n")}`;
}

function buildModelsSection(context: FleetContextData): string {
  const sections: string[] = [];
  for (const host of context.hosts) {
    const label = hostLabel(host);
    const entries = Object.entries(host.models).filter(
      ([provider]) => provider !== OMP_MODEL_ROLES_KEY,
    );
    if (entries.length === 0 && !host.models[OMP_MODEL_ROLES_KEY]) {
      sections.push(`## ${label}\n- (no provider snapshot)`);
      continue;
    }
    const lines = entries.map(([provider, modelIds]) => `- ${provider}: ${modelIds.join(", ")}`);
    const roles = host.models[OMP_MODEL_ROLES_KEY];
    if (roles && roles.length > 0) {
      lines.push(`- omp modelRoles: ${roles.join("; ")}`);
    }
    sections.push(`## ${label}\n${lines.join("\n")}`);
  }
  return `# Models\n${sections.join("\n\n")}`;
}

function buildRosterSection(context: FleetContextData): string {
  const lines: string[] = [];
  for (const host of context.hosts) {
    for (const agent of host.recentAgents) {
      const identity = [agent.name, agent.title].filter(Boolean).join(" — ");
      const detail = [identity || agent.agentId, agent.description].filter(Boolean).join(": ");
      lines.push(
        `- ${detail} — ${hostLabel(host)}${agent.status ? `, ${agent.status}` : ""} (paseo://h/${agent.hostServerId}/agent/${agent.agentId})`,
      );
    }
  }
  if (lines.length === 0) {
    return "# Roster\n- (no recent agents)";
  }
  return `# Roster\n${lines.join("\n")}`;
}

function buildPlaybookSection(): string {
  return `# Playbook
You dispatch and report; you never implement. Exact invocations:
- Task on a specific host: fleet_create_agent({ host: "<host>", provider: "<provider>/<model>", cwd: "<abs path>", initialPrompt: "<task>" }). host is "local" or a peer name from the fleet map; cwd or workspaceId is required for peer hosts. Set notifyOnFinish-style reporting: tell the worker what proof to return.
- Task on this daemon: create_agent({ provider: "<provider>/<model>", initialPrompt: "<task>" }) — no workspaceId creates a fresh workspace for it.
- New isolated task: create_workspace({ isolation: "worktree", path: "<repo>", title: "<short name>" }) — defaults to branch-off from the default branch; the new worktree is off main/master. Dispatch the agent into it.
- Continue an existing agent: send_agent_prompt({ agentId: "<id>", prompt: "<follow-up>" }) on this daemon, or fleet_send_prompt({ host: "<host>", agentId: "<id>", prompt: "<follow-up>" }) on a peer. Same agent, same context — use for continuations of that task.
- New project from a GitHub link: if the repo is already cloned on the target host, create_workspace({ isolation: "local", path: "<checkout>", title: "<project>" }), then create_agent in that workspace. If it is not cloned, dispatch an agent on the target host to clone it first, then create_workspace, then create_agent.
- Fork vs continue vs fresh: continue the same agent when it is the same task; fork (create_agent/fleet_create_agent with a brief that summarizes the prior context) when the new task shares context but differs; fresh agent when the task needs no prior context.
- Prefer reusing an existing matching workspace over creating a new one.`;
}

function buildSmartDefaultsSection(context: FleetContextData): string {
  const lines = [
    "- The user's wording always wins: when they name a host, workspace, or agent, use exactly that.",
    "- Reuse a matching existing workspace; only create when nothing matches.",
    "- Dispatch, don't discuss: state the dispatch in one line and call the tool. No plan narration, no permission-seeking for routine dispatches.",
  ];
  if (context.defaultHost) {
    lines.push(
      `- Default dispatch host (missionControl.defaultHost): "${context.defaultHost}" — use it when the user names no host.`,
    );
  } else {
    lines.push(
      "- No default dispatch host configured: choose from the fleet map by where the project lives, then capability, then load.",
    );
  }
  return `# Smart defaults\n${lines.join("\n")}`;
}

// --- Helpers ---

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
