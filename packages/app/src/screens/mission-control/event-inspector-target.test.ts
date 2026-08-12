import { describe, expect, it, vi } from "vitest";
import { resolveEventAgentServerId, type SpawnHostCarryingEvent } from "./event-inspector-target";
import type { HostInfoByServerId } from "./commander-host";

// The module also defines the store-backed convenience resolver, so its
// host-runtime import runs on module load — the real module pulls in
// RN/desktop deps that do not load in a plain node test env. The pure
// resolver under test never touches the store; only the mock's shape matters.
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getHosts: () => [] }),
}));

const hosts: readonly { serverId: string }[] = [
  { serverId: "srv-commander" },
  { serverId: "srv-macbook" },
];

const hostInfoByServerId: HostInfoByServerId = {
  "srv-commander": { hostname: "commander-a.local", hostAlias: null },
  "srv-macbook": { hostname: "macbook.local", hostAlias: "macbook" },
};

function spawnCard(input: { serverId?: string; host?: string | null }): SpawnHostCarryingEvent {
  return {
    serverId: input.serverId ?? "srv-commander",
    proposal: {
      kind: "spawn",
      ...(input.host !== undefined ? { spawnPlan: { host: input.host } } : {}),
    },
  };
}

describe("resolveEventAgentServerId", () => {
  it("resolves a spawn plan host alias to the connected host", () => {
    expect(
      resolveEventAgentServerId(spawnCard({ host: "macbook" }), hosts, hostInfoByServerId),
    ).toBe("srv-macbook");
  });

  it("resolves a spawn plan host by server_info hostname", () => {
    expect(
      resolveEventAgentServerId(spawnCard({ host: "macbook.local" }), hosts, hostInfoByServerId),
    ).toBe("srv-macbook");
  });

  it("resolves a spawn plan host that is already a serverId", () => {
    expect(
      resolveEventAgentServerId(spawnCard({ host: "srv-macbook" }), hosts, hostInfoByServerId),
    ).toBe("srv-macbook");
  });

  it('treats "local" as the card\'s own host (emitting server)', () => {
    expect(resolveEventAgentServerId(spawnCard({ host: "local" }), hosts, hostInfoByServerId)).toBe(
      "srv-commander",
    );
    expect(resolveEventAgentServerId(spawnCard({ host: "LOCAL" }), hosts, hostInfoByServerId)).toBe(
      "srv-commander",
    );
  });

  it("falls back to the emitting host when the alias cannot be resolved", () => {
    expect(resolveEventAgentServerId(spawnCard({ host: "ghost" }), hosts, hostInfoByServerId)).toBe(
      "srv-commander",
    );
  });

  it("falls back to the emitting host when the plan names no host", () => {
    expect(resolveEventAgentServerId(spawnCard({ host: null }), hosts, hostInfoByServerId)).toBe(
      "srv-commander",
    );
    expect(resolveEventAgentServerId(spawnCard({}), hosts, hostInfoByServerId)).toBe(
      "srv-commander",
    );
  });

  it("keeps the emitting host for non-spawn cards", () => {
    const sendCard: SpawnHostCarryingEvent = {
      serverId: "srv-commander",
      proposal: { kind: "send" },
    };
    expect(resolveEventAgentServerId(sendCard, hosts, hostInfoByServerId)).toBe("srv-commander");
    const plainCard: SpawnHostCarryingEvent = { serverId: "srv-macbook" };
    expect(resolveEventAgentServerId(plainCard, hosts, hostInfoByServerId)).toBe("srv-macbook");
  });
});
