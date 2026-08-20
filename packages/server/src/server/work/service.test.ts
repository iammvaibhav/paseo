import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { AgentManager } from "../agent/agent-manager.js";
import type { WorkspaceRegistry, ProjectRegistry } from "../workspace-registry.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { MissionControlApprovals } from "../mission-control/approvals.js";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { WorkStore } from "./store.js";
import { WorkService } from "./service.js";
import { WorkFleet } from "./fleet.js";
import { WorkDispatcher } from "./dispatcher.js";

const logger = createTestLogger();

interface AgentManagerFake {
  listAgents: () => unknown[];
  getAgent: (id: string) => unknown | null;
  subscribe: (cb: (e: unknown) => void) => () => void;
}

function projectRegistryFake(activeWorkspacesForProject: (projectId: string) => unknown[]) {
  return {
    list: async () => [],
    get: async () => null,
    subscribeToMutations: () => () => undefined,
    _activeWorkspacesForProject: activeWorkspacesForProject,
  };
}

function workspaceRegistryFake(
  entries: Array<{ workspaceId: string; projectId: string; cwd: string }>,
) {
  const map = new Map(entries.map((e) => [e.workspaceId, { ...e, archivedAt: null }]));
  return {
    list: async () => [...map.values()],
    get: async (id: string) => map.get(id) ?? null,
    subscribeToMutations: () => () => undefined,
  };
}

function agentManagerFake(): AgentManagerFake {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    listAgents: () => [],
    getAgent: () => null,
    subscribe: (cb) => {
      listeners.push(cb);
      return () => undefined;
    },
  };
}

function peerManagerFakeEmpty() {
  return {
    getPeerStatuses: () => [] as unknown[],
    getPeerStatus: () => undefined as unknown,
    getPeerClient: () => null as unknown,
  };
}

function missionControlBucket(bucket: string | null) {
  return {
    getLifecycleBucket: async () => bucket,
    setReviewState: async () => undefined,
  } as unknown as import("../mission-control/service.js").MissionControlService;
}

async function freshArtifacts(opts?: {
  workspaces?: Array<{ workspaceId: string; projectId: string; cwd: string }>;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-svc-"));
  await mkdir(path.join(dir, ".paseo"), { recursive: true });
  const paseoHome = path.join(dir, ".paseo");
  const store = new WorkStore({ paseoHome, logger });
  await store.initialize();
  const projectRegistry = projectRegistryFake(() => []);
  const workspaces = workspaceRegistryFake(opts?.workspaces ?? []);
  return { dir, paseoHome, store, projectRegistry, workspaces };
}

describe("WorkService — done without an agent (regression for the silent guard)", () => {
  let dir = "";
  let store!: WorkStore;
  let projectRegistry!: ReturnType<typeof projectRegistryFake>;
  let service!: WorkService;

  beforeEach(async () => {
    ({ dir, store, projectRegistry } = await freshArtifacts());
    service = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: null,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet: null,
      hostName: "host-a",
    });
    await store.ensureProject({
      projectKey: "pk-done",
      projectId: "pid-done",
      displayName: "Done Regression",
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("moving an item with no linked agent to done succeeds and sets closed.state === done", async () => {
    const created = await store.createItem({
      projectKey: "pk-done",
      projectId: "pid-done",
      title: "no agent, to done",
      lane: "backlog",
    });
    expect(created.agentId).toBeNull();
    expect(created.closed).toBeNull();

    const result = await service.moveItem({ id: created.id, targetColumn: "done" });
    expect(result.error).toBeNull();
    expect(result.item).not.toBeNull();
    const after = await store.getItem(created.id);
    expect(after?.closed?.state).toBe("done");
    expect(result.item?.closed?.state).toBe("done");
    expect(result.item?.column).toBe("done");
  });

  it("moving an item with a linked agent to done also succeeds (same path, agent present)", async () => {
    const created = await store.createItem({
      projectKey: "pk-done",
      projectId: "pid-done",
      title: "with agent",
      lane: "todo",
    });
    await store.updateItem(created.id, (r) => ({ ...r, agentId: "agt_real", agentHost: "host-a" }));

    const serviceWithMC = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: missionControlBucket("running"),
      peerManager: null,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet: null,
      hostName: "host-a",
    });

    const result = await serviceWithMC.moveItem({ id: created.id, targetColumn: "done" });
    expect(result.error).toBeNull();
    const after = await store.getItem(created.id);
    expect(after?.closed?.state).toBe("done");
  });

  it("verifies the guard that would have broken done-without-agent is gone (in_review still gates)", async () => {
    const created = await store.createItem({
      projectKey: "pk-done",
      projectId: "pid-done",
      title: "in_review without agent",
      lane: "backlog",
    });
    const result = await service.moveItem({ id: created.id, targetColumn: "in_review" });
    expect(result.error).not.toBeNull();
    expect(result.item).toBeNull();
  });
});

describe("WorkDispatcher — concurrency cap + never double-dispatch", () => {
  let dir = "";
  let store!: WorkStore;
  let workspaces!: ReturnType<typeof workspaceRegistryFake>;

  beforeEach(async () => {
    ({ dir, store, workspaces } = await freshArtifacts({
      workspaces: [{ workspaceId: "ws-1", projectId: "pid-cap", cwd: "/tmp/pid-cap" }],
    }));
    await store.ensureProject({
      projectKey: "pk-cap",
      projectId: "pid-cap",
      displayName: "Cap",
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("with concurrency 2, moving many items to todo never exceeds 2 concurrent spawns", async () => {
    let live = 0;
    let peak = 0;
    const spawnOrder: string[] = [];
    const releases = new Map<string, () => void>();

    const approvals = {
      _listeners: [] as Array<(p: unknown) => void>,
      createProposal: async (input: { spawnPlan: { labels: Record<string, string> } }) => {
        const id = input.spawnPlan.labels["paseo.work-item-id"];
        live++;
        peak = Math.max(peak, live);
        spawnOrder.push(id);
        const { promise, resolve } = Promise.withResolvers<void>();
        releases.set(id, resolve);
        await promise;
        live--;
        return {
          id: `prop_${id}`,
          status: "sent",
          kind: "spawn" as const,
          spawnPlan: input.spawnPlan,
          spawnedAgentId: `agt_${id}`,
          spawnedOnServerId: "local",
        } as unknown as MissionControlProposal;
      },
      listProposals: () => [] as unknown[],
      onProposalChange: (cb: (p: unknown) => void) => {
        approvals._listeners.push(cb);
        return () => undefined;
      },
    } as unknown as MissionControlApprovals;

    const dispatcher = new WorkDispatcher({
      store,
      logger,
      concurrency: 2,
      approvals,
      workspaces: workspaces as unknown as WorkspaceRegistry,
    });
    dispatcher.start();

    const created: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await store.createItem({
        projectKey: "pk-cap",
        projectId: "pid-cap",
        title: `cap-${i}`,
        lane: "todo",
        assignment: {
          provider: "codex",
          model: null,
          modeId: null,
          thinkingOptionId: null,
          host: null,
          workspaceId: null,
          isolation: "local",
        },
      });
      created.push(r.id);
      await new Promise((rr) => setTimeout(rr, 5));
    }

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (live >= 2) break;
    }
    expect(live).toBeLessThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(2);

    const toRelease = [...releases.keys()][0];
    expect(toRelease).toBeTruthy();
    releases.get(toRelease!)!();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (releases.size > 2) break;
    }
    expect(peak).toBeLessThanOrEqual(2);

    for (const release of releases.values()) release();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (spawnOrder.length >= 6) break;
    }
    for (const [, rel] of releases.entries()) {
      try {
        rel();
      } catch {}
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (spawnOrder.length >= 6) break;
    }

    expect(peak).toBeLessThanOrEqual(2);
    expect(spawnOrder).toHaveLength(6);
    expect(new Set(spawnOrder).size).toBe(6);
    expect(new Set(spawnOrder)).toEqual(new Set(created));

    dispatcher.stop();
  });

  it("an item that already has an agentId is never dispatched twice", async () => {
    let createCalls = 0;
    const approvals = {
      createProposal: async (input: { spawnPlan: { labels: Record<string, string> } }) => {
        createCalls++;
        return {
          id: `prop_${createCalls}`,
          status: "sent",
          kind: "spawn" as const,
          spawnPlan: input.spawnPlan,
          spawnedAgentId: `agt_${createCalls}`,
          spawnedOnServerId: "local",
        } as unknown as MissionControlProposal;
      },
      listProposals: () => [] as unknown[],
      onProposalChange: () => () => undefined,
    } as unknown as MissionControlApprovals;

    const dispatcher = new WorkDispatcher({
      store,
      logger,
      concurrency: 1,
      approvals,
      workspaces: workspaces as unknown as WorkspaceRegistry,
    });
    dispatcher.start();

    const item = await store.createItem({
      projectKey: "pk-cap",
      projectId: "pid-cap",
      title: "bound",
      lane: "todo",
      assignment: {
        provider: "codex",
        model: null,
        modeId: null,
        thinkingOptionId: null,
        host: null,
        workspaceId: null,
        isolation: "local",
      },
    });
    await store.updateItem(item.id, (r) => ({ ...r, agentId: "agt_bound", agentHost: "host-a" }));
    await new Promise((r) => setTimeout(r, 60));

    const callsAfterBound = createCalls;
    await dispatcher.dispatchNow(item.id);
    await new Promise((r) => setTimeout(r, 60));
    expect(createCalls).toBe(callsAfterBound);

    dispatcher.stop();
  });
});

describe("WorkFleet aggregation — unreachable peer is reachable:false, never throws", () => {
  it("returns a local entry plus an unreachable peer entry with empty lists, never throws", async () => {
    const store = {
      listProjects: async () => [
        {
          projectKey: "pk-local",
          projectId: "pid-local",
          identifier: "LOCAL",
          displayName: "Local",
          description: null,
          nextSequenceId: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        },
      ],
      listItems: async () => [
        {
          id: "wit_local",
          projectKey: "pk-local",
          projectId: "pid-local",
          sequenceId: 1,
          title: "local item",
          description: "",
          priority: "none",
          labelIds: [],
          parentId: null,
          sortOrder: 65535,
          lane: "backlog",
          assignment: null,
          agentId: null,
          agentHost: null,
          closed: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    } as unknown as WorkStore;

    const peerManager = {
      getPeerStatuses: () => [
        { name: "hostb", state: "offline", lastSeenAt: null },
        { name: "hostc", state: "online", lastSeenAt: new Date().toISOString() },
      ],
      getPeerClient: (name: string) => {
        if (name === "hostc") {
          return {
            workProjectList: async () => {
              throw new Error("network down");
            },
            workItemList: async () => {
              throw new Error("network down");
            },
          };
        }
        return null;
      },
    } as unknown as PeerManager;

    const fleet = new WorkFleet({
      store,
      peerManager,
      logger,
      serverId: "local",
      hostName: "hosta",
    });

    await expect(fleet.listProjectsFleet()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "hosta", reachable: true }),
        expect.objectContaining({ host: "hostb", reachable: false, projects: [] }),
        expect.objectContaining({ host: "hostc", reachable: false, projects: [] }),
      ]),
    );

    await expect(fleet.listItemsFleet("pk-local")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "hosta", reachable: true }),
        expect.objectContaining({ host: "hostb", reachable: false, items: [] }),
        expect.objectContaining({ host: "hostc", reachable: false, items: [] }),
      ]),
    );
  });

  it("reaches service.listProjects / service.listItems through the fleet path without throwing", async () => {
    const { dir, store, projectRegistry } = await freshArtifacts();
    const peerManager = peerManagerFakeEmpty() as unknown as PeerManager;
    const fleet = new WorkFleet({
      store,
      peerManager,
      logger,
      serverId: "local",
      hostName: "hosta",
    });
    const svc = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet,
      hostName: "hosta",
    });

    await store.ensureProject({
      projectKey: "pk-fleet-svc",
      projectId: "pid-fleet-svc",
      displayName: "Fleet Svc",
    });
    await store.createItem({
      projectKey: "pk-fleet-svc",
      projectId: "pid-fleet-svc",
      title: "hello",
    });

    const projs = await svc.listProjects();
    expect(projs.hosts.some((h) => h.host === "hosta" && h.reachable)).toBe(true);

    const items = await svc.listItems("pk-fleet-svc");
    expect(items.hosts.some((h) => h.host === "hosta" && h.reachable)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("WorkService localOnly — never consults fleet, returns only local", () => {
  it("listProjects({ localOnly: true }) never consults the fleet and returns only the local host entry", async () => {
    const { dir, store, projectRegistry } = await freshArtifacts();
    await store.ensureProject({
      projectKey: "pk-localonly",
      projectId: "pid-localonly",
      displayName: "LocalOnly",
    });

    const fleet: unknown = {
      listProjectsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
      listItemsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
    };

    const svc = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: peerManagerFakeEmpty() as unknown as PeerManager,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet: fleet as WorkFleet,
      hostName: "hosta",
    });

    const result = await svc.listProjects({ localOnly: true });
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ host: "hosta", reachable: true });
    expect(result.hosts[0].projects.length).toBeGreaterThanOrEqual(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("listItems(projectKey, { localOnly: true }) never consults the fleet and returns only the local host entry", async () => {
    const { dir, store, projectRegistry } = await freshArtifacts();
    await store.ensureProject({
      projectKey: "pk-localonly-items",
      projectId: "pid-localonly-items",
      displayName: "LocalOnly Items",
    });
    await store.createItem({
      projectKey: "pk-localonly-items",
      projectId: "pid-localonly-items",
      title: "one",
    });

    const fleet: unknown = {
      listProjectsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
      listItemsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
    };

    const svc = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: peerManagerFakeEmpty() as unknown as PeerManager,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet: fleet as WorkFleet,
      hostName: "hosta",
    });

    const result = await svc.listItems("pk-localonly-items", { localOnly: true });
    expect(result.projectKey).toBe("pk-localonly-items");
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ host: "hosta", reachable: true });
    expect(result.hosts[0].items.length).toBeGreaterThanOrEqual(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("a normal (non-localOnly) call still aggregates and represents an unreachable peer as reachable:false without throwing", async () => {
    const store = {
      listProjects: async () => [
        {
          projectKey: "pk-agg",
          projectId: "pid-agg",
          identifier: "AGG",
          displayName: "Agg",
          description: null,
          nextSequenceId: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        },
      ],
      listItems: async () => [
        {
          id: "wit_agg",
          projectKey: "pk-agg",
          projectId: "pid-agg",
          sequenceId: 1,
          title: "agg item",
          description: "",
          priority: "none",
          labelIds: [],
          parentId: null,
          sortOrder: 65535,
          lane: "backlog",
          assignment: null,
          agentId: null,
          agentHost: null,
          closed: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      getProjectByKey: async (projectKey: string) => ({
        projectKey,
        identifier: projectKey === "pk-agg" ? "AGG" : projectKey.toUpperCase(),
        displayName: "Agg",
      }),
      listChildren: async () => [],
    } as unknown as WorkStore;

    const peerManager = {
      getPeerStatuses: () => [
        { name: "peer-bad", state: "online", lastSeenAt: new Date().toISOString() },
      ],
      getPeerClient: () => ({
        workProjectList: async () => {
          throw new Error("peer boom");
        },
        workItemList: async () => {
          throw new Error("peer boom");
        },
      }),
    } as unknown as PeerManager;

    const fleet = new WorkFleet({
      store,
      peerManager,
      logger,
      serverId: "local",
      hostName: "hosta",
    });

    const svc = new WorkService({
      store: store as unknown as WorkStore,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager,
      projectRegistry: projectRegistryFake(() => []) as unknown as ProjectRegistry,
      dispatcher: null,
      fleet,
      hostName: "hosta",
    });

    await expect(svc.listProjects()).resolves.toEqual(
      expect.objectContaining({
        hosts: expect.arrayContaining([
          expect.objectContaining({ host: "hosta", reachable: true }),
          expect.objectContaining({ host: "peer-bad", reachable: false, projects: [] }),
        ]),
      }),
    );

    await expect(svc.listItems("pk-agg")).resolves.toEqual(
      expect.objectContaining({
        projectKey: "pk-agg",
        hosts: expect.arrayContaining([
          expect.objectContaining({ host: "hosta", reachable: true }),
          expect.objectContaining({ host: "peer-bad", reachable: false, items: [] }),
        ]),
      }),
    );
  });
});
describe("WorkService cross-host wiring — peer payloads pass through unchanged", () => {
  it("peer items keep their owning-host humanKey/bucket/subItemCount and never consult the local store for wiring", async () => {
    // Peer payload already correctly wired on the owning host (MACBOOK-2, bucket, subItemCount).
    // The aggregator must pass it through unchanged and must NOT call local store wiring helpers for it.
    const peerWireItem = {
      id: "wit_peer",
      projectKey: "host:srv_UATl_VeSDsDe:/Users/vaibhav",
      projectId: "pid-peer",
      sequenceId: 2,
      humanKey: "MACBOOK-2",
      title: "peer item",
      description: "",
      priority: "none" as const,
      labelIds: [],
      parentId: null,
      sortOrder: 65535,
      lane: "backlog" as const,
      assignment: null,
      agentId: null,
      agentHost: null,
      closed: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      column: "backlog" as const,
      bucket: "running" as const,
      subItemCount: 3,
    };

    // Local store holds exactly one local project+item; a spy asserts the service
    // never asks it about the peer's projectKey/children/bracket.
    const localProjectRecord = {
      projectKey: "pk-local",
      projectId: "pid-local",
      identifier: "LOCAL",
      displayName: "Local",
      description: null,
      nextSequenceId: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    };
    const localRawItem = {
      id: "wit_local",
      projectKey: "pk-local",
      projectId: "pid-local",
      sequenceId: 1,
      title: "local item",
      description: "",
      priority: "none" as const,
      labelIds: [],
      parentId: null,
      sortOrder: 65535,
      lane: "backlog" as const,
      assignment: null,
      agentId: null,
      agentHost: null,
      closed: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let getProjectByKeyCalls: string[] = [];
    let listChildrenCalls: string[] = [];
    const store = {
      listProjects: async () => [localProjectRecord],
      listItems: async () => [localRawItem],
      getProjectByKey: async (key: string) => {
        getProjectByKeyCalls.push(key);
        if (key === "pk-local") return localProjectRecord;
        throw new Error(`local store must not be consulted for peer projectKey ${key}`);
      },
      listChildren: async (parentId: string) => {
        listChildrenCalls.push(parentId);
        if (parentId === "wit_peer") {
          throw new Error("local store must not be consulted for peer children");
        }
        return [];
      },
    } as unknown as WorkStore;

    // Fleet stub returns discriminated entries: local = raw records, peer = already-wired payloads.
    const fleet = {
      listItemsFleet: async () => [
        { host: "hosta", reachable: true, kind: "local" as const, items: [localRawItem] },
        { host: "macbook", reachable: true, kind: "peer" as const, items: [peerWireItem] },
      ],
      listProjectsFleet: async () => [
        {
          host: "hosta",
          reachable: true,
          kind: "local" as const,
          projects: [localProjectRecord],
        },
        {
          host: "macbook",
          reachable: true,
          kind: "peer" as const,
          projects: [
            {
              projectKey: "host:srv_UATl_VeSDsDe:/Users/vaibhav",
              projectId: "pid-peer",
              identifier: "MACBOOK",
              displayName: "Macbook",
              description: null,
              nextSequenceId: 3,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
            },
          ],
        },
      ],
    } as unknown as WorkFleet;

    const svc = new WorkService({
      store: store as unknown as WorkStore,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: peerManagerFakeEmpty() as unknown as PeerManager,
      projectRegistry: projectRegistryFake(() => []) as unknown as ProjectRegistry,
      dispatcher: null,
      fleet,
      hostName: "hosta",
    });

    // listItems: peer payload passes through verbatim; local is still wired.
    const itemsRes = await svc.listItems("pk-local");
    const peerHost = itemsRes.hosts.find((h) => h.host === "macbook");
    expect(peerHost).toBeDefined();
    expect(peerHost!.reachable).toBe(true);
    expect(peerHost!.items).toHaveLength(1);
    expect(peerHost!.items[0]).toEqual(peerWireItem);
    expect(peerHost!.items[0].humanKey).toBe("MACBOOK-2");
    expect(peerHost!.items[0].bucket).toBe("running");
    expect(peerHost!.items[0].subItemCount).toBe(3);
    // Reference identity also proves no re-wiring copy was made.
    expect(peerHost!.items[0]).toBe(peerWireItem);

    const localHost = itemsRes.hosts.find((h) => h.host === "hosta");
    expect(localHost).toBeDefined();
    expect(localHost!.reachable).toBe(true);
    expect(localHost!.items).toHaveLength(1);
    expect(localHost!.items[0].humanKey).toBe("LOCAL-1");

    // listProjects: peer projects also pass through unchanged.
    const projsRes = await svc.listProjects();
    const peerProjHost = projsRes.hosts.find((h) => h.host === "macbook");
    expect(peerProjHost).toBeDefined();
    expect(peerProjHost!.projects[0].identifier).toBe("MACBOOK");

    // Local store was only consulted for the local item's wiring, never for the peer.
    expect(getProjectByKeyCalls).toEqual(["pk-local"]);
    expect(listChildrenCalls).toEqual(["wit_local"]);
    // Reset so later tests don't leak state through shared arrays (reassigned above but keep clean).
    getProjectByKeyCalls = [];
    listChildrenCalls = [];
  });

  it("unreachable peer stays reachable:false with empty list, local still wired", async () => {
    const localProjectRecord = {
      projectKey: "pk-local2",
      projectId: "pid-local2",
      identifier: "LOCAL",
      displayName: "Local",
      description: null,
      nextSequenceId: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    };
    const localRawItem = {
      id: "wit_local2",
      projectKey: "pk-local2",
      projectId: "pid-local2",
      sequenceId: 1,
      title: "local item 2",
      description: "",
      priority: "none" as const,
      labelIds: [],
      parentId: null,
      sortOrder: 65535,
      lane: "backlog" as const,
      assignment: null,
      agentId: null,
      agentHost: null,
      closed: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = {
      listProjects: async () => [localProjectRecord],
      listItems: async () => [localRawItem],
      getProjectByKey: async () => localProjectRecord,
      listChildren: async () => [],
    } as unknown as WorkStore;

    const fleet = {
      listItemsFleet: async () => [
        { host: "hosta", reachable: true, kind: "local" as const, items: [localRawItem] },
        { host: "peer-bad", reachable: false, kind: "peer" as const, items: [] },
      ],
      listProjectsFleet: async () => [
        { host: "hosta", reachable: true, kind: "local" as const, projects: [localProjectRecord] },
        { host: "peer-bad", reachable: false, kind: "peer" as const, projects: [] },
      ],
    } as unknown as WorkFleet;

    const svc = new WorkService({
      store: store as unknown as WorkStore,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: peerManagerFakeEmpty() as unknown as PeerManager,
      projectRegistry: projectRegistryFake(() => []) as unknown as ProjectRegistry,
      dispatcher: null,
      fleet,
      hostName: "hosta",
    });

    const itemsRes = await svc.listItems("pk-local2");
    expect(itemsRes.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "hosta", reachable: true }),
        expect.objectContaining({ host: "peer-bad", reachable: false, items: [] }),
      ]),
    );
    // No throw, and local still wired correctly.
    expect(itemsRes.hosts.find((h) => h.host === "hosta")!.items[0].humanKey).toBe("LOCAL-1");

    const projsRes = await svc.listProjects();
    expect(projsRes.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "hosta", reachable: true }),
        expect.objectContaining({ host: "peer-bad", reachable: false, projects: [] }),
      ]),
    );
  });

  it("localOnly still bypasses fleet and wires local items without touching peers", async () => {
    const { dir, store, projectRegistry } = await freshArtifacts();
    await store.ensureProject({
      projectKey: "pk-localonly-xhost",
      projectId: "pid-localonly-xhost",
      displayName: "LocalOnly XHost",
    });
    await store.createItem({
      projectKey: "pk-localonly-xhost",
      projectId: "pid-localonly-xhost",
      title: "one",
    });

    const fleet: unknown = {
      listProjectsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
      listItemsFleet: async () => {
        throw new Error("fleet must not be called when localOnly is set");
      },
    };

    const svc = new WorkService({
      store,
      logger,
      agentManager: agentManagerFake() as unknown as AgentManager,
      missionControlService: null,
      peerManager: peerManagerFakeEmpty() as unknown as PeerManager,
      projectRegistry: projectRegistry as unknown as ProjectRegistry,
      dispatcher: null,
      fleet: fleet as WorkFleet,
      hostName: "hosta",
    });

    const itemsRes = await svc.listItems("pk-localonly-xhost", { localOnly: true });
    expect(itemsRes.hosts).toHaveLength(1);
    expect(itemsRes.hosts[0].host).toBe("hosta");
    expect(itemsRes.hosts[0].items.length).toBeGreaterThanOrEqual(1);
    // Wired locally: humanKey derived from local project identifier.
    const localProject = await store.getProjectByKey("pk-localonly-xhost");
    expect(itemsRes.hosts[0].items[0].humanKey).toBe(`${localProject!.identifier}-1`);

    const projsRes = await svc.listProjects({ localOnly: true });
    expect(projsRes.hosts).toHaveLength(1);
    expect(projsRes.hosts[0].host).toBe("hosta");

    await rm(dir, { recursive: true, force: true });
  });
});
