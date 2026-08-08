import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  buildInvocableProviderModelStrings,
  intersectInvocableProviderModelStrings,
  resolveCommanderHostServerId,
} from "./model-options";
import type { HostProfile } from "@/types/host-connection";

function snapshotEntry(
  provider: string,
  modelIds: string[],
  enabled = true,
): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled,
    models: modelIds.map((id) => ({ provider, id, label: id })),
  };
}

describe("model-options", () => {
  describe("buildInvocableProviderModelStrings", () => {
    it("builds provider/modelId set for enabled entries", () => {
      const entries: ProviderSnapshotEntry[] = [
        snapshotEntry("omp", ["anthropic/claude-fable-5", "opencode-go/deepseek-v4-flash"]),
        snapshotEntry("codex", ["gpt-5.4"]),
        snapshotEntry("disabled-prov", ["model-1"], false),
      ];
      const result = buildInvocableProviderModelStrings(entries);
      expect(Array.from(result).sort()).toEqual([
        "codex/gpt-5.4",
        "omp/anthropic/claude-fable-5",
        "omp/opencode-go/deepseek-v4-flash",
      ]);
    });

    it("returns empty set for undefined or empty entries", () => {
      expect(buildInvocableProviderModelStrings(undefined).size).toBe(0);
      expect(buildInvocableProviderModelStrings([]).size).toBe(0);
    });
  });

  describe("intersectInvocableProviderModelStrings", () => {
    it("returns intersection across multiple host snapshots", () => {
      const host1 = [
        snapshotEntry("omp", ["anthropic/claude-fable-5", "opencode-go/deepseek-v4-flash"]),
        snapshotEntry("codex", ["gpt-5.4"]),
      ];
      const host2 = [
        snapshotEntry("omp", ["opencode-go/deepseek-v4-flash", "other/model"]),
        snapshotEntry("codex", ["gpt-5.4"]),
      ];
      const result = intersectInvocableProviderModelStrings([host1, host2]);
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(Array.from(result.strings).sort()).toEqual([
          "codex/gpt-5.4",
          "omp/opencode-go/deepseek-v4-flash",
        ]);
      }
    });

    it("returns unreachable if any host snapshot is undefined", () => {
      const host1 = [snapshotEntry("codex", ["gpt-5.4"])];
      const result = intersectInvocableProviderModelStrings([host1, undefined]);
      expect(result.status).toBe("unreachable");
    });

    it("returns empty status if intersection has zero models", () => {
      const host1 = [snapshotEntry("codex", ["gpt-5.4"])];
      const host2 = [snapshotEntry("omp", ["opencode-go/deepseek-v4-flash"])];
      const result = intersectInvocableProviderModelStrings([host1, host2]);
      expect(result.status).toBe("empty");
    });
  });

  describe("resolveCommanderHostServerId", () => {
    const hosts: HostProfile[] = [
      {
        serverId: "server-1",
        label: "MacBook Pro",
        appearance: {} as never,
        lifecycle: {},
        connections: [],
        preferredConnectionId: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        serverId: "server-2",
        label: "iammvaibhav",
        appearance: {} as never,
        lifecycle: {},
        connections: [],
        preferredConnectionId: null,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const hostnameMap = new Map<string, string | null>([
      ["server-1", "macbook.local"],
      ["server-2", "iammvaibhav"],
    ]);

    it("resolves hostname match", () => {
      expect(
        resolveCommanderHostServerId({
          commanderHost: "iammvaibhav",
          hosts,
          hostnameByServerId: hostnameMap,
          localServerId: "server-1",
        }),
      ).toBe("server-2");
    });

    it("resolves direct serverId match", () => {
      expect(
        resolveCommanderHostServerId({
          commanderHost: "server-1",
          hosts,
          hostnameByServerId: hostnameMap,
          localServerId: "server-1",
        }),
      ).toBe("server-1");
    });

    it("resolves local match to localServerId", () => {
      expect(
        resolveCommanderHostServerId({
          commanderHost: "local",
          hosts,
          hostnameByServerId: hostnameMap,
          localServerId: "server-1",
        }),
      ).toBe("server-1");
    });

    it("returns null for unknown commander host", () => {
      expect(
        resolveCommanderHostServerId({
          commanderHost: "unknown-box",
          hosts,
          hostnameByServerId: hostnameMap,
          localServerId: "server-1",
        }),
      ).toBeNull();
    });

    it("returns null for null commander host", () => {
      expect(
        resolveCommanderHostServerId({
          commanderHost: null,
          hosts,
          hostnameByServerId: hostnameMap,
          localServerId: "server-1",
        }),
      ).toBeNull();
    });
  });
});
