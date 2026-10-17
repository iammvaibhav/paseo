import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { FakeOmp } from "./test-utils/fake-omp.js";
import { OmpWarmPool, type OmpWarmPoolInput } from "./warm-pool.js";

const CWD_A = "/tmp/paseo-warm-pool-a";
const CWD_B = "/tmp/paseo-warm-pool-b";

function createInput(overrides: Partial<OmpWarmPoolInput> = {}): OmpWarmPoolInput {
  return { cwd: CWD_A, modeId: "ask", extraArgs: [], systemPrompt: "", ...overrides };
}

function createPool(runtime: FakeOmp = new FakeOmp()): { pool: OmpWarmPool; runtime: FakeOmp } {
  return { pool: new OmpWarmPool({ runtime, logger: pino({ level: "silent" }) }), runtime };
}

/** Seed the pool: a cold miss on an empty pool always triggers a background fill behind it. */
async function seedPool(pool: OmpWarmPool, input: OmpWarmPoolInput): Promise<void> {
  expect(await pool.claim(input)).toBeNull();
  await vi.waitFor(() => expect(pool.hasIdleProcess()).toBe(true));
}

describe("OmpWarmPool", () => {
  test("claim retargets an idle process to the requested cwd and reports it moved", async () => {
    const { pool, runtime } = createPool();
    const input = createInput();
    await seedPool(pool, input);

    const claimed = await pool.claim({ ...input, cwd: CWD_B });

    expect(claimed).not.toBeNull();
    expect(claimed?.moved).toBe(true);
    expect(
      runtime
        .allSessions()
        .flatMap((session) => session.prompts)
        .filter((prompt) => prompt.message === `/move ${CWD_B}`),
    ).toHaveLength(1);
  });

  test("prewarm is a no-op with no idle process to move", () => {
    const { pool } = createPool();
    // Nothing has ever claimed from this pool, so it has no tracked launch
    // shape and no entries; prewarm must not throw.
    expect(() => pool.prewarm(CWD_B)).not.toThrow();
  });

  test("prewarm is a no-op when the only idle process already sits at that cwd", async () => {
    const { pool, runtime } = createPool();
    const input = createInput();
    await seedPool(pool, input);

    // A no-op prewarm never starts a move, so nothing is scheduled at all —
    // this can be asserted synchronously right after the call.
    pool.prewarm(CWD_A);

    expect(
      runtime
        .allSessions()
        .flatMap((session) => session.prompts)
        .filter((prompt) => prompt.message === `/move ${CWD_A}`),
    ).toHaveLength(0);
  });

  test("prewarm moves an idle process ahead of a claim for the same cwd, and claim rides that move instead of sending its own", async () => {
    const { pool, runtime } = createPool();
    const input = createInput();
    await seedPool(pool, input);

    // Fire-and-forget prewarm, then claim immediately (no await in between):
    // this races the claim against the still in-flight `/move`.
    pool.prewarm(CWD_B);
    const claimStartedAt = Date.now();
    const claimed = await pool.claim({ ...input, cwd: CWD_B });
    const claimMs = Date.now() - claimStartedAt;

    expect(claimed).not.toBeNull();
    expect(claimed?.moved).toBe(false);
    expect(claimMs).toBeLessThan(100);
    expect(
      runtime
        .allSessions()
        .flatMap((session) => session.prompts)
        .filter((prompt) => prompt.message === `/move ${CWD_B}`),
    ).toHaveLength(1);
  });

  test("a claim for a launch shape the pool never tracked cold-misses without touching prewarm state", async () => {
    const { pool } = createPool();
    const claimed = await pool.claim(createInput({ modeId: "write" }));
    expect(claimed).toBeNull();
  });

  test("pooled processes launch without --session so omp mints the throwaway itself", async () => {
    const { pool, runtime } = createPool();
    await seedPool(pool, createInput());

    expect(runtime.recordedLaunches.length).toBeGreaterThan(0);
    for (const launch of runtime.recordedLaunches) {
      expect(launch.argv).not.toContain("--session");
    }
  });

  test("a failed fill backs off instead of respawning on every claim", async () => {
    let starts = 0;
    const failures: unknown[] = [];
    const runtime = {
      startSession: async () => {
        starts += 1;
        throw new Error('Session "/x.jsonl" not found.');
      },
    } as unknown as FakeOmp;
    const logger = pino({ level: "silent" });
    logger.warn = ((payload: unknown) => {
      failures.push(payload);
    }) as typeof logger.warn;
    const pool = new OmpWarmPool({ runtime, logger });

    // A cold miss starts both fills; both fail and arm the backoff.
    expect(await pool.claim(createInput())).toBeNull();
    await vi.waitFor(() => expect(failures).toHaveLength(2));
    expect(starts).toBe(2);

    // Inside the backoff window a claim neither hands out nor respawns. A fill
    // calls startSession synchronously, so none can still be pending here.
    expect(await pool.claim(createInput())).toBeNull();
    expect(starts).toBe(2);
  });

  // Exercises the real fs.watch backend: the watcher wiring is the behavior
  // under test, so the clock cannot be faked. waitFor polls the condition.
  test.each(["config.yml", "models.yml", "agents/new-agent.md"])(
    "a change to omp's %s retires idle processes and boots replacements",
    async (changedFile) => {
      const configDir = await mkdtemp(path.join(tmpdir(), "paseo-omp-config-"));
      try {
        await mkdir(path.join(configDir, "agents"));
        await writeFile(path.join(configDir, "config.yml"), "theme: dark\n");
        const runtime = new FakeOmp();
        const pool = new OmpWarmPool({ runtime, logger: pino({ level: "silent" }), configDir });
        pool.start();
        await seedPool(pool, createInput());
        const original = runtime.allSessions().filter((session) => !session.closed);
        expect(original.length).toBeGreaterThan(0);

        await writeFile(path.join(configDir, changedFile), "changed: true\n");

        await vi.waitFor(
          () => {
            for (const session of original) expect(session.closed).toBe(true);
          },
          { timeout: 5_000 },
        );
        await vi.waitFor(() => expect(pool.hasIdleProcess()).toBe(true));
        const claimed = await pool.claim(createInput());
        expect(claimed).not.toBeNull();
        expect(original).not.toContain(claimed?.session);
        await pool.closeAll();
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    },
  );
});
