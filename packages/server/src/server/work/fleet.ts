import type { Logger } from "pino";

import type { PeerManager } from "../peers/peer-manager.js";
import type { WorkStore } from "./store.js";
import type { WorkItemRecord } from "./model.js";
import type { WorkProjectRecord } from "./model.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
export interface WorkFleetDependencies {
  store: WorkStore;
  peerManager: PeerManager | null;
  logger: Logger;
  serverId: string;
  hostName: string;
}

export interface WorkProjectHostEntry {
  host: string;
  reachable: boolean;
  projects: WorkProjectRecord[];
}

export interface WorkItemHostEntry {
  host: string;
  reachable: boolean;
  items: WorkItemRecord[];
}

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
      { host: this.hostName, reachable: true, projects: localProjects },
    ];

    for (const status of this.peerManager?.getPeerStatuses() ?? []) {
      const client = this.peerManager?.getPeerClient(status.name) ?? null;
      let projects: WorkProjectRecord[] | null = null;
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
        projects: projects ?? [],
      });
    }
    return hosts;
  }

  async listItemsFleet(projectKey: string): Promise<WorkItemHostEntry[]> {
    const localItems = await this.store.listItems({ projectKey });
    const hosts: WorkItemHostEntry[] = [
      { host: this.hostName, reachable: true, items: localItems },
    ];

    for (const status of this.peerManager?.getPeerStatuses() ?? []) {
      const client = this.peerManager?.getPeerClient(status.name) ?? null;
      let items: WorkItemRecord[] | null = null;
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
        items: items ?? [],
      });
    }
    return hosts;
  }

  private async fetchPeerProjects(
    client: DaemonClient,
    peerName: string,
  ): Promise<WorkProjectRecord[]> {
    const response = await client.workProjectList({ localOnly: true });
    if (Array.isArray(response.hosts)) {
      const peerEntry = response.hosts.find((entry) => entry.host === peerName);
      if (peerEntry !== undefined) return peerEntry.projects as WorkProjectRecord[];
      if (response.hosts.length === 1) return response.hosts[0].projects as WorkProjectRecord[];
      return response.hosts.flatMap((entry) => entry.projects as WorkProjectRecord[]);
    }
    return [];
  }

  private async fetchPeerItems(
    client: DaemonClient,
    projectKey: string,
    peerName: string,
  ): Promise<WorkItemRecord[]> {
    const response = await client.workItemList({ projectKey, localOnly: true });
    if (Array.isArray(response.hosts)) {
      const peerEntry = response.hosts.find((entry) => entry.host === peerName);
      if (peerEntry !== undefined) return peerEntry.items as WorkItemRecord[];
      return response.hosts.flatMap((entry) => entry.items as WorkItemRecord[]);
    }
    return [];
  }
}
