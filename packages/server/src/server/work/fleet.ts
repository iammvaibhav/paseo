import type { Logger } from "pino";

import type { PeerManager } from "../peers/peer-manager.js";
import type { WorkStore } from "./store.js";
import type { WorkItemRecord } from "./model.js";
import type { WorkProjectRecord } from "./model.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkItem, WorkProject } from "@getpaseo/protocol/work/types";
export interface WorkFleetDependencies {
  store: WorkStore;
  peerManager: PeerManager | null;
  logger: Logger;
  serverId: string;
  hostName: string;
}

/** Local host entry — raw store records that still need wiring on this host. */
export interface WorkLocalProjectHostEntry {
  host: string;
  reachable: true;
  kind: "local";
  projects: WorkProjectRecord[];
}

/** Peer host entry — already-wired wire payloads from the owning host, must not be re-wired locally. */
export interface WorkPeerProjectHostEntry {
  host: string;
  reachable: boolean;
  kind: "peer";
  projects: WorkProject[];
}

export type WorkProjectHostEntry = WorkLocalProjectHostEntry | WorkPeerProjectHostEntry;

/** Local host entry — raw store records that still need wiring on this host. */
export interface WorkLocalItemHostEntry {
  host: string;
  reachable: true;
  kind: "local";
  items: WorkItemRecord[];
}

/** Peer host entry — already-wired wire payloads from the owning host, must not be re-wired locally. */
export interface WorkPeerItemHostEntry {
  host: string;
  reachable: boolean;
  kind: "peer";
  items: WorkItem[];
}

export type WorkItemHostEntry = WorkLocalItemHostEntry | WorkPeerItemHostEntry;

/**
 * Copy of buildFleetContextData (mission-control/context.ts:454) as aggregation
 * pattern: serve local, fan out to online peers via PeerManager, and represent
 * an unreachable peer as reachable:false with empty list. Never throw.
 */
export class WorkFleet {
  private readonly store: WorkStore;
  private readonly peerManager: PeerManager | null;
  private readonly logger: Logger;
  private readonly hostName: string;

  constructor(deps: WorkFleetDependencies) {
    this.store = deps.store;
    this.peerManager = deps.peerManager;
    this.logger =
      typeof deps.logger.child === "function"
        ? (deps.logger.child({ module: "work", component: "fleet" }) as Logger)
        : deps.logger;
    this.hostName = deps.hostName;
  }

  async listProjectsFleet(): Promise<WorkProjectHostEntry[]> {
    const localProjects = await this.store.listProjects();
    const hosts: WorkProjectHostEntry[] = [
      { host: this.hostName, reachable: true, kind: "local", projects: localProjects },
    ];

    for (const status of this.peerManager?.getPeerStatuses() ?? []) {
      const client = this.peerManager?.getPeerClient(status.name) ?? null;
      let projects: WorkProject[] | null = null;
      if (status.state === "online" && client !== null) {
        try {
          projects = await this.fetchPeerProjects(client, status.name);
        } catch (error) {
          this.logger.warn(
            { err: error, peer: status.name },
            "Failed to fetch work projects from peer",
          );
        }
      }
      hosts.push({
        host: status.name,
        reachable: projects !== null,
        kind: "peer",
        projects: projects ?? [],
      });
    }
    return hosts;
  }

  async listItemsFleet(projectKey: string): Promise<WorkItemHostEntry[]> {
    const localItems = await this.store.listItems({ projectKey });
    const hosts: WorkItemHostEntry[] = [
      { host: this.hostName, reachable: true, kind: "local", items: localItems },
    ];

    for (const status of this.peerManager?.getPeerStatuses() ?? []) {
      const client = this.peerManager?.getPeerClient(status.name) ?? null;
      let items: WorkItem[] | null = null;
      if (status.state === "online" && client !== null) {
        try {
          items = await this.fetchPeerItems(client, projectKey, status.name);
        } catch (error) {
          this.logger.warn(
            { err: error, peer: status.name },
            "Failed to fetch work items from peer",
          );
        }
      }
      hosts.push({
        host: status.name,
        reachable: items !== null,
        kind: "peer",
        items: items ?? [],
      });
    }
    return hosts;
  }

  private async fetchPeerProjects(client: DaemonClient, peerName: string): Promise<WorkProject[]> {
    const response = await client.workProjectList({ localOnly: true });
    if (Array.isArray(response.hosts)) {
      const peerEntry = response.hosts.find((entry) => entry.host === peerName);
      if (peerEntry !== undefined) return peerEntry.projects as WorkProject[];
      if (response.hosts.length === 1) return response.hosts[0].projects as WorkProject[];
      return response.hosts.flatMap((entry) => entry.projects as WorkProject[]);
    }
    return [];
  }

  private async fetchPeerItems(
    client: DaemonClient,
    projectKey: string,
    peerName: string,
  ): Promise<WorkItem[]> {
    const response = await client.workItemList({ projectKey, localOnly: true });
    if (Array.isArray(response.hosts)) {
      const peerEntry = response.hosts.find((entry) => entry.host === peerName);
      if (peerEntry !== undefined) return peerEntry.items as WorkItem[];
      return response.hosts.flatMap((entry) => entry.items as WorkItem[]);
    }
    return [];
  }
}
