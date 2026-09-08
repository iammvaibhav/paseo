# Warm Worktree Pool Performance Benchmark

**Date:** 2026-09-08  
**Host:** Linux (arm64, Ubuntu 24.04)  
**Node:** v22.23.1  
**Iterations:** 10 trials per scenario

## Executive Summary

Pre-provisioning idle git worktrees in the background via the **Warm Worktree Pool** reduces workspace creation latency by **70.3%** (**3.37x faster** on average, **3.4x faster** median).

| Metric           | Cold Creation (Baseline) | Warm Pool Claim (Optimized) | Delta         | Speedup   |
| :--------------- | :----------------------- | :-------------------------- | :------------ | :-------- |
| **Mean**         | **459.8 ms**             | **136.42 ms**               | **-323.4 ms** | **3.37x** |
| **Median (P50)** | **456.42 ms**            | **134.32 ms**               | **-322.1 ms** | **3.4x**  |
| **P90**          | **502.76 ms**            | **171.99 ms**               | **-330.8 ms** | **2.92x** |
| **Min**          | **437.52 ms**            | **121.5 ms**                | **-316.0 ms** | **3.60x** |
| **Max**          | **502.76 ms**            | **171.99 ms**               | **-330.8 ms** | **2.92x** |

## Limitation: This Result Depends on a Non-Trivial `worktree.setup`

The benchmark repo's `paseo.json` runs a `worktree.setup` script that spends ~350ms
doing setup work (simulating a real `npm install`-style dependency step), matching
what most real projects run on every fresh worktree. The warm pool wins here because
that cost is paid once during background provisioning, off the request's critical
path, instead of once per claim.

That win is conditional on setup cost dominating. Measured separately with an empty
`worktree.setup` (no lifecycle commands at all), cold `git worktree add -b <branch>

<base>` runs in ~70ms while warm claim's `git worktree move` + `git checkout` runs in
~120-170ms — the warm path is *slower* in that case, because it pays two extra git
process invocations (`move`, `checkout`) that the cold path's single `worktree add`
avoids. Projects with a fast or absent `worktree.setup` will not see this speedup and
may see a small regression; the pool is a net win specifically for projects whose
setup cost is large relative to `git worktree add`'s own overhead.

## Trial Breakdown

| Trial # | Cold Creation (ms) | Warm Claim (ms) | Speedup |
| :------ | :----------------- | :-------------- | :------ |
| 1       | 474.48             | 121.5           | 3.91x   |
| 2       | 453.96             | 126.37          | 3.59x   |
| 3       | 451.11             | 171.99          | 2.62x   |
| 4       | 456.6              | 147.06          | 3.10x   |
| 5       | 470.48             | 136.87          | 3.44x   |
| 6       | 443.45             | 131.26          | 3.38x   |
| 7       | 451.22             | 134.32          | 3.36x   |
| 8       | 437.52             | 127.76          | 3.42x   |
| 9       | 456.42             | 134.86          | 3.38x   |
| 10      | 502.76             | 132.24          | 3.80x   |

## Mechanism Breakdown

1. **Cold Creation path** executes synchronous `git worktree add`, metadata initialization, config file seeding, and runs all lifecycle `worktree.setup` scripts in the critical path before returning to the caller.
2. **Warm Pool Claim path** claims an already initialized, setup-complete worktree in `<projectWorktreesRoot>/.warm-*`, executes atomic `git worktree move` to the target slug path, checks out the target branch, and schedules background replenishment to asynchronously maintain the target idle count.
