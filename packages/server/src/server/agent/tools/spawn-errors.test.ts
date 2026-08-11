import { describe, expect, test, vi } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotEntry } from "../agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

function snapshotEntry(provider: string, models: string[]): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    models: models.map((id) => ({ provider, id })),
  };
}

function createHarness(
  options: {
    localModels?: Array<{ provider: string; models: string[] }>;
    peerModels?: Array<{ provider: string; models: string[] }>;
    peerError?: Error;
  } = {},
) {
  const stub = createProviderSnapshotManagerStub();
  stub.listProviders.mockResolvedValue(
    options.localModels ?? [
      snapshotEntry("omp", ["anthropic/claude-fable-5", "opencode-go/deepseek-v4-flash"]),
      snapshotEntry("codex", ["gpt-5.4"]),
    ],
  );
  stub.resolveCreateConfig.mockRejectedValue(
    options.peerError ?? new Error("Provider opencode-zen is not configured"),
  );
  const peerClient = {
    createAgent: vi.fn(async () => {
      throw options.peerError ?? new Error("Provider opencode-zen is not configured");
    }),
    getProvidersSnapshot: vi.fn(async () => ({
      entries: options.peerModels ?? [snapshotEntry("omp", ["anthropic/claude-sonnet-5"])],
    })),
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) => ({ name, state: "online" as const, lastSeenAt: null }),
    getPeerClient: (name: string) => (name === "macbook" ? peerClient : null),
  } as unknown as PeerManager;
  const catalog = createPaseoToolCatalog({
    agentManager: {} as unknown as AgentManager,
    agentStorage: {} as unknown as AgentStorage,
    providerSnapshotManager: stub.manager as unknown as ProviderSnapshotManager,
    // Top-level create without a workspaceId mints one; supply it so the call
    // reaches the provider rejection.
    ensureWorkspaceForCreate: async () => "ws-test",
    peerManager,
    logger: createTestLogger(),
  });
  return { catalog, stub, peerClient };
}

describe("actionable spawn provider rejections", () => {
  test("schema-validation rejection teaches host, rejected value, and valid strings", async () => {
    const { catalog } = createHarness();
    const error = await catalog
      .executeTool("create_agent", {
        provider: "opencode-zen",
        title: "worker",
        initialPrompt: "do the thing",
      })
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('create_agent rejected provider "opencode-zen" on host local');
    expect(error.message).toContain("provider must be provider/model, for example codex/gpt-5.4");
    expect(error.message).toContain(
      "Valid invocable provider/model strings on local (exactly what create_agent/fleet_create_agent accept)",
    );
    expect(error.message).toContain("- omp/anthropic/claude-fable-5");
    expect(error.message).toContain("- codex/gpt-5.4");
  });

  test("not-configured rejection teaches host, rejected value, and valid strings", async () => {
    const { catalog } = createHarness();
    const error = await catalog
      .executeTool("create_agent", {
        provider: "opencode-zen/deepseek-v4-flash-free",
        title: "worker",
        initialPrompt: "do the thing",
      })
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toContain(
      'create_agent rejected provider "opencode-zen/deepseek-v4-flash-free" on host local',
    );
    expect(error.message).toContain("Provider opencode-zen is not configured");
    expect(error.message).toContain("- omp/opencode-go/deepseek-v4-flash");
  });

  test("nearest matches rank first and the list is capped with a count", async () => {
    const { catalog } = createHarness({
      localModels: [
        snapshotEntry("omp", [
          "opencode-zen/deepseek-v4-flash",
          ...Array.from({ length: 40 }, (_, index) => `other/model-${index}`),
        ]),
      ],
    });
    const error = await catalog
      .executeTool("create_agent", {
        provider: "opencode-zen/deepseek-v4-flash-free",
        title: "worker",
        initialPrompt: "do the thing",
      })
      .catch((caught: unknown) => caught as Error);
    const suggestions = error.message.split("Valid invocable")[1] ?? "";
    // The nearest match leads the suggestions.
    const nearestIndex = suggestions.indexOf("- omp/opencode-zen/deepseek-v4-flash");
    expect(nearestIndex).toBeGreaterThan(-1);
    expect(suggestions.indexOf("- omp/other/model-0")).toBeGreaterThan(nearestIndex);
    // Capped: not all 41 strings, and a count tells the Commander the rest.
    expect(suggestions).toContain("(41 invocable strings on this host)");
    expect(error.message.match(/- /g)?.length ?? 0).toBeLessThanOrEqual(8);
  });

  test("fleet_create_agent peer rejection lists the PEER host's invocable strings", async () => {
    const { catalog, peerClient } = createHarness({
      peerModels: [
        snapshotEntry("omp", ["anthropic/claude-sonnet-5", "opencode-go/deepseek-v4-flash"]),
      ],
      peerError: new Error("Provider claude is not configured"),
    });
    const error = await catalog
      .executeTool("fleet_create_agent", {
        host: "macbook",
        provider: "claude/claude-sonnet-5",
        cwd: "/repo",
        title: "worker",
        initialPrompt: "do the thing",
      })
      .catch((caught: unknown) => caught as Error);
    // The peer create RPC is the SESSION create path: provider must be a
    // plain provider id with model passed separately (the MCP/local path
    // splits "provider/model" itself). Passing the combined string made every
    // peer spawn fail with "Provider provider/model is not configured".
    expect(peerClient.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", model: "claude-sonnet-5" }),
    );
    expect(error.message).toContain(
      'fleet_create_agent rejected provider "claude/claude-sonnet-5" on host macbook',
    );
    expect(error.message).toContain("Provider claude is not configured");
    expect(error.message).toContain(
      "on macbook (exactly what create_agent/fleet_create_agent accept)",
    );
    expect(error.message).toContain("- omp/anthropic/claude-sonnet-5");
    expect(error.message).toContain("- omp/opencode-go/deepseek-v4-flash");
  });

  test("non-provider errors pass through unmodified", async () => {
    const { catalog, stub } = createHarness();
    stub.resolveCreateConfig.mockRejectedValue(new Error("Workspace provisioning failed"));
    const error = await catalog
      .executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "worker",
        initialPrompt: "do the thing",
      })
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toBe("Workspace provisioning failed");
  });
});
