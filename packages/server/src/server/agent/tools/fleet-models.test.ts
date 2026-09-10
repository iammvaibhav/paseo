import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type * as ContextModule from "../../mission-control/context.js";

// The local branch of fleet_list_models delegates to buildLocalModels (the
// same builder the world snapshot uses); it reads the real ~/.omp config, so
// the tool test stubs the builder and keeps the shared default-worker-model
// derivation (resolveDefaultWorkerModel) REAL — that is the code under test.
vi.mock("../../mission-control/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>();
  return {
    ...actual,
    buildLocalModels: vi.fn(async () => ({
      omp: ["opencode-zen/deepseek-v4-flash-free"],
    })),
  };
});

interface FleetListModelsResult {
  host: string;
  models: Record<string, string[]>;
  defaultWorkerModel: string | null;
}

function createCatalog(
  peerManager?: PeerManager,
  hostIdentity: { serverId?: string; hostAlias?: string | null } = {},
  daemonConfigStore?: Pick<DaemonConfigStore, "get">,
) {
  return createPaseoToolCatalog({
    agentManager: {} as unknown as AgentManager,
    agentStorage: { get: async () => null, list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
    serverId: hostIdentity.serverId,
    hostAlias: hostIdentity.hostAlias,
    daemonConfigStore,
    logger: createTestLogger(),
  });
}

describe("fleet_list_models tool", () => {
  test("returns local models + defaultWorkerModel when host is omitted", async () => {
    const catalog = createCatalog(undefined, { serverId: "srv__local", hostAlias: "work server" });

    const result = await catalog.executeTool("fleet_list_models", {});
    const content = result.structuredContent as FleetListModelsResult;
    expect(content).toEqual({
      host: "work server",
      models: { omp: ["opencode-zen/deepseek-v4-flash-free"] },
      defaultWorkerModel: "omp/opencode-zen/deepseek-v4-flash-free",
    });
  });

  test("explicit host 'local' resolves to the local branch and labels the daemon itself", async () => {
    const catalog = createCatalog();

    const result = await catalog.executeTool("fleet_list_models", { host: "local" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.host).toBe("local");
    expect(content.defaultWorkerModel).toBe("omp/opencode-zen/deepseek-v4-flash-free");
  });

  test("local defaultWorkerModel prefers the daemon's composerPreferences last pick", async () => {
    const daemonConfigStore = {
      get: () => ({
        composerPreferences: {
          provider: "claude",
          providerPreferences: {
            claude: { model: "claude-opus-5", mode: "plan" },
          },
        },
      }),
    } as unknown as Pick<DaemonConfigStore, "get">;
    const catalog = createCatalog(undefined, {}, daemonConfigStore);

    const result = await catalog.executeTool("fleet_list_models", { host: "local" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.defaultWorkerModel).toBe("claude/claude-opus-5");
  });

  test("local defaultWorkerModel falls back to the omp task role without composerPreferences", async () => {
    const daemonConfigStore = { get: () => ({}) } as unknown as Pick<DaemonConfigStore, "get">;
    const catalog = createCatalog(undefined, {}, daemonConfigStore);

    const result = await catalog.executeTool("fleet_list_models", { host: "local" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.defaultWorkerModel).toBe("omp/opencode-zen/deepseek-v4-flash-free");
  });

  test("peer defaultWorkerModel prefers the peer's own composerPreferences last pick", async () => {
    const client = {
      missionControlContextFetch: vi.fn(async () => ({
        inventory: { projects: [] },
        models: {
          cursor: ["gpt-5.6-sol-high", "composer-2.5"],
          "omp.modelRoles": ["task: cursor/gpt-5.6-sol-high:high"],
        },
        recentAgents: [],
        composerPreferences: {
          provider: "cursor",
          providerPreferences: {
            cursor: { model: "composer-2.5", mode: "build" },
          },
        },
      })),
    } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: (name: string) =>
        name === "macbook" ? { name: "macbook", state: "online" as const, lastSeenAt: null } : null,
      getPeerStatuses: () => [{ name: "macbook", state: "online" as const, lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "macbook" ? client : null),
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_list_models", { host: "macbook" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.defaultWorkerModel).toBe("cursor/composer-2.5");
  });

  test("the daemon's own hostAlias resolves to the local branch, never the peer proxy", async () => {
    const client = {
      missionControlContextFetch: vi.fn(async () => ({
        inventory: { projects: [] },
        models: { cursor: ["gpt-5.6-sol-high"] },
        recentAgents: [],
      })),
    } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: () => ({ name: "alpha", state: "online" as const, lastSeenAt: null }),
      getPeerStatuses: () => [{ name: "alpha", state: "online" as const, lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "alpha" ? client : null),
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager, { serverId: "srv__alpha", hostAlias: "alpha" });

    const result = await catalog.executeTool("fleet_list_models", { host: "alpha" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.host).toBe("alpha");
    expect(content.models).toEqual({ omp: ["opencode-zen/deepseek-v4-flash-free"] });
    expect(client.missionControlContextFetch).not.toHaveBeenCalled();
  });

  test("proxies to the peer context and derives the peer's defaultWorkerModel from its task role", async () => {
    const client = {
      missionControlContextFetch: vi.fn(async () => ({
        inventory: { projects: [] },
        models: {
          cursor: ["gpt-5.6-sol-high", "composer-2.5"],
          "omp.modelRoles": ["task: cursor/gpt-5.6-sol-high:high"],
        },
        recentAgents: [],
      })),
    } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: (name: string) =>
        name === "macbook" ? { name: "macbook", state: "online" as const, lastSeenAt: null } : null,
      getPeerStatuses: () => [{ name: "macbook", state: "online" as const, lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "macbook" ? client : null),
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_list_models", { host: "macbook" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(client.missionControlContextFetch).toHaveBeenCalledTimes(1);
    expect(content).toEqual({
      host: "macbook",
      models: {
        cursor: ["gpt-5.6-sol-high", "composer-2.5"],
        "omp.modelRoles": ["task: cursor/gpt-5.6-sol-high:high"],
      },
      defaultWorkerModel: "cursor/gpt-5.6-sol-high",
    });
  });

  test("falls back to the first available model when the peer's task role is missing from its snapshot", async () => {
    const client = {
      missionControlContextFetch: vi.fn(async () => ({
        inventory: { projects: [] },
        models: {
          omp: ["anthropic/claude-fable-5"],
          "omp.modelRoles": ["task: opencode-zen/deepseek-v4-flash-free:high"],
        },
        recentAgents: [],
      })),
    } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: (name: string) =>
        name === "macbook" ? { name: "macbook", state: "online" as const, lastSeenAt: null } : null,
      getPeerStatuses: () => [{ name: "macbook", state: "online" as const, lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "macbook" ? client : null),
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_list_models", { host: "macbook" });
    const content = result.structuredContent as FleetListModelsResult;
    expect(content.defaultWorkerModel).toBe("omp/anthropic/claude-fable-5");
  });

  test("throws when the host is not a configured peer", async () => {
    const catalog = createCatalog();
    await expect(
      catalog.executeTool("fleet_list_models", { host: "unknown-host" }),
    ).rejects.toThrow(/not a configured peer/i);
  });

  test("throws a peer-unreachable error when the host is not online", async () => {
    const peerManager = {
      getPeerStatus: () => ({
        name: "macbook",
        state: "unreachable" as const,
        lastSeenAt: "2026-08-08T00:00:00.000Z",
      }),
      getPeerStatuses: () => [
        { name: "macbook", state: "unreachable" as const, lastSeenAt: "2026-08-08T00:00:00.000Z" },
      ],
      getPeerClient: () => null,
    } as unknown as PeerManager;
    const catalog = createCatalog(peerManager);

    await expect(catalog.executeTool("fleet_list_models", { host: "macbook" })).rejects.toThrow(
      /unreachable/i,
    );
  });
});
