import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { WorkspaceRegistry, ProjectRegistry } from "../workspace-registry.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { MissionControlService } from "./service.js";
import type { FleetContextData } from "./context.js";
import type {
  MissionControlContextAgentSummary,
  MissionControlInventory,
} from "@getpaseo/protocol/mission-control/types";

export type FleetIdKind = "agent" | "workspace" | "project" | "proposal";

export type FleetIdResolution =
  | { kind: FleetIdKind; host: string }
  | { kind: "unknown"; guidance: string };

export interface PeerSnapshotEntry {
  peerName: string;
  fetchedAt: number;
  workspaces: Set<string>;
  projects: Set<string>;
  agents: Set<string>;
}

export interface FleetIdIndexDependencies {
  agentStorage?: Pick<AgentStorage, "list" | "get">;
  agentManager?: Pick<AgentManager, "listAgents" | "getAgent"> | null;
  workspaceRegistry?: Pick<WorkspaceRegistry, "list" | "get"> | null;
  projectRegistry?: Pick<ProjectRegistry, "list" | "get"> | null;
  missionControlService?: Pick<MissionControlService, "getProposal" | "listProposals"> | null;
  peerManager?: PeerManager | null;
  fleetContext?: () => Promise<FleetContextData>;
  logger?: Logger;
}

/** A local registry whose entries can be probed by id (workspace/project
 * registries, the live agent manager, and agent storage all satisfy this
 * shape through their get/list or getAgent/listAgents methods). */
interface LocalRegistryLookup {
  get?: (id: string) => unknown;
  list?: () => readonly unknown[] | Promise<readonly unknown[]>;
  getAgent?: (id: string) => unknown;
  listAgents?: () => readonly unknown[] | Promise<readonly unknown[]>;
}

export function inferIdKind(id: string): FleetIdKind {
  if (id.startsWith("wks_")) {
    return "workspace";
  }
  if (id.startsWith("prj_")) {
    return "project";
  }
  if (id.startsWith("mcp_")) {
    return "proposal";
  }
  return "agent";
}

export function formatShortId(id: string): string {
  if (id.length > 8) {
    return `${id.slice(0, 4)}…`;
  }
  return id;
}

export class FleetIdIndex {
  private readonly peerSnapshots = new Map<string, PeerSnapshotEntry>();
  private readonly deps: FleetIdIndexDependencies;
  private readonly logger: Logger | undefined;

  constructor(deps: FleetIdIndexDependencies) {
    this.deps = deps;
    this.logger = deps.logger?.child({ module: "mission-control", component: "fleet-id-index" });
  }

  /**
   * Resolve an id to its owning host ("local" for this daemon, or the peer name).
   * Resolution order:
   * 1. Local registries (live)
   * 2. Cached peer snapshots
   * 3. On miss: refresh peer snapshots once and retry
   * 4. Still missing: return unknown with guidance naming unreachable peers and resolver tool
   */
  async resolveFleetId(id: string): Promise<FleetIdResolution> {
    const trimmedId = id.trim();
    if (!trimmedId) {
      return {
        kind: "unknown",
        guidance: "id is empty. Call fleet_list_agents or fleet_list_inventory to resolve.",
      };
    }

    // 1. Local registries check
    const localMatch = await this.resolveLocal(trimmedId);
    if (localMatch) {
      return localMatch;
    }

    // 2. Cached peer snapshots check
    const cachedMatch = this.resolveFromPeerSnapshots(trimmedId);
    if (cachedMatch) {
      return cachedMatch;
    }

    // 3. Miss handling: refresh peer snapshots once and retry
    await this.refreshPeerSnapshots();

    // Re-check local in case created recently
    const localRetry = await this.resolveLocal(trimmedId);
    if (localRetry) {
      return localRetry;
    }

    // Re-check refreshed peer snapshots
    const refreshedMatch = this.resolveFromPeerSnapshots(trimmedId);
    if (refreshedMatch) {
      return refreshedMatch;
    }

    // 4. Return unknown with guidance
    return {
      kind: "unknown",
      guidance: this.buildUnknownGuidance(trimmedId),
    };
  }

  /** Invalidate cached peer snapshots. */
  invalidate(): void {
    this.peerSnapshots.clear();
  }

  /** Manually record or seed a peer snapshot. */
  recordPeerSnapshot(entry: PeerSnapshotEntry): void {
    this.peerSnapshots.set(entry.peerName, entry);
  }

  private async resolveLocal(id: string): Promise<{ kind: FleetIdKind; host: string } | null> {
    // Proposal check
    if (id.startsWith("mcp_")) {
      const proposal = this.deps.missionControlService?.getProposal?.(id);
      if (proposal || this.deps.missionControlService?.listProposals?.().some((p) => p.id === id)) {
        return { kind: "proposal", host: "local" };
      }
      // If starts with mcp_ and no service or not found, still proposal family on commander host
      if (!this.deps.missionControlService) {
        return { kind: "proposal", host: "local" };
      }
    }

    // Workspace check
    if (
      await this.matchesLocalRegistry(
        id,
        this.deps.workspaceRegistry,
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "workspaceId" in entry &&
          entry.workspaceId === id,
        "workspace",
      )
    ) {
      return { kind: "workspace", host: "local" };
    }

    // Project check
    if (
      await this.matchesLocalRegistry(
        id,
        this.deps.projectRegistry,
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "projectId" in entry &&
          entry.projectId === id,
        "project",
      )
    ) {
      return { kind: "project", host: "local" };
    }

    // Agent check (live first, then storage)
    if (
      await this.matchesLocalRegistry(
        id,
        this.deps.agentManager,
        (entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === id,
        "live agent manager",
      )
    ) {
      return { kind: "agent", host: "local" };
    }

    if (
      await this.matchesLocalRegistry(
        id,
        this.deps.agentStorage,
        (entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === id,
        "agent storage",
      )
    ) {
      return { kind: "agent", host: "local" };
    }

    return null;
  }

  /** Whether any entry of a local registry matches the id. The registry may
   * be absent (no check), and a registry hiccup degrades to "no match" — the
   * resolution falls through to peers / unknown guidance instead of throwing. */
  private async matchesLocalRegistry(
    id: string,
    registry: LocalRegistryLookup | null | undefined,
    matches: (entry: unknown) => boolean,
    label: string,
  ): Promise<boolean> {
    if (!registry) {
      return false;
    }
    try {
      // `registry.get ?? registry.getAgent` yields a VALUE whose receiver is
      // lost — invoking it directly binds `this` to undefined and every class
      // method (this.load / this.agents) throws. Call through `.call(registry)`
      // so the real registry/manager/storage instances resolve correctly.
      const lookup = registry.get ?? registry.getAgent;
      if (typeof lookup === "function") {
        const direct = await lookup.call(registry, id);
        if (direct) {
          return true;
        }
      }
      const list = registry.list ?? registry.listAgents;
      if (typeof list === "function") {
        const entries = await list.call(registry);
        if (entries && entries.some(matches)) {
          return true;
        }
      }
    } catch (err) {
      this.logger?.debug({ err, id }, `Error querying local ${label} registry`);
    }
    return false;
  }

  private resolveFromPeerSnapshots(id: string): { kind: FleetIdKind; host: string } | null {
    for (const [peerName, snapshot] of this.peerSnapshots.entries()) {
      if (snapshot.agents.has(id)) {
        return { kind: "agent", host: peerName };
      }
      if (snapshot.workspaces.has(id)) {
        return { kind: "workspace", host: peerName };
      }
      if (snapshot.projects.has(id)) {
        return { kind: "project", host: peerName };
      }
    }
    return null;
  }

  /** Aggregates a peer host's inventory + recent agents into a snapshot entry
   * (projects, their workspaces, and agent ids as sets). Shared by the fleet
   * context path and the peer-client payload path so both keep the identical
   * projection. */
  private buildPeerSnapshot(
    peerName: string,
    fetchedAt: number,
    inventory: MissionControlInventory | undefined,
    recentAgents: MissionControlContextAgentSummary[] | undefined,
  ): PeerSnapshotEntry {
    const workspaces = new Set<string>();
    const projects = new Set<string>();
    const agents = new Set<string>();

    for (const project of inventory?.projects ?? []) {
      projects.add(project.id);
      for (const workspace of project.workspaces ?? []) {
        workspaces.add(workspace.id);
      }
    }

    for (const agent of recentAgents ?? []) {
      agents.add(agent.agentId);
    }

    return { peerName, fetchedAt, workspaces, projects, agents };
  }

  /** Aggregate a peer's context + agent-list payloads into one snapshot entry. */
  private aggregatePeerSnapshot(
    peerName: string,
    now: number,
    contextPayload: {
      inventory?: MissionControlInventory;
      recentAgents?: MissionControlContextAgentSummary[];
    } | null,
    agentEntries: Array<{ agent?: { id?: string } }>,
  ): PeerSnapshotEntry {
    const workspaces = new Set<string>();
    const projects = new Set<string>();
    const agents = new Set<string>();
    for (const project of contextPayload?.inventory?.projects ?? []) {
      projects.add(project.id);
      for (const workspace of project.workspaces ?? []) {
        workspaces.add(workspace.id);
      }
    }
    for (const entry of agentEntries) {
      if (entry?.agent?.id) {
        agents.add(entry.agent.id);
      }
    }
    for (const agent of contextPayload?.recentAgents ?? []) {
      if (agent?.agentId) {
        agents.add(agent.agentId);
      }
    }
    return { peerName, fetchedAt: now, workspaces, projects, agents };
  }

  /** Refresh one online peer's snapshot from its context + full agent list. */
  private async refreshOnePeerSnapshot(peerName: string, now: number): Promise<void> {
    const client = this.deps.peerManager?.getPeerClient(peerName);
    if (!client) {
      return;
    }
    try {
      const [contextPayload, agentsPayload] = await Promise.all([
        client.missionControlContextFetch().catch(() => null),
        typeof client.fetchAgents === "function"
          ? client
              .fetchAgents({ filter: { includeArchived: true }, page: { limit: 200 } })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      const entries = Array.isArray(agentsPayload?.entries) ? agentsPayload.entries : [];
      this.peerSnapshots.set(
        peerName,
        this.aggregatePeerSnapshot(peerName, now, contextPayload, entries),
      );
    } catch (err) {
      this.logger?.warn(
        { err, peer: peerName },
        "Failed to fetch context payload for peer in index refresh",
      );
    }
  }

  private async refreshPeerSnapshots(): Promise<void> {
    if (this.deps.peerManager && typeof this.deps.peerManager.getPeerStatuses === "function") {
      const statuses = this.deps.peerManager.getPeerStatuses() ?? [];
      const now = Date.now();
      await Promise.all(
        statuses
          .filter((status) => status.state === "online")
          .map((status) => this.refreshOnePeerSnapshot(status.name, now)),
      );
      return;
    }

    if (this.deps.fleetContext) {
      try {
        const context = await this.deps.fleetContext();
        const now = Date.now();
        for (const host of context.hosts) {
          if (host.hostName === "local") {
            continue;
          }
          this.peerSnapshots.set(
            host.hostName,
            this.buildPeerSnapshot(host.hostName, now, host.inventory, host.recentAgents),
          );
        }
        return;
      } catch (err) {
        this.logger?.warn({ err }, "Failed to fetch fleet context for index refresh");
      }
    }
  }

  private buildUnknownGuidance(id: string): string {
    const kind = inferIdKind(id);
    const shortId = formatShortId(id);

    const peerStatuses =
      typeof this.deps.peerManager?.getPeerStatuses === "function"
        ? (this.deps.peerManager.getPeerStatuses() ?? [])
        : [];
    const unreachableHosts = peerStatuses.filter((s) => s.state !== "online").map((s) => s.name);

    const unreachablePart =
      unreachableHosts.length > 0
        ? ` (${unreachableHosts.join(", ")} unreachable — it may live there)`
        : "";

    const resolver =
      kind === "workspace" || kind === "project"
        ? "Call fleet_list_inventory to resolve."
        : "Call fleet_list_agents to resolve.";

    return `${kind} ${shortId} not found on any reachable host${unreachablePart}. ${resolver}`;
  }
}

export function createFleetIdIndex(deps: FleetIdIndexDependencies): FleetIdIndex {
  return new FleetIdIndex(deps);
}
