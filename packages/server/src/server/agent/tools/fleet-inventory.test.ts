import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

interface FleetInventoryHost {
  host: string;
  reachable: boolean;
  projects: Array<{
    id: string;
    title: string;
    workspaces: Array<{ id: string; title: string; kind: string; cwd: string }>;
  }>;
}

/** Local daemon records: one stackmod project with a single worktree workspace. */
function localRecords(): {
  workspaceRegistry: { list: () => Promise<PersistedWorkspaceRecord[]> };
  projectRegistry: { list: () => Promise<PersistedProjectRecord[]> };
} {
  return {
    workspaceRegistry: {
      list: async () => [
        {
          workspaceId: "wks_stackmod",
          projectId: "prj_stackmod",
          cwd: "/home/dev/stackmod",
          kind: "worktree",
          displayName: "stackmod main",
          title: null,
        } as unknown as PersistedWorkspaceRecord,
      ],
    },
    projectRegistry: {
      list: async () => [
        {
          projectId: "prj_stackmod",
          rootPath: "/home/dev/stackmod",
          kind: "git",
          displayName: "stackmod",
          customName: "stackmod",
        } as unknown as PersistedProjectRecord,
      ],
    },
  };
}

/**
 * Fake peer harness: one online "macbook" peer whose context payload carries
 * the Paseo project (the acceptance case: the project that owns "paseo" lives
 * on a host whose name is NOT paseo).
 */
function createPeerHarness() {
  const client = {
    missionControlContextFetch: vi.fn(async () => ({
      inventory: {
        projects: [
          {
            id: "prj_paseo",
            title: "Paseo",
            hostServerId: "srv__macbook",
            workspaces: [
              { id: "wks_evil", title: "evil-toad", cwd: "/home/dev/evil-toad", kind: "worktree" },
              {
                id: "wks_charming",
                title: "charming-seal",
                cwd: "/home/dev/charming-seal",
                kind: "worktree",
              },
            ],
          },
        ],
      },
      models: {},
      recentAgents: [],
      hostAlias: "MacBook",
    })),
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) =>
      name === "macbook" ? { name: "macbook", state: "online" as const, lastSeenAt: null } : null,
    getPeerStatuses: () => [{ name: "macbook", state: "online" as const, lastSeenAt: null }],
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;
  return { client, peerManager };
}

function createCatalog(
  peerManager?: PeerManager,
  registries: { workspaceRegistry?: unknown; projectRegistry?: unknown } = {},
) {
  return createPaseoToolCatalog({
    agentManager: { listAgents: async () => [] } as unknown as AgentManager,
    agentStorage: { list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    workspaceRegistry: registries.workspaceRegistry as never,
    projectRegistry: registries.projectRegistry as never,
    daemonConfigStore: {
      get: () => ({}),
    } as unknown as Pick<DaemonConfigStore, "get">,
    peerManager,
    serverId: "srv__local",
    logger: createTestLogger(),
  });
}

describe("fleet_list_inventory tool", () => {
  test("query matches a project titled Paseo on the peer that owns it (never treated as a host)", async () => {
    const { peerManager } = createPeerHarness();
    const catalog = createCatalog(peerManager, localRecords());

    const result = await catalog.executeTool("fleet_list_inventory", { query: "paseo" });
    const hosts = (result.structuredContent as { hosts: FleetInventoryHost[] }).hosts;

    const macbook = hosts.find((host) => host.host === "macbook");
    expect(macbook?.reachable).toBe(true);
    expect(macbook?.projects).toEqual([
      {
        id: "prj_paseo",
        title: "Paseo",
        workspaces: [
          { id: "wks_evil", title: "evil-toad", kind: "worktree", cwd: "/home/dev/evil-toad" },
          {
            id: "wks_charming",
            title: "charming-seal",
            kind: "worktree",
            cwd: "/home/dev/charming-seal",
          },
        ],
      },
    ]);

    // The local stackmod project does not match "paseo" and stays out of the
    // result — the query filtered, it did not error ("host paseo is not a
    // peer" would be a bug: the query is a project name, not a host).
    const local = hosts.find((host) => host.host === "local");
    expect(local?.projects).toEqual([]);
  });

  test("host filter narrows the inventory to one host", async () => {
    const { peerManager } = createPeerHarness();
    const catalog = createCatalog(peerManager, localRecords());

    const peer = await catalog.executeTool("fleet_list_inventory", { host: "macbook" });
    const peerHosts = (peer.structuredContent as { hosts: FleetInventoryHost[] }).hosts;
    expect(peerHosts).toHaveLength(1);
    expect(peerHosts[0].host).toBe("macbook");
    expect(peerHosts[0].projects.map((project) => project.title)).toEqual(["Paseo"]);

    const local = await catalog.executeTool("fleet_list_inventory", { host: "local" });
    const localHosts = (local.structuredContent as { hosts: FleetInventoryHost[] }).hosts;
    expect(localHosts).toHaveLength(1);
    expect(localHosts[0].host).toBe("local");
    expect(localHosts[0].projects.map((project) => project.title)).toEqual(["stackmod"]);
  });

  test("an unknown host filter is refused like the other fleet tools", async () => {
    const { peerManager } = createPeerHarness();
    const catalog = createCatalog(peerManager, localRecords());

    await expect(
      catalog.executeTool("fleet_list_inventory", { host: "unknown-host" }),
    ).rejects.toThrow(/Host "unknown-host" is not a configured peer/);
  });

  test("host + query narrow to the matching workspace under its project", async () => {
    const { peerManager } = createPeerHarness();
    const catalog = createCatalog(peerManager, localRecords());

    const result = await catalog.executeTool("fleet_list_inventory", {
      host: "macbook",
      query: "evil",
    });
    const hosts = (result.structuredContent as { hosts: FleetInventoryHost[] }).hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0].projects).toEqual([
      {
        id: "prj_paseo",
        title: "Paseo",
        workspaces: [
          { id: "wks_evil", title: "evil-toad", kind: "worktree", cwd: "/home/dev/evil-toad" },
        ],
      },
    ]);
  });

  test("no query returns the full inventory across hosts", async () => {
    const { peerManager } = createPeerHarness();
    const catalog = createCatalog(peerManager, localRecords());

    const result = await catalog.executeTool("fleet_list_inventory", {});
    const hosts = (result.structuredContent as { hosts: FleetInventoryHost[] }).hosts;
    expect(hosts).toHaveLength(2);
    expect(hosts.find((host) => host.host === "local")?.projects.map((p) => p.title)).toEqual([
      "stackmod",
    ]);
    expect(hosts.find((host) => host.host === "macbook")?.projects.map((p) => p.title)).toEqual([
      "Paseo",
    ]);
  });

  test("unreachable peers appear with reachable:false and no projects", async () => {
    const peerManager = {
      getPeerStatus: () => null,
      getPeerStatuses: () => [
        {
          name: "offline-box",
          state: "unreachable" as const,
          lastSeenAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      getPeerClient: () => null,
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager, localRecords());

    const result = await catalog.executeTool("fleet_list_inventory", {});
    const hosts = (result.structuredContent as { hosts: FleetInventoryHost[] }).hosts;
    const offline = hosts.find((host) => host.host === "offline-box");
    expect(offline).toMatchObject({ host: "offline-box", reachable: false, projects: [] });
  });
});
