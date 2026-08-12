import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { MissionControlProposalSpawnPlan } from "@getpaseo/protocol/mission-control/types";

import type { MetaPeerManager } from "./meta-actions.js";
import {
  executeSpawnProposal,
  spawnOnThisHost,
  validateSpawnCwd,
  type SpawnExecutorDependencies,
} from "./spawn-executor.js";

/**
 * The spawn executor: the single execution path for approved spawn-kind
 * proposals (Commander fleet_create_agent). Regression coverage for the three
 * live-confirmed spawn bugs:
 *  - (a) a plan whose host is THIS daemon's own alias/serverId/hostname used
 *    to fall into the peer branch ("Host \"alpha\" is not an online peer");
 *    it must resolve to LOCAL through the same fleet map the meta executor
 *    uses.
 *  - (b) a plan whose absolute cwd does not exist used to fail deep in the
 *    create path; the executor must mkdir it (local) or hand the plan to the
 *    peer apply handler, which mkdirs on the TARGET host.
 *  - (4) spawned workers must carry paseo.parent-agent-id = the commander's
 *    agent id in BOTH the local and the peer-routed create (else
 *    isDispatchedByCommander() is false and the finished-event machinery
 *    follow-up is silently gated).
 */

function spawnPlan(
  overrides: Partial<MissionControlProposalSpawnPlan> = {},
): MissionControlProposalSpawnPlan {
  return {
    provider: "omp",
    summary: "Spawn a worker",
    ...overrides,
  };
}

/** Fleet map with one online peer "macbook" (mirrors meta-actions.test.ts). */
function fakePeerManager(): MetaPeerManager {
  return {
    getPeerStatus: (name: string) =>
      name === "macbook"
        ? { name: "macbook", url: "tcp://macbook:6767", state: "online", lastSeenAt: null }
        : null,
    getPeerClient: () => null,
  } as unknown as MetaPeerManager;
}

function buildDeps(overrides: Partial<SpawnExecutorDependencies> = {}): SpawnExecutorDependencies {
  return {
    host: {
      serverId: "srv__alpha",
      hostName: "alpha.local",
      hostAlias: "alpha",
      peerManager: fakePeerManager(),
    },
    stampCommanderParentLabel: true,
    resolveCommanderAgentId: async () => "commander-1",
    mkdirp: async () => undefined,
    createLocally: vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-local",
      serverId: "srv__alpha",
    })),
    createOnPeer: vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-peer",
      serverId: "srv-macbook",
    })),
    ...overrides,
  };
}

describe("executeSpawnProposal host resolution (own alias → local)", () => {
  test("the daemon's own hostAlias resolves to a LOCAL spawn, never the peer path", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({ host: "alpha" }), deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.createLocally).toHaveBeenCalledTimes(1);
    expect(deps.createOnPeer).not.toHaveBeenCalled();
  });

  test("own alias matches case-insensitively with surrounding whitespace trimmed", async () => {
    const deps = buildDeps();
    for (const host of ["ALPHA", " Alpha ", "ALPHA.LOCAL", "SRV__ALPHA"]) {
      const result = await executeSpawnProposal(spawnPlan({ host }), deps);
      expect(result).toMatchObject({ ok: true });
    }
    expect(deps.createLocally).toHaveBeenCalledTimes(4);
    expect(deps.createOnPeer).not.toHaveBeenCalled();
  });

  test("absent host (the plan's default) resolves to a LOCAL spawn", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({}), deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.createLocally).toHaveBeenCalledTimes(1);
  });

  test("a peer name from the fleet map routes to that peer", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({ host: "macbook" }), deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.createOnPeer).toHaveBeenCalledWith("macbook", expect.anything());
    expect(deps.createLocally).not.toHaveBeenCalled();
  });

  test("an unknown host is refused loudly before any create", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({ host: "ghost" }), deps);
    expect(result).toMatchObject({
      ok: false,
      error: 'Host "ghost" is not a configured peer or this host',
    });
    expect(deps.createLocally).not.toHaveBeenCalled();
    expect(deps.createOnPeer).not.toHaveBeenCalled();
  });
});

describe("executeSpawnProposal cwd contract (approval is consent for the shown cwd)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing ABSOLUTE cwd is created with mkdir recursive before a local spawn (fs receipt)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-spawn-cwd-"));
    const missing = join(dir, "nested", "deep", "campaign");
    const mkdirp = vi.fn(async (p: string) => {
      await mkdir(p, { recursive: true });
    });
    const deps = buildDeps({ mkdirp });
    const result = await executeSpawnProposal(spawnPlan({ host: "local", cwd: missing }), deps);
    expect(result).toMatchObject({ ok: true });
    expect(mkdirp).toHaveBeenCalledWith(missing);
    await expect(access(missing)).resolves.toBeUndefined();
    expect(deps.createLocally).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: missing }),
      "omp",
    );
  });

  test("a RELATIVE cwd is still refused (nothing to consent to)", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(
      spawnPlan({ host: "local", cwd: "relative/path" }),
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Spawn cwd must be an absolute path (got "relative/path")',
    });
    expect(deps.createLocally).not.toHaveBeenCalled();
  });

  test("a tilde-prefixed cwd is still refused", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(
      spawnPlan({ host: "local", cwd: "~/projects/x" }),
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Spawn cwd must be an absolute path (got "~/projects/x")',
    });
    expect(deps.createLocally).not.toHaveBeenCalled();
  });

  test("peer targets are forwarded untouched; the commander host never mkdirs for them", async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-spawn-peer-"));
    const missing = join(dir, "peer-cwd", "gamma");
    const mkdirp = vi.fn(async () => undefined);
    const deps = buildDeps({ mkdirp });
    const result = await executeSpawnProposal(spawnPlan({ host: "macbook", cwd: missing }), deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.createOnPeer).toHaveBeenCalledWith(
      "macbook",
      expect.objectContaining({ cwd: missing }),
    );
    // The commander host must NOT have created the peer's cwd.
    expect(mkdirp).not.toHaveBeenCalled();
    await expect(access(missing)).rejects.toThrow();
  });

  test("a RELATIVE cwd on a peer target is refused before forwarding", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(
      spawnPlan({ host: "macbook", cwd: "relative/path" }),
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Spawn cwd must be an absolute path (got "relative/path")',
    });
    expect(deps.createOnPeer).not.toHaveBeenCalled();
  });
});

describe("spawnOnThisHost (the peer apply path: the TARGET host mkdirs)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a missing absolute cwd on THIS host, then creates with the stamped plan", async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-spawn-apply-"));
    const missing = join(dir, "applied", "gamma");
    const mkdirp = vi.fn(async (p: string) => {
      await mkdir(p, { recursive: true });
    });
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-peer",
      serverId: "srv-macbook",
    }));
    const plan = spawnPlan({
      host: "macbook",
      cwd: missing,
      labels: { "paseo.parent-agent-id": "commander-1" },
    });
    const result = await spawnOnThisHost(plan, { mkdirp, createLocally });
    expect(result).toMatchObject({ ok: true, agentId: "worker-peer", serverId: "srv-macbook" });
    // The mkdir happened on the target host's disk (fs receipt).
    await expect(access(missing)).resolves.toBeUndefined();
    // The create ran against THIS host's registry with the plan's labels — the
    // commander's paseo.parent-agent-id stamp persists in the target registry.
    expect(createLocally).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: missing,
        labels: { "paseo.parent-agent-id": "commander-1" },
      }),
      "omp",
    );
  });

  test("a relative cwd is refused by the target host too", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "x",
      serverId: "srv-macbook",
    }));
    const result = await spawnOnThisHost(spawnPlan({ cwd: "relative" }), {
      mkdirp: async () => undefined,
      createLocally,
    });
    expect(result).toMatchObject({ ok: false });
    expect(createLocally).not.toHaveBeenCalled();
  });

  test("an absent cwd creates without a directory (the default cwd resolves downstream)", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "x",
      serverId: "srv-macbook",
    }));
    const mkdirp = vi.fn(async () => undefined);
    const result = await spawnOnThisHost(spawnPlan({}), { mkdirp, createLocally });
    expect(result).toMatchObject({ ok: true });
    expect(mkdirp).not.toHaveBeenCalled();
  });
});

describe("spawnedOnServerId (the executing host's serverId)", () => {
  test("a LOCAL spawn returns this daemon's own serverId", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({ host: "local" }), deps);
    expect(result).toMatchObject({ ok: true, agentId: "worker-local", serverId: "srv__alpha" });
  });

  test("a PEER-routed spawn returns the peer's serverId", async () => {
    const deps = buildDeps();
    const result = await executeSpawnProposal(spawnPlan({ host: "macbook" }), deps);
    expect(result).toMatchObject({ ok: true, agentId: "worker-peer", serverId: "srv-macbook" });
  });

  test("spawnOnThisHost (the peer apply path) returns the TARGET host's serverId", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-peer",
      serverId: "srv-macbook",
    }));
    const result = await spawnOnThisHost(spawnPlan({ host: "macbook" }), {
      mkdirp: async () => undefined,
      createLocally,
    });
    expect(result).toMatchObject({ ok: true, agentId: "worker-peer", serverId: "srv-macbook" });
  });

  test("a failed spawn carries no serverId", async () => {
    const createLocally = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    const deps = buildDeps({
      createLocally,
      createOnPeer: vi.fn(async () => ({ ok: false as const, error: "boom" })),
    });
    expect(await executeSpawnProposal(spawnPlan({ host: "local" }), deps)).toMatchObject({
      ok: false,
      error: "boom",
    });
    expect(await executeSpawnProposal(spawnPlan({ host: "macbook" }), deps)).toMatchObject({
      ok: false,
      error: "boom",
    });
  });
});

describe("BUG-4: paseo.parent-agent-id stamping at execution time", () => {
  test("a commander-origin spawn stamps the commander id on the LOCAL create", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-local",
      serverId: "srv__alpha",
    }));
    const deps = buildDeps({
      createLocally,
      createOnPeer: vi.fn(async () => ({
        ok: true as const,
        agentId: "x",
        serverId: "srv-macbook",
      })),
    });
    await executeSpawnProposal(
      spawnPlan({ host: "local", labels: { "custom.label": "kept" } }),
      deps,
    );
    expect(createLocally).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: { "custom.label": "kept", "paseo.parent-agent-id": "commander-1" },
      }),
      "omp",
    );
  });

  test("a commander-origin spawn carries the stamp to the PEER create (the target persists it)", async () => {
    const createOnPeer = vi.fn(async () => ({
      ok: true as const,
      agentId: "worker-peer",
      serverId: "srv-macbook",
    }));
    const deps = buildDeps({
      createOnPeer,
      createLocally: vi.fn(async () => ({
        ok: true as const,
        agentId: "x",
        serverId: "srv__alpha",
      })),
    });
    await executeSpawnProposal(spawnPlan({ host: "macbook", labels: {} }), deps);
    expect(createOnPeer).toHaveBeenCalledWith(
      "macbook",
      expect.objectContaining({
        labels: { "paseo.parent-agent-id": "commander-1" },
      }),
    );
  });

  test("non-commander (verifier) spawns are never stamped", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "x",
      serverId: "srv__alpha",
    }));
    const deps = buildDeps({ stampCommanderParentLabel: false, createLocally });
    await executeSpawnProposal(spawnPlan({ host: "local", labels: {} }), deps);
    expect(createLocally).toHaveBeenCalledWith(expect.objectContaining({ labels: {} }), "omp");
  });

  test("an unresolvable commander id skips the stamp without failing the spawn", async () => {
    const createLocally = vi.fn(async () => ({
      ok: true as const,
      agentId: "x",
      serverId: "srv__alpha",
    }));
    const deps = buildDeps({ resolveCommanderAgentId: async () => null, createLocally });
    const result = await executeSpawnProposal(spawnPlan({ host: "local" }), deps);
    expect(result).toMatchObject({ ok: true });
    const received = createLocally.mock.calls[0]?.[0] as MissionControlProposalSpawnPlan;
    expect(received.labels?.["paseo.parent-agent-id"]).toBeUndefined();
  });
});

describe("validateSpawnCwd", () => {
  test("absent and absolute cwds pass; relative and tilde cwds refuse", () => {
    expect(validateSpawnCwd(undefined)).toMatchObject({ ok: true });
    expect(validateSpawnCwd("/tmp/campaign")).toMatchObject({ ok: true });
    expect(validateSpawnCwd("relative/path")).toMatchObject({ ok: false });
    expect(validateSpawnCwd("~/projects/x")).toMatchObject({ ok: false });
    expect(validateSpawnCwd(".")).toMatchObject({ ok: false });
  });
});
