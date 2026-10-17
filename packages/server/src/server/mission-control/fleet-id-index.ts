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

/** A resolved id carries its canonical `id`: a unique agent-id prefix (the
 * short ids rosters show) expands to the full id callers must route with. */
export type FleetIdResolution =
  | { kind: FleetIdKind; host: string; id: string }
  | { kind: "unknown"; guidance: string };

/** Shortest agent-id prefix expanded to a full id (rosters show 7-8 chars). */
const MIN_AGENT_ID_PREFIX_LENGTH = 6;
const AGENT_ID_PREFIX_PATTERN = /^[0-9a-f-]+$/i;
const FULL_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A peer that is "online" but stops answering must not stall resolution
 * for ids on the reachable peers; its snapshot fetch is cut off here. */
const DEFAULT_PEER_FETCH_TIMEOUT_MS = 10_000;

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
  /** Per-peer snapshot fetch bound. Defaults to DEFAULT_PEER_FETCH_TIMEOUT_MS. */
  peerFetchTimeoutMs?: number;
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
   * 3. On miss: refresh reachable peer snapshots once and retry
   * 4. Still missing: a full agent id is looked up on every reachable peer
   *    (snapshots hold only a peer's newest agents); a shorter one expands as
   *    a unique agent-id prefix across local + peers
   * 5. Otherwise: unknown with guidance naming unreachable peers and resolver tool
   */
  async resolveFleetId(id: string): Promise<FleetIdResolution> {
    const trimmedId = id.trim();
    if (!trimmedId) {
      return {
        kind: "unknown",
        guidance: "id is empty. Call fleet_list_agents or fleet_list_inventory to resolve.",
      };
    }

    const exact = (await this.resolveLocal(trimmedId)) ?? this.resolveFromPeerSnapshots(trimmedId);
    if (exact) {
      return { ...exact, id: trimmedId };
    }

    await this.refreshPeerSnapshots();

    const refreshed =
      (await this.resolveLocal(trimmedId)) ?? this.resolveFromPeerSnapshots(trimmedId);
    if (refreshed) {
      return { ...refreshed, id: trimmedId };
    }

    if (inferIdKind(trimmedId) === "agent" && FULL_AGENT_ID_PATTERN.test(trimmedId)) {
      const owner = await this.probePeersForAgent(trimmedId);
      if (owner) {
        return owner;
      }
    } else if (
      inferIdKind(trimmedId) === "agent" &&
      trimmedId.length >= MIN_AGENT_ID_PREFIX_LENGTH &&
      AGENT_ID_PREFIX_PATTERN.test(trimmedId)
    ) {
      const prefixMatch = await this.resolveAgentPrefix(trimmedId.toLowerCase());
      if (prefixMatch) {
        return prefixMatch;
      }
    }

    return {
      kind: "unknown",
      guidance: this.buildUnknownGuidance(trimmedId),
    };
  }

  /** Ask every reachable peer for the exact agent id. A peer snapshot lists
   * only that peer's newest agents, so an older closed or archived agent is
   * missing from it; fetch_agent reads the peer's whole agent storage. Null
   * when no peer has the agent. */
  private async probePeersForAgent(agentId: string): Promise<FleetIdResolution | null> {
    const peerManager = this.deps.peerManager;
    if (!peerManager || typeof peerManager.getPeerStatuses !== "function") {
      return null;
    }
    const timeoutMs = this.deps.peerFetchTimeoutMs ?? DEFAULT_PEER_FETCH_TIMEOUT_MS;
    const online = (peerManager.getPeerStatuses() ?? []).filter(
      (status) => status.state === "online",
    );
    const owners = await Promise.all(
      online.map(async (status) => {
        const client = peerManager.getPeerClient(status.name);
        if (!client || typeof client.fetchAgent !== "function") {
          return null;
        }
        const timedOut = Promise.withResolvers<null>();
        const timer = setTimeout(() => timedOut.resolve(null), timeoutMs);
        try {
          const found = await Promise.race([
            client.fetchAgent(agentId).catch(() => null),
            timedOut.promise,
          ]);
          return found?.agent.id === agentId ? status.name : null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const hosts = owners.filter((host): host is string => host !== null);
    if (hosts.length === 0) {
      return null;
    }
    if (hosts.length > 1) {
      return {
        kind: "unknown",
        guidance: `agent ${agentId} exists on several hosts (${hosts.join(", ")}). Pass host to pick one.`,
      };
    }
    const [host] = hosts;
    this.peerSnapshots.get(host!)?.agents.add(agentId);
    return { kind: "agent", host: host!, id: agentId };
  }

  /** Expand an agent-id prefix to the one full id it names across this
   * daemon and the peer snapshots. Several candidates → ambiguous guidance;
   * none → null so the caller reports not-found. */
  private async resolveAgentPrefix(prefix: string): Promise<FleetIdResolution | null> {
    const candidates = new Map<string, string>();
    for (const agentId of await this.listLocalAgentIds()) {
      if (agentId.toLowerCase().startsWith(prefix)) {
        candidates.set(agentId, "local");
      }
    }
    for (const [peerName, snapshot] of this.peerSnapshots.entries()) {
      for (const agentId of snapshot.agents) {
        if (agentId.toLowerCase().startsWith(prefix) && !candidates.has(agentId)) {
          candidates.set(agentId, peerName);
        }
      }
    }
    if (candidates.size === 1) {
      const [[agentId, host]] = candidates;
      return { kind: "agent", host, id: agentId };
    }
    if (candidates.size > 1) {
      const listed = [...candidates].map(([agentId, host]) => `${agentId} (${host})`).join(", ");
      return {
        kind: "unknown",
        guidance: `agent id prefix "${prefix}" is ambiguous: ${listed}. Pass the full id from fleet_list_agents.`,
      };
    }
    return null;
  }

  /** Every agent id this daemon knows (live manager + storage). A registry
   * hiccup contributes nothing rather than failing the lookup. */
  private async listLocalAgentIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const { agentManager, agentStorage } = this.deps;
    try {
      for (const agent of agentManager?.listAgents() ?? []) {
        ids.add(agent.id);
      }
    } catch (err) {
      this.logger?.debug({ err }, "Error listing live agents for prefix lookup");
    }
    try {
      for (const record of (await agentStorage?.list()) ?? []) {
        ids.add(record.id);
      }
    } catch (err) {
      this.logger?.debug({ err }, "Error listing stored agents for prefix lookup");
    }
    return ids;
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

  /** Refresh one online peer's snapshot from its context + full agent list.
   * A peer that does not answer within the fetch bound keeps its previous
   * snapshot, so a dying host never stalls or empties the index. */
  private async refreshOnePeerSnapshot(peerName: string, now: number): Promise<void> {
    const client = this.deps.peerManager?.getPeerClient(peerName);
    if (!client) {
      return;
    }
    const timeoutMs = this.deps.peerFetchTimeoutMs ?? DEFAULT_PEER_FETCH_TIMEOUT_MS;
    const timedOut = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timedOut.resolve("timeout"), timeoutMs);
    try {
      const fetched = await Promise.race([
        Promise.all([
          client.missionControlContextFetch().catch(() => null),
          typeof client.fetchAgents === "function"
            ? client
                .fetchAgents({ filter: { includeArchived: true }, page: { limit: 200 } })
                .catch(() => null)
            : Promise.resolve(null),
        ]),
        timedOut.promise,
      ]);
      if (fetched === "timeout") {
        this.logger?.warn(
          { peer: peerName, timeoutMs },
          "Peer did not answer the index refresh in time; keeping its previous snapshot",
        );
        return;
      }
      const [contextPayload, agentsPayload] = fetched;
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
    } finally {
      clearTimeout(timer);
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
