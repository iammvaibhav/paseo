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
      runtime.allSessions().flatMap((session) => session.prompts.map((prompt) => prompt.message)),
    ).not.toContain(`/move ${CWD_A}`);
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
});
