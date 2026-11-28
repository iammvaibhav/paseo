/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VisibleModelsSync from "./visible-models-sync";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

interface Config {
  visibleModels?: string[];
}

const { cachedConfig, daemon, connectionState, propagateMock } = vi.hoisted(() => ({
  // What this client's query cache holds (null while the config is loading).
  cachedConfig: { value: null as Config | null },
  // What the host actually has on disk.
  daemon: { config: {} as Config },
  connectionState: { isConnected: false },
  propagateMock: vi.fn(async () => undefined),
}));

const client = {
  getDaemonConfig: vi.fn(async () => ({ requestId: "r", config: daemon.config })),
  patchDaemonConfig: vi.fn(async (patch: Config) => {
    daemon.config = { ...daemon.config, ...patch };
    return { requestId: "r", config: daemon.config };
  }),
};

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: cachedConfig.value,
    isLoading: cachedConfig.value === null,
    patchConfig: vi.fn(),
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => connectionState.isConnected,
  getHostRuntimeStore: () => ({ getHosts: () => [] }),
  isHostRuntimeConnected: () => true,
}));

vi.mock("./visible-models-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof VisibleModelsSync>()),
  propagateVisibleModels: propagateMock,
}));

import { useHiddenModelsStore } from "./hidden-models";
import { useDaemonVisibleModels } from "./use-daemon-visible-models";

const mounted: Array<{ unmount: () => void }> = [];

beforeEach(() => {
  mounted.length = 0;
  vi.clearAllMocks();
  connectionState.isConnected = false;
  cachedConfig.value = null;
  daemon.config = {};
  useHiddenModelsStore.setState({ hiddenKeys: new Set<string>() });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

const UNIVERSE = ["omp:model-1", "omp:model-2", "omp:model-3"];

function renderVisibleHook(serverId: string | null, universe: readonly string[] = UNIVERSE) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const rendered = renderHook(() => useDaemonVisibleModels(serverId, universe), { wrapper });
  mounted.push(rendered);
  return rendered;
}

describe("useDaemonVisibleModels", () => {
  it("falls back to local store when disconnected", () => {
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["omp:model-1"]) });

    const { result } = renderVisibleHook("server-1");

    expect(result.current.isDaemon).toBe(false);
    expect([...result.current.hiddenKeys]).toEqual(["omp:model-1"]);

    act(() => {
      result.current.setModelHidden("omp", "model-2", true);
    });

    expect([...useHiddenModelsStore.getState().hiddenKeys].sort()).toEqual([
      "omp:model-1",
      "omp:model-2",
    ]);
    expect(client.patchDaemonConfig).not.toHaveBeenCalled();
  });

  it("hides unknown IDs by default: new models stay out until checked", () => {
    connectionState.isConnected = true;
    cachedConfig.value = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1", [...UNIVERSE, "omp:model-new"]);

    expect(result.current.isDaemon).toBe(true);
    expect([...result.current.hiddenKeys].sort()).toEqual([
      "omp:model-2",
      "omp:model-3",
      "omp:model-new",
    ]);
  });

  it("never overwrites the host's list while its config is still loading", async () => {
    connectionState.isConnected = true;
    cachedConfig.value = null;
    daemon.config = { visibleModels: ["omp:model-1"] };
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["omp:model-2"]) });

    renderVisibleHook("server-1");
    await act(async () => {});

    expect(client.patchDaemonConfig).not.toHaveBeenCalled();
    expect(daemon.config.visibleModels).toEqual(["omp:model-1"]);
  });

  it("seeds a host that has no list from the local choices, once loaded", async () => {
    connectionState.isConnected = true;
    cachedConfig.value = {};
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["omp:model-2", "omp:model-3"]) });

    renderVisibleHook("server-upload");

    await vi.waitFor(() => expect(daemon.config.visibleModels).toEqual(["omp:model-1"]));
  });

  it("checks a model against the host's current list, not a stale cache", async () => {
    connectionState.isConnected = true;
    cachedConfig.value = { visibleModels: ["omp:model-1"] };
    // Another client already checked model-3 on this host.
    daemon.config = { visibleModels: ["omp:model-1", "omp:model-3"] };

    const { result } = renderVisibleHook("server-1");
    act(() => {
      result.current.setModelHidden("omp", "model-2", false);
    });

    await vi.waitFor(() =>
      expect(daemon.config.visibleModels).toEqual(["omp:model-1", "omp:model-2", "omp:model-3"]),
    );
    expect(propagateMock).toHaveBeenCalledWith(
      expect.objectContaining({ originServerId: "server-1", keys: ["omp:model-2"], hidden: false }),
    );
  });

  it("keeps both of two quick toggles", async () => {
    connectionState.isConnected = true;
    cachedConfig.value = { visibleModels: ["omp:model-1"] };
    daemon.config = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1");
    act(() => {
      result.current.setModelHidden("omp", "model-2", false);
      result.current.setModelHidden("omp", "model-3", false);
    });

    await vi.waitFor(() =>
      expect(daemon.config.visibleModels).toEqual(["omp:model-1", "omp:model-2", "omp:model-3"]),
    );
  });
});
