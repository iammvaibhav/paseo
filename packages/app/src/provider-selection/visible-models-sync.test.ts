import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Config {
  visibleModels?: string[];
}

interface FakeHost {
  serverId: string;
  connected: boolean;
  config: Config;
  models: Record<string, string[]>;
}

const { hosts } = vi.hoisted(() => ({ hosts: [] as FakeHost[] }));

function clientFor(host: FakeHost) {
  return {
    getDaemonConfig: vi.fn(async () => ({ requestId: "r", config: host.config })),
    patchDaemonConfig: vi.fn(async (patch: Config) => {
      host.config = { ...host.config, ...patch };
      return { requestId: "r", config: host.config };
    }),
  };
}

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHosts: () => hosts.map(({ serverId }) => ({ serverId })),
    getClient: (serverId: string) => {
      const host = hosts.find((entry) => entry.serverId === serverId);
      return host ? clientFor(host) : null;
    },
    getSnapshot: (serverId: string) => hosts.find((entry) => entry.serverId === serverId) ?? null,
  }),
  isHostRuntimeConnected: (snapshot: FakeHost | null) => Boolean(snapshot?.connected),
}));

vi.mock("@/data/providers-snapshot", () => ({
  providersSnapshotQueryKey: (serverId: string) => ["providersSnapshot", serverId, "home"],
  fetchProvidersSnapshot: async ({ serverId }: { serverId: string }) => {
    const host = hosts.find((entry) => entry.serverId === serverId)!;
    return {
      entries: Object.entries(host.models).map(([provider, ids]) => ({
        provider,
        models: ids.map((id) => ({ id })),
      })),
    };
  },
}));

import { propagateVisibleModels } from "./visible-models-sync";

beforeEach(() => {
  hosts.length = 0;
});

describe("propagateVisibleModels", () => {
  it("checks the model on every other connected host that offers it, and only there", async () => {
    hosts.push(
      { serverId: "a", connected: true, config: { visibleModels: [] }, models: { omp: ["m1"] } },
      {
        serverId: "b",
        connected: true,
        config: { visibleModels: ["omp:x"] },
        models: { omp: ["m1"] },
      },
      { serverId: "c", connected: true, config: { visibleModels: [] }, models: { omp: ["other"] } },
      { serverId: "d", connected: false, config: { visibleModels: [] }, models: { omp: ["m1"] } },
      { serverId: "e", connected: true, config: {}, models: { omp: ["m1"] } },
    );

    await propagateVisibleModels({
      originServerId: "a",
      keys: ["omp:m1"],
      hidden: false,
      queryClient: new QueryClient(),
    });

    const lists = Object.fromEntries(
      hosts.map((host) => [host.serverId, host.config.visibleModels]),
    );
    expect(lists).toEqual({
      a: [],
      b: ["omp:m1", "omp:x"],
      c: [],
      d: [],
      e: undefined,
    });
  });

  it("unchecks the model on the other hosts that offer it", async () => {
    hosts.push(
      { serverId: "a", connected: true, config: { visibleModels: [] }, models: { omp: ["m1"] } },
      {
        serverId: "b",
        connected: true,
        config: { visibleModels: ["omp:m1", "omp:x"] },
        models: { omp: ["m1", "x"] },
      },
    );

    await propagateVisibleModels({
      originServerId: "a",
      keys: ["omp:m1"],
      hidden: true,
      queryClient: new QueryClient(),
    });

    expect(hosts[1]!.config.visibleModels).toEqual(["omp:x"]);
  });
});
