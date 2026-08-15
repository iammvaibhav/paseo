# OMP process efficiency

How Paseo owns `omp` processes, what the warm pool actually buys, and whether
idle-release + reclaim is cheaper than keeping one process per idle agent.

Read this before adding an idle timeout, returning used processes to the pool,
or assuming a resume can take a warm-pool handoff.

## Verdict

Implemented. Idle OMP agents close after a configurable 30 minutes.
The next send claims a pooled process and attaches the session with
`switch_session`.

- The warm pool is **host-global**: one bucket of **2** idle processes
  per OMP-derived provider. cwd is not in the launch shape; `/move`
  retargets. A claim for a different launch shape retires the old
  processes and refills.
- Create from a warm process: **~87 ms**. Cold create boot: **~1.9 s**.
- Resume via `switch_session` onto a warm process: **~49–107 ms** by
  JSONL size. Cold `--session` spawn: **~1.85 s**.
- Ask-mode is a native OMP fork through `resumeSession`, so it uses
  the same pool attach.
- Config rebuild now shuts down the previous `OmpAgentClient` so
  orphaned pools do not refill forever.

Do not return a used process to the pool. Close it. Let `fill()` mint
a virgin replacement.

## How ownership works

```
create (eligible)
  warmPool.claim(key) --hit--> /move? + new_session + set_model + set_thinking
                            --> set_host_tools --> bound to this agent forever
                   --miss--> cold startSession()  (and fill() for the next create)

create (ineligible: internal, significant env, custom system prompt, tool allowlist)
  always cold startSession()

resume / reload / dead-runtime recover
  always startSession({ session: nativeHandle })   // --session <jsonl>
  never claim()

turn end
  lifecycle -> idle; process stays

close / archive / reload
  session.close() kills the child; record + JSONL stay
```

Sources: `OmpAgentClient.startRuntimeSession` / `resumeSession`
(`packages/server/src/server/agent/providers/omp/agent.ts`),
`OmpWarmPool.claim` (`warm-pool.ts`),
`ensureAgentLoaded` (`agent-loading.ts`),
`docs/agent-lifecycle.md` Runtime residency.

Native OMP task children live **inside** the parent process. Paseo maps
`subagent_*` events; it does not spawn a second `omp` for them. Kill the
parent between turns and those in-flight children die. Completed child
JSONL on disk survives.

## Warm pool (creates only)

| Knob           | Value                                                                      | Where                            |
| -------------- | -------------------------------------------------------------------------- | -------------------------------- |
| Key            | `modeId` + `extraArgs` + trimmed system prompt + significant env           | `keyFor`                         |
| Not in the key | cwd, model, thinking, `PASEO_AGENT_ID` / `PASEO_AGENT_CWD`                 | comments on `keyFor`             |
| Idle per key   | 2                                                                          | `WARM_POOL_TARGET_IDLE`          |
| Keys kept      | 2 most recent                                                              | `WARM_POOL_MAX_KEYS`             |
| Maintain       | 15s: drop dead, evict LRU keys, refill                                     | `WARM_POOL_MAINTAIN_INTERVAL_MS` |
| Liveness ping  | `get_state` ≤ 2s                                                           | `WARM_POOL_LIVENESS_TIMEOUT_MS`  |
| `/move` budget | ~30ms measured, 3s cap                                                     | `WARM_POOL_MOVE_TIMEOUT_MS`      |
| Seed           | `$PASEO_HOME/omp-warm-pool.json` so the first create after restart is warm | `primeFromSeed`                  |
| Config knobs   | none                                                                       | hardcoded                        |

A pooled process boots with a throwaway `--session` file, no model, no
thinking. Claim prefers a process already in the target cwd (ping only),
else `/move <cwd>` (~30ms, reloads AGENTS.md / plugins), then the caller
runs `new_session` → `set_model` → `set_thinking_level` → `set_host_tools`.

Used processes never go back. `close()` kills them.

Ineligible creates (internal, extra env, per-agent system prompt, tool
allowlist) cannot share a pooled binary: those flags are launch-only.

## Switching cost (measured 2026-08-15, this host)

Isolated `omp --mode rpc-ui` children. Three trials each. No Paseo
daemon, no model call. Harness: `/tmp/paseo-omp-switch-timing.mjs`.

| Path                                           | Mean        | Min–max   | What was timed                                            |
| ---------------------------------------------- | ----------- | --------- | --------------------------------------------------------- |
| Cold create boot (`ready` + first `get_state`) | **1885 ms** | 1863–1915 | spawn + native boot                                       |
| Warm-pool **create** claim                     | **87 ms**   | 83–91     | ping + `new_session` 33 ms + `set_model` ~7 ms + thinking |
| Cold resume `--session`, 431 B                 | **1846 ms** | 1802–1896 | same boot; file size barely matters                       |
| Cold resume `--session`, 1.9 MiB               | **1891 ms** | 1837–1972 | this agent's JSONL                                        |
| Cold resume `--session`, 3.0 MiB               | **1853 ms** | 1840–1876 | largest session in this cwd                               |
| `switch_session` onto warm process, 431 B      | **49 ms**   | 46–52     | 9/9 attached                                              |
| `switch_session` onto warm process, 1.9 MiB    | **95 ms**   | 93–97     | 9/9 attached                                              |
| `switch_session` onto warm process, 3.0 MiB    | **107 ms**  | 106–108   | 9/9 attached                                              |
| `/move` (code comment, not re-timed)           | ~30 ms      | —         | `warm-pool.ts`                                            |

Cold resume and cold create cost the same ~1.8–1.9 s. JSONL size did
not move the boot number. It **does** move `switch_session` (49 → 107
ms from 431 B to 3 MiB). That is still ~17× cheaper than a cold
`--session` spawn.

`get_messages` after switching a 1.9 MiB session overflows OMP's 1 MiB
v1 frame. Paseo already negotiates protocol v2 and does not need
`get_messages` on resume — it hydrates the timeline from disk. Do not
add a `get_messages` round-trip on this path.

Historical first-turn totals (~2–4 s warm create, ~7–9 s cold) include
model TTFT. They are not process-switch costs.

## Code budget (what that phrase means)

Not a money budget. The **intended process cap** written in
`warm-pool.ts`:

```
WARM_POOL_TARGET_IDLE = 2   // idle processes kept per launch key
WARM_POOL_MAX_KEYS    = 2   // distinct launch shapes kept warm
```

Max idle pooled processes per `OmpWarmPool` = 2 × 2 = **4**.
Comment prices each at ~300 MiB → **~1.2 GiB** for the pool.
No env or settings knob. Live agents sit **outside** this cap.

The pool is **per host daemon × per OMP-derived provider**, not per
cwd and not per agent:

- cwd is excluded from `keyFor`. Claim prefers a process already in
  the target cwd; otherwise `/move <cwd>` retargets it.
- One `OmpAgentClient` constructs one `OmpWarmPool` and `start()`s it.
- One daemon has one `ProviderSnapshotManager`. Happy path: one pool
  for builtin `omp`.
- A custom provider with `extends: "omp"` gets its **own** client and
  therefore its own 4-slot pool.
- This host's `config.json` has a single enabled `omp` provider, so
  the intended pool is 4 processes for the whole machine.

Observed 25 processes / 6.60 GiB because
`applyMutableProviderConfig` drops `providerClients` without
`shutdown()`. Each Settings save that rebuilds providers orphans a
pool whose 15 s timer keeps topping it up. Fix that before an idle
timeout will show a clean RSS drop.

## Idle-close + settings

Paseo already has `closed` without `archivedAt`. `closeAgent` kills
the process and keeps the record. The next prompt goes through
`ensureAgentLoaded` → `resumeSession`. No new lifecycle state.

A 30-minute knob would follow the host daemon-config path:

1. `MutableDaemonConfigSchema` / `PatchSchema` in
   `packages/protocol/src/messages.ts` (next to `autoArchiveAfterMerge`).
2. Default in `createInitialMutableDaemonConfig` (`bootstrap.ts`).
3. Persist via `DaemonConfigStore.patch` → `~/.paseo/config.json`.
4. Settings card on Host (`host-page.tsx` + `useDaemonConfig`). Copy
   the `dormantTurnSeconds` NumberField widget, not the Mission
   Control store — this is a per-host daemon knob.

Gate the closer: lifecycle not `running`, no in-flight tools, no live
OMP children. Do not close the Commander. Default 1800 s; 0 = off.

Resume after that close is only cheap if `resumeSession` claims a
pooled process and calls `switch_session` instead of
`startSession({ session })`. Wire that in the same change. Otherwise
every 30-minute-idle send pays ~1.9 s of boot.

Paseo still has to re-register host tools after either path
(`set_host_tools`). That RPC was not in the isolated harness; add it
to the claim budget (likely tens of ms, same order as `set_model`).

## What a SIGTERM between turns drops

Disk-reloadable: session JSONL, completed child transcripts, Paseo
agent record, primed timeline.

Lost with the process:

- In-flight OMP task children (memory-only; already true across
  daemon restart)
- Background bash / watchers / PTYs started by tools
- In-process credential cache (re-read on next boot)
- Host-tool router and unanswered extension UI
- Anything that had not flushed to JSONL yet

A dead runtime is already recoverable:
`reloadAgentSession` → `resumeSession`. Idle-close is the same path,
deliberate.

## Recommendation

1. **Stop leaking pools** on config rebuild. Otherwise the 4-slot cap
   is fiction.
2. **Idle-close after a configurable N minutes** (default 30) into
   existing `closed`. Settings on Host. Do not close running turns or
   live children.
3. **Same change: teach `resumeSession` to `claim()` +
   `switch_session`.** Without that, the 30-minute closer makes the
   next send ~1.9 s slower. With it, the next send is ~50–110 ms of
   RPC plus host-tool re-register — fine for a 30-minute gap.
4. Keep the pool virgin. Close used processes. `fill()` replaces them.
5. Do not grow `MAX_KEYS` / `TARGET_IDLE` until the leak is gone and
   you have a reason two launch shapes are not enough.

Do not close-on-idle while a turn or a child is live. Do not treat
create-claim latency as today's resume latency — they become the same
order of magnitude only after `switch_session` is wired.
