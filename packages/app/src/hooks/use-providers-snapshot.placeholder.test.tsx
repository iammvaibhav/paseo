/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  providersSnapshotQueryKey,
  useProvidersSnapshot,
  type ProvidersSnapshotClient,
} from "./use-providers-snapshot";

type MockClient = {
  [K in keyof ProvidersSnapshotClient]: ReturnType<typeof vi.fn<ProvidersSnapshotClient[K]>>;
};

const runtime = vi.hoisted(() => ({
  connected: true,
  client: {
    getProvidersSnapshot: vi.fn(),
    refreshProvidersSnapshot: vi.fn(),
  } as MockClient,
  snapshotEnabled: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: vi.fn(
    (
      selector: (state: {
        sessions: Record<string, { serverInfo?: { features?: Record<string, boolean> } }>;
      }) => boolean,
    ) =>
      selector({
        sessions: {
          "server-1": {
            serverInfo: {
              features: {
                providersSnapshot: runtime.snapshotEnabled,
              },
            },
          },
        },
      }),
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function readyEntry(provider: AgentProvider, modelId: string): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    models: [{ provider, id: modelId, label: modelId }],
  };
}

function snapshotPayload(generatedAt?: string) {
  return {
    cwd: undefined as string | undefined,
    entries: [readyEntry("codex", "gpt-4")],
    generatedAt: generatedAt ?? "2025-01-01T00:00:00.000Z",
    requestId: "test",
  };
}

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useProvidersSnapshot placeholderData", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.client.getProvidersSnapshot = vi.fn<ProvidersSnapshotClient["getProvidersSnapshot"]>(
      async () => snapshotPayload("2025-06-01T00:00:00.000Z"),
    );
    runtime.client.refreshProvidersSnapshot =
      vi.fn<ProvidersSnapshotClient["refreshProvidersSnapshot"]>();

    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("uses sibling cwd data as placeholder so isLoading stays false", async () => {
    // Seed the cache with a ready snapshot for cwd A
    queryClient.setQueryData(
      providersSnapshotQueryKey("server-1", "/repo/a"),
      snapshotPayload("2025-01-01T00:00:00.000Z"),
    );

    const { result } = renderHook(() => useProvidersSnapshot("server-1", { cwd: "/repo/b" }), {
      wrapper: Wrapper,
    });

    // With placeholder data from sibling cwd A, isLoading must be false on first render
    // and entries must be non-empty (from the placeholder).
    expect(result.current.isLoading).toBe(false);
    expect(result.current.entries).toBeDefined();
    expect(result.current.entries!.length).toBeGreaterThan(0);
    expect(result.current.entries![0].provider).toBe("codex");
  });
});
