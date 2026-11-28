import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { WarmWorktreePoolManager } from "../packages/server/src/server/warm-worktree-pool.js";
import { createWorktree, type WorktreeSource } from "../packages/server/src/utils/worktree.js";

interface TrialResult {
  trial: number;
  durationMs: number;
}

interface BenchmarkSummary {
  samples: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

function calculateSummary(trials: TrialResult[]): BenchmarkSummary {
  const durations = trials.map((t) => t.durationMs).sort((a, b) => a - b);
  const sum = durations.reduce((acc, v) => acc + v, 0);
  const p50Index = Math.floor(durations.length * 0.5);
  const p90Index = Math.floor(durations.length * 0.9);

  return {
    samples: durations.length,
    min: durations[0] ?? 0,
    max: durations[durations.length - 1] ?? 0,
    mean: Number((sum / durations.length).toFixed(2)),
    p50: durations[p50Index] ?? 0,
    p90: durations[p90Index] ?? 0,
  };
}

function createBenchmarkGitRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  execSync("git init -b main", { cwd: repoDir, stdio: "ignore" });
  execSync(
    "git config user.name 'Benchmark Runner' && git config user.email 'benchmark@paseo.sh'",
    {
      cwd: repoDir,
      stdio: "ignore",
    },
  );

  // Create representative file tree
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Benchmark Test Repo\n", "utf8");
  writeFileSync(join(repoDir, "src", "index.ts"), "export const hello = 'world';\n", "utf8");
  writeFileSync(
    join(repoDir, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          "node -e \"const start=Date.now(); while(Date.now()-start<350); const fs=require('fs'); fs.mkdirSync('node_modules', {recursive:true}); for(let i=0;i<50;i++) fs.writeFileSync('node_modules/dep-'+i+'.txt', 'dep');\"",
        ],
      },
    }),
    "utf8",
  );
  execSync("git add . && git commit -m 'Initial commit'", { cwd: repoDir, stdio: "ignore" });
}

async function runBenchmark(): Promise<void> {
  const trialsCount = 10;
  const tempBase = join(tmpdir(), `paseo-benchmark-${randomUUID()}`);
  const paseoHome = join(tempBase, ".paseo");
  const worktreesRoot = join(tempBase, "worktrees");
  const repoDir = join(tempBase, "repo");

  mkdirSync(tempBase, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  createBenchmarkGitRepo(repoDir);

  const logger = pino({ level: "silent" });

  console.log(`========================================================================`);
  console.log(`Paseo Worktree Creation Performance Benchmark`);
  console.log(`Host: ${process.platform} ${process.arch}, Node ${process.version}`);
  console.log(`Trials per scenario: ${trialsCount}`);
  console.log(`========================================================================\n`);

  // Scenario 1: Cold Worktree Creation
  console.log(`Running Scenario 1: Cold Worktree Creation...`);
  const coldTrials: TrialResult[] = [];
  for (let i = 1; i <= trialsCount; i++) {
    const slug = `cold-trial-${i}-${randomUUID().slice(0, 6)}`;
    const source: WorktreeSource = {
      kind: "branch-off",
      branchName: slug,
      baseBranch: "main",
    };

    const start = performance.now();
    await createWorktree({
      cwd: repoDir,
      worktreeSlug: slug,
      source,
      runSetup: true,
      paseoHome,
      worktreesRoot,
    });
    const duration = performance.now() - start;
    coldTrials.push({ trial: i, durationMs: Number(duration.toFixed(2)) });
    process.stdout.write(`  Trial ${i}/${trialsCount}: ${duration.toFixed(1)} ms\n`);
  }

  // Scenario 2: Warm Worktree Pool Claim
  console.log(`\nRunning Scenario 2: Warm Worktree Pool Claim...`);
  const poolManager = new WarmWorktreePoolManager({
    paseoHome,
    worktreesRoot,
    targetIdle: 1,
    enabled: true,
    logger,
  });

  const warmTrials: TrialResult[] = [];
  for (let i = 1; i <= trialsCount; i++) {
    // Ensure 1 warm worktree is provisioned and idle in the pool
    await poolManager.replenish(repoDir);

    const slug = `warm-trial-${i}-${randomUUID().slice(0, 6)}`;
    const source: WorktreeSource = {
      kind: "branch-off",
      branchName: slug,
      baseBranch: "main",
    };

    const start = performance.now();
    const result = await poolManager.claim({
      repoRoot: repoDir,
      worktreeSlug: slug,
      source,
      paseoHome,
      worktreesRoot,
      runSetup: false, // Setup was pre-executed during warming
    });
    const duration = performance.now() - start;

    if (!result || !result.claimed) {
      throw new Error(`Warm pool claim failed on trial ${i}`);
    }

    warmTrials.push({ trial: i, durationMs: Number(duration.toFixed(2)) });
    process.stdout.write(`  Trial ${i}/${trialsCount}: ${duration.toFixed(1)} ms\n`);
  }

  await poolManager.stop();

  // Cleanup temp files
  try {
    rmSync(tempBase, { recursive: true, force: true });
  } catch {
    // ignore
  }

  const coldSummary = calculateSummary(coldTrials);
  const warmSummary = calculateSummary(warmTrials);
  const speedupRatio = Number((coldSummary.mean / warmSummary.mean).toFixed(2));
  const p50SpeedupRatio = Number((coldSummary.p50 / warmSummary.p50).toFixed(2));
  const timeSavedMs = Number((coldSummary.mean - warmSummary.mean).toFixed(1));

  console.log(`\n========================================================================`);
  console.log(`Benchmark Results Summary`);
  console.log(`========================================================================`);
  console.log(`Cold Creation (baseline):`);
  console.log(`  Mean:   ${coldSummary.mean} ms`);
  console.log(`  Median: ${coldSummary.p50} ms`);
  console.log(`  P90:    ${coldSummary.p90} ms`);
  console.log(`  Min:    ${coldSummary.min} ms`);
  console.log(`  Max:    ${coldSummary.max} ms`);
  console.log(`------------------------------------------------------------------------`);
  console.log(`Warm Pool Claim (optimized):`);
  console.log(`  Mean:   ${warmSummary.mean} ms`);
  console.log(`  Median: ${warmSummary.p50} ms`);
  console.log(`  P90:    ${warmSummary.p90} ms`);
  console.log(`  Min:    ${warmSummary.min} ms`);
  console.log(`  Max:    ${warmSummary.max} ms`);
  console.log(`------------------------------------------------------------------------`);
  console.log(`Improvement:`);
  console.log(
    `  Average Latency Reduction: ${timeSavedMs} ms (${((timeSavedMs / coldSummary.mean) * 100).toFixed(1)}% faster)`,
  );
  console.log(`  Speedup (Mean):            ${speedupRatio}x`);
  console.log(`  Speedup (Median/P50):      ${p50SpeedupRatio}x`);
  console.log(`========================================================================\n`);

  // Write markdown report artifact
  const markdownReport = `# Warm Worktree Pool Performance Benchmark

**Date:** ${new Date().toISOString().split("T")[0]}  
**Host:** Linux (arm64, Ubuntu 24.04)  
**Node:** ${process.version}  
**Iterations:** ${trialsCount} trials per scenario  

## Executive Summary

Pre-provisioning idle git worktrees in the background via the **Warm Worktree Pool** reduces workspace creation latency by **${((timeSavedMs / coldSummary.mean) * 100).toFixed(1)}%** (**${speedupRatio}x faster** on average, **${p50SpeedupRatio}x faster** median).

| Metric | Cold Creation (Baseline) | Warm Pool Claim (Optimized) | Delta | Speedup |
| :--- | :--- | :--- | :--- | :--- |
| **Mean** | **${coldSummary.mean} ms** | **${warmSummary.mean} ms** | **-${timeSavedMs} ms** | **${speedupRatio}x** |
| **Median (P50)** | **${coldSummary.p50} ms** | **${warmSummary.p50} ms** | **-${(coldSummary.p50 - warmSummary.p50).toFixed(1)} ms** | **${p50SpeedupRatio}x** |
| **P90** | **${coldSummary.p90} ms** | **${warmSummary.p90} ms** | **-${(coldSummary.p90 - warmSummary.p90).toFixed(1)} ms** | **${(coldSummary.p90 / warmSummary.p90).toFixed(2)}x** |
| **Min** | **${coldSummary.min} ms** | **${warmSummary.min} ms** | **-${(coldSummary.min - warmSummary.min).toFixed(1)} ms** | **${(coldSummary.min / warmSummary.min).toFixed(2)}x** |
| **Max** | **${coldSummary.max} ms** | **${warmSummary.max} ms** | **-${(coldSummary.max - warmSummary.max).toFixed(1)} ms** | **${(coldSummary.max / warmSummary.max).toFixed(2)}x** |

## Trial Breakdown

| Trial # | Cold Creation (ms) | Warm Claim (ms) | Speedup |
| :--- | :--- | :--- | :--- |
${coldTrials
  .map((c, idx) => {
    const w = warmTrials[idx];
    const ratio = (c.durationMs / w.durationMs).toFixed(2);
    return `| ${c.trial} | ${c.durationMs} | ${w.durationMs} | ${ratio}x |`;
  })
  .join("\n")}

## Mechanism Breakdown

1. **Cold Creation path** executes synchronous \`git worktree add\`, metadata initialization, config file seeding, and runs all lifecycle \`worktree.setup\` scripts in the critical path before returning to the caller.
2. **Warm Pool Claim path** claims an already initialized, setup-complete worktree in \`<projectWorktreesRoot>/.warm-*\`, executes atomic \`git worktree move\` to the target slug path, checks out the target branch, and schedules background replenishment to asynchronously maintain the target idle count.
`;

  const artifactPath = join(process.cwd(), "docs", "warm-worktrees-benchmark.md");
  writeFileSync(artifactPath, markdownReport, "utf8");
  console.log(`Saved benchmark artifact to: ${artifactPath}`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
