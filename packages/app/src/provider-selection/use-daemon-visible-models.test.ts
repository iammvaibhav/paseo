/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { configState, patchConfigMock, connectionState } = vi.hoisted(() => ({
  configState: {
    config: null as { visibleModels?: string[] } | null,
  },
  patchConfigMock: vi.fn(async () => undefined),
  connectionState: {
    isConnected: false,
  },
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => connectionState.isConnected,
}));

import { useHiddenModelsStore } from "./hidden-models";
import { useDaemonVisibleModels } from "./use-daemon-visible-models";

const mounted: Array<{ unmount: () => void }> = [];

beforeEach(() => {
  mounted.length = 0;
  vi.clearAllMocks();
  connectionState.isConnected = false;
  configState.config = null;
  useHiddenModelsStore.setState({ hiddenKeys: new Set<string>() });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

const UNIVERSE = ["omp:model-1", "omp:model-2", "omp:model-3"];

function renderVisibleHook(serverId: string | null, universe: readonly string[] = UNIVERSE) {
  const rendered = renderHook(() => useDaemonVisibleModels(serverId, universe));
  mounted.push(rendered);
  return rendered;
}

describe("useDaemonVisibleModels", () => {
  it("falls back to local store when disconnected", () => {
    connectionState.isConnected = false;
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
    expect(patchConfigMock).not.toHaveBeenCalled();
  });

  it("derives hidden as universe minus visible when daemon list is defined", () => {
    connectionState.isConnected = true;
    configState.config = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1");

    expect(result.current.isDaemon).toBe(true);
    expect([...result.current.hiddenKeys].sort()).toEqual(["omp:model-2", "omp:model-3"]);
  });

  it("hides unknown IDs by default: new models stay out until checked", () => {
    connectionState.isConnected = true;
    configState.config = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1", [...UNIVERSE, "omp:model-new"]);

    expect([...result.current.hiddenKeys].sort()).toEqual([
      "omp:model-2",
      "omp:model-3",
      "omp:model-new",
    ]);
  });

  it("uploads universe minus local hidden once when daemon list is undefined", async () => {
    connectionState.isConnected = true;
    configState.config = {};
    useHiddenModelsStore.setState({
      hiddenKeys: new Set(["omp:model-2", "omp:model-3"]),
    });

    renderVisibleHook("server-upload");

    expect(patchConfigMock).toHaveBeenCalledWith({
      visibleModels: ["omp:model-1"],
    });
  });

  it("does not upload if local store is empty", () => {
    connectionState.isConnected = true;
    configState.config = {};

    renderVisibleHook("server-1");

    expect(patchConfigMock).not.toHaveBeenCalled();
  });

  it("removes the key from visible when hiding in daemon mode", () => {
    connectionState.isConnected = true;
    configState.config = { visibleModels: ["omp:model-1", "omp:model-2"] };

    const { result } = renderVisibleHook("server-1");

    act(() => {
      result.current.setModelHidden("omp", "model-2", true);
    });

    expect(patchConfigMock).toHaveBeenCalledWith({ visibleModels: ["omp:model-1"] });
  });

  it("adds the key to visible when unhiding in daemon mode", () => {
    connectionState.isConnected = true;
    configState.config = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1");

    act(() => {
      result.current.setModelHidden("omp", "model-2", false);
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      visibleModels: ["omp:model-1", "omp:model-2"],
    });
  });

  it("does not call patchConfig if toggle changes nothing", () => {
    connectionState.isConnected = true;
    configState.config = { visibleModels: ["omp:model-1"] };

    const { result } = renderVisibleHook("server-1");

    act(() => {
      result.current.setModelHidden("omp", "model-2", true);
    });

    expect(patchConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to local store when serverId is null", () => {
    connectionState.isConnected = true;
    useHiddenModelsStore.setState({ hiddenKeys: new Set(["omp:model-1"]) });

    const { result } = renderVisibleHook(null);

    expect(result.current.isDaemon).toBe(false);
    expect([...result.current.hiddenKeys]).toEqual(["omp:model-1"]);
    expect(patchConfigMock).not.toHaveBeenCalled();
  });
});
