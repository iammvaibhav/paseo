import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pino from "pino";
import {
  PlannotatorSessionManager,
  type PlannotatorSessionEventPayload,
} from "./session-manager.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const FAKE_BINARY = "/bin/sh";

type SpawnOptionsWithEnv = Parameters<typeof spawn>[2] & { env?: NodeJS.ProcessEnv };

type EncodingEmitter = EventEmitter & { setEncoding: (encoding: string) => void };

interface RecordedSpawn {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function fakeEncodingEmitter(): EncodingEmitter {
  const emitter = new EventEmitter() as EncodingEmitter;
  emitter.setEncoding = vi.fn();
  return emitter;
}

/** Fake plannotator child process that terminates as soon as it is signalled. */
function createFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const mutable = child as unknown as { exitCode: number | null };
  child.stdout = fakeEncodingEmitter();
  child.stderr = fakeEncodingEmitter();
  mutable.exitCode = null;
  child.kill = vi.fn(() => {
    mutable.exitCode = 0;
  });
  return child;
}

/** Fake `plannotator` binary: records argv/cwd/env and signals readiness immediately. */
function installFakeSpawner(): RecordedSpawn[] {
  const recorded: RecordedSpawn[] = [];
  vi.mocked(spawn).mockImplementation(((_command: string, argv: string[], options?) => {
    const spawnOptions = options as SpawnOptionsWithEnv | undefined;
    const env = spawnOptions?.env ?? {};
    recorded.push({ argv, cwd: spawnOptions?.cwd ?? "", env });
    // Ready file content must start with "{" for waitForReady to accept it.
    writeFileSync(env.PLANNOTATOR_READY_FILE ?? "", "{}");
    return createFakeChild();
  }) as typeof spawn);
  return recorded;
}

function createManager(
  onEvent: (event: PlannotatorSessionEventPayload) => void = () => {},
): PlannotatorSessionManager {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as pino.Logger;
  return new PlannotatorSessionManager({
    logger,
    onEvent,
    binaryPath: FAKE_BINARY,
  });
}

describe("PlannotatorSessionManager review sessions", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "paseo-plannotator-test-"));
  });

  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("spawns `review --git` in the workspace for local working-tree review", async () => {
    const spawns = installFakeSpawner();
    const manager = createManager();
    const result = await manager.startReviewSession({ workspaceDir });

    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(spawns).toHaveLength(1);
    expect(spawns[0].argv).toEqual(["review", "--git"]);
    expect(spawns[0].cwd).toBe(resolve(workspaceDir));
    expect(spawns[0].env.PLANNOTATOR_SKIP_BROWSER_OPEN).toBe("1");
    await manager.stopAll();
  });

  it("spawns `review <prUrl>` when a PR URL is given", async () => {
    const spawns = installFakeSpawner();
    const manager = createManager();
    const prUrl = "https://github.com/acme/repo/pull/42";
    const result = await manager.startReviewSession({ workspaceDir, prUrl });

    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(spawns).toHaveLength(1);
    expect(spawns[0].argv).toEqual(["review", prUrl]);
    await manager.stopAll();
  });

  it("reuses the live review session for the same workspace instead of respawning", async () => {
    const spawns = installFakeSpawner();
    const manager = createManager();
    const first = await manager.startReviewSession({ workspaceDir });
    const second = await manager.startReviewSession({ workspaceDir });

    if ("error" in first) {
      throw new Error(first.error);
    }
    expect(second).toEqual(first);
    expect(spawns).toHaveLength(1);
    await manager.stopAll();
  });

  it("still enforces the annotate path allowlist against workspaceDir", async () => {
    const spawns = installFakeSpawner();
    const manager = createManager();
    const result = await manager.startAnnotateSession({
      path: "/etc/hosts",
      workspaceDir,
    });

    expect(result).toEqual({ error: "Path is outside the workspace" });
    expect(spawns).toHaveLength(0);
    await manager.stopAll();
  });
});
