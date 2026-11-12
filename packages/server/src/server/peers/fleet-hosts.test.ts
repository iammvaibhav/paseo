import { describe, expect, test } from "vitest";
import {
  createFleetHostResolver,
  listFleetHosts,
  type FleetHostPeerSource,
  type FleetHostSources,
} from "./fleet-hosts.js";

// The live fleet as prod's daemon sees it (2026-11-07): prod has no
// missionControl.hostAlias, its DNS names come from daemon.hostnames, and the
// peers carry the identity their server_info declared.
function prodPeerSource(): FleetHostPeerSource {
  return {
    getPeerStatuses: () => [
      { name: "iammvaibhav", state: "online", lastSeenAt: "2026-11-07T08:00:00.000Z" },
      { name: "blrofc3", state: "online", lastSeenAt: "2026-11-07T08:00:00.000Z" },
      { name: "macbook", state: "unreachable", lastSeenAt: null },
    ],
    getPeerIdentities: () => [
      {
        name: "iammvaibhav",
        serverId: "srv_Xn3k4XR6hUgF",
        hostname: "vaibhav-dev",
        missionControlHostAlias: "Personal",
        hostNames: ["iammvaibhav", "vaibhav-dev", "dev.netbird.cloud"],
      },
      {
        name: "blrofc3",
        serverId: "srv_r6FREeF0OQDu",
        hostname: "blrofc3",
        missionControlHostAlias: "Work",
        hostNames: ["work.netbird.cloud"],
      },
      // Never connected: only its name in this host's peers config.
      {
        name: "macbook",
        serverId: null,
        hostname: null,
        missionControlHostAlias: null,
        hostNames: [],
      },
    ],
  };
}

function prodSources(overrides: Partial<FleetHostSources> = {}): FleetHostSources {
  return {
    selfLabel: "local",
    serverId: "srv_lkNe8rjHmlLG",
    hostname: "vaibhav-dev-583222",
    hostAlias: null,
    hostNames: () => ["prod.netbird.cloud", "paseo.thevm.space"],
    peerManager: prodPeerSource(),
    ...overrides,
  };
}

describe("fleet host names", () => {
  test("prod answers to local, its DNS names, hostname and serverId, in any case", () => {
    const resolver = createFleetHostResolver(prodSources());
    for (const name of [
      undefined,
      "",
      "local",
      "prod",
      "PROD",
      " prod ",
      "prod.netbird.cloud",
      "vaibhav-dev-583222",
      "srv_lkNe8rjHmlLG",
    ]) {
      expect(resolver.resolve(name)).toMatchObject({ ok: true, kind: "local" });
    }
  });

  test("a peer answers to its config name and to every name its server_info declared", () => {
    const resolver = createFleetHostResolver(prodSources());
    for (const name of [
      "iammvaibhav",
      "dev",
      "Personal",
      "personal",
      "vaibhav-dev",
      "dev.netbird.cloud",
      "srv_Xn3k4XR6hUgF",
    ]) {
      expect(resolver.resolve(name)).toEqual({
        ok: true,
        kind: "peer",
        peerName: "iammvaibhav",
        label: "iammvaibhav",
      });
    }
    expect(resolver.resolve("work")).toMatchObject({ kind: "peer", peerName: "blrofc3" });
    // Naming is not reachability: an offline peer still resolves, and the
    // tool reports it unreachable.
    expect(resolver.resolve("macbook")).toMatchObject({ kind: "peer", peerName: "macbook" });
  });

  test("the daemon that calls itself by its alias (dev) still reaches prod by name", () => {
    const resolver = createFleetHostResolver({
      selfLabel: "Personal",
      serverId: "srv_Xn3k4XR6hUgF",
      hostname: "vaibhav-dev",
      hostAlias: "Personal",
      hostNames: () => [
        "iammvaibhav",
        "localhost",
        "127.0.0.1",
        "vaibhav-dev",
        "dev.netbird.cloud",
      ],
      peerManager: {
        getPeerStatuses: () => [{ name: "prod", state: "online", lastSeenAt: null }],
        getPeerIdentities: () => [
          {
            name: "prod",
            serverId: "srv_lkNe8rjHmlLG",
            hostname: "vaibhav-dev-583222",
            missionControlHostAlias: null,
            hostNames: ["prod.netbird.cloud", "paseo.thevm.space"],
          },
        ],
      },
    });
    expect(resolver.resolve("Personal")).toMatchObject({ kind: "local" });
    expect(resolver.resolve("dev")).toMatchObject({ kind: "local" });
    expect(resolver.resolve("prod")).toMatchObject({ kind: "peer", peerName: "prod" });
    expect(resolver.resolve("vaibhav-dev-583222")).toMatchObject({
      kind: "peer",
      peerName: "prod",
    });
    // Loopback names and IPs in daemon.hostnames never name a host.
    expect(resolver.resolve("localhost")).toMatchObject({ ok: false, reason: "unknown" });
    expect(resolver.resolve("127.0.0.1")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("central routing.hostAliases names a host by its serverId", () => {
    const resolver = createFleetHostResolver(
      prodSources({
        hostNames: () => [],
        hostAliases: () => ({
          srv_lkNe8rjHmlLG: ["gateway"],
          srv_r6FREeF0OQDu: ["office"],
        }),
      }),
    );
    expect(resolver.resolve("gateway")).toMatchObject({ kind: "local" });
    expect(resolver.resolve("office")).toMatchObject({ kind: "peer", peerName: "blrofc3" });
    // Without daemon.hostnames prod has no DNS names, so "prod" is not invented.
    expect(resolver.resolve("prod")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("an unknown host is refused with every host and its names", () => {
    const resolution = createFleetHostResolver(prodSources()).resolve("ghost");
    expect(resolution).toMatchObject({ ok: false, reason: "unknown" });
    const error = resolution.ok ? "" : resolution.error;
    expect(error).toContain('Host "ghost" is not a configured peer or this host.');
    expect(error).toContain("local (this host; also prod");
    expect(error).toContain("iammvaibhav (online; also Personal, vaibhav-dev, dev");
    expect(error).toContain("macbook (unreachable)");
    expect(error).toContain("fleet_list_hosts");
  });

  test("a name that fits two hosts is refused, never guessed", () => {
    const shared = createFleetHostResolver(
      prodSources({
        hostAliases: () => ({ srv_Xn3k4XR6hUgF: ["builder"], srv_r6FREeF0OQDu: ["builder"] }),
      }),
    );
    expect(shared.resolve("builder")).toMatchObject({ ok: false, reason: "ambiguous" });
    const error = (() => {
      const resolution = shared.resolve("builder");
      return resolution.ok ? "" : resolution.error;
    })();
    expect(error).toContain("iammvaibhav and blrofc3");

    // A peer claiming one of this host's names is ambiguous too.
    const selfClash = createFleetHostResolver(
      prodSources({ hostAliases: () => ({ srv_r6FREeF0OQDu: ["prod"] }) }),
    );
    expect(selfClash.resolve("prod")).toMatchObject({ ok: false, reason: "ambiguous" });
    // The unambiguous names keep working.
    expect(selfClash.resolve("prod.netbird.cloud")).toMatchObject({ kind: "local" });
  });

  test("the listing shows exactly the names a host argument accepts", () => {
    const resolver = createFleetHostResolver(prodSources());
    const listing = listFleetHosts(resolver.directory());
    expect(listing.map((entry) => [entry.host, entry.self, entry.state])).toEqual([
      ["local", true, "online"],
      ["iammvaibhav", false, "online"],
      ["blrofc3", false, "online"],
      ["macbook", false, "unreachable"],
    ]);
    for (const entry of listing) {
      for (const name of entry.names) {
        const resolution = resolver.resolve(name);
        expect(resolution.ok).toBe(true);
        if (resolution.ok && resolution.kind === "peer") {
          expect(resolution.peerName).toBe(entry.host);
        } else {
          expect(entry.self).toBe(true);
        }
      }
    }
    expect(listing[0]?.names).toEqual(
      expect.arrayContaining(["local", "prod", "srv_lkNe8rjHmlLG"]),
    );
  });
});
