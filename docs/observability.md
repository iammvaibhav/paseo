# Observability

How to tell what an agent is actually doing, and how to diagnose one that has gone quiet. Read this when an agent looks stuck, when a message you sent seems to have vanished, or when you need to prove an agent is healthy rather than assume it.

## The one signature that matters

An agent is **parked** when all three hold:

1. a run is in flight,
2. **no tool call is in flight**, and
3. no timeline output for longer than the dormancy threshold.

The middle condition is the whole trick. An agent sitting inside a declared tool call is working, however long it takes — a thirty-minute `hub wait` is healthy. Silence with nothing in flight is not. Every metric and check below carries that qualifier; without it, any long build reads as a stall.

Process liveness tells you nothing here. During a real 26-minute park, the omp process was alive and a sibling subagent in the _same process_ produced 280 timeline rows. Anything that checks whether the runtime is up will pass while the agent is wedged.

## Checking right now

```bash
node scripts/stall-check.mjs            # this host
node scripts/stall-check.mjs --fleet    # all hosts over ssh
node scripts/stall-check.mjs --recover  # interrupt + resume anything parked
```

Exit code is 1 when anything is dormant, so it gates a cron or an alert. It reads agent records and omp transcripts straight off disk, so it works when the daemon is unhealthy and needs no RPC. A local run costs ~0.13s against a 7 MB transcript.

### Installed cron (every host)

Deploy installs a cron entry on each host — marked with a `# paseo-stall-check` comment — that runs the local check every minute and appends to `~/.paseo/stall-check.log`:

- **Schedule:** `* * * * *`, one `stall-check.mjs` run per host per minute. The log captures output; a dormant agent makes the run exit 1 (nothing else happens — recovery stays approval-gated behind the daemon's own detector, so the cron never interrupts an agent on a false positive).
- **Node path:** resolved at install time and baked into the crontab line absolutely, because cron runs with a minimal PATH. Check it with `crontab -l | grep paseo-stall-check`.
- **Log:** `~/.paseo/stall-check.log`. Rotation lives in the cron line itself — once the log passes 5 MiB (~2 weeks of minute-ly runs) it is trimmed to the last 5 MiB.
- **Disable:** set `PASEO_SKIP_STALL_CRON=1` on the next deploy (skips install/refresh on every host); to also stop an already-installed entry, delete the marker line and the command line beneath it from the crontab.

Recovery sends a prompt, which carries interrupt semantics: it cancels the parked run and starts a fresh one. That is the only action known to clear this state.

## Where the data lives

| Source                                                | What it gives you                                                                                                                              | Gotcha                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| omp session JSONL (`record.persistence.nativeHandle`) | Per-call `duration`, `ttft`, `usage`, `cost`, `stopReason`, `errorMessage`; `steering: true` on injected messages; `tool_execution_start` rows | The authoritative record. Subagent transcripts are **nested in a directory named after the parent session**, not siblings of it |
| `~/.omp/logs/omp.<date>.<pid>.log`                    | Provider errors with status and `retry-after`, session exits with reason, extension load, compaction decisions                                 | Timestamps are **local time** (`+05:30`), not UTC. One file per omp process; find yours by grepping for the session id          |
| `~/.omp/stats.db` (`messages`, `tool_calls`)          | The same per-call telemetry, normalized and queryable by model/provider/folder                                                                 | Ingests **lazily** via a `file_offsets` cursor. Observed 5 hours stale. Useless for live debugging, good for distributions      |
| `$PASEO_HOME/daemon.log`                              | Daemon-side agent lifecycle, RPC failures                                                                                                      | Single file, no retained history — a 30-minute-old incident can already be gone. Do not plan forensics around it                |
| `$PASEO_HOME/mission-control/events.jsonl`            | Self-reported status feed, stall proposals, verdicts                                                                                           | Only what agents and machinery chose to report                                                                                  |

A useful distribution query, since `stats.db` is the only place these are aggregated:

```sql
SELECT round(AVG(duration)) avg_ms, round(MAX(duration)) max_ms, round(AVG(ttft)) avg_ttft
FROM messages WHERE model = 'claude-opus-5' AND stop_reason = 'toolUse';
```

## What to measure

| Signal             | Definition                                               | Healthy | Alarm                                   |
| ------------------ | -------------------------------------------------------- | ------- | --------------------------------------- |
| Dormancy age       | time since last timeline row **while no tool in flight** | < 90s   | > threshold (default 300s)              |
| Steer ack latency  | steer accepted → agent's next timeline row               | 5–90s   | > 90s with no tool in flight            |
| Undelivered steers | steer acked by the provider, no subsequent activity      | 0       | ≥ 1                                     |
| Dormant recoveries | times the detector fired                                 | 0/day   | rising means the upstream bug is biting |

Measured baselines, so thresholds are not guesses: across 8,242 `claude-opus-5` tool-use calls, mean duration 11.4s and **max 178.6s**; one call on a 727k-token context took 54s with 48s to first token. Nudge-to-response across healthy agents was 62s and 88s. So a legitimate gap can reach ~3 minutes, and anything past 5 is unambiguous. Do not set the dormancy threshold below ~4 minutes.

## Why recovery has to be external

omp has a drain built for exactly this case — `#drainStrandedQueuedMessages` in `pi-coding-agent/src/session/agent-session.ts` — but it is only reachable on settlement. Three call sites, no timer, no periodic sweep: two inside `#endInFlight` behind `if (this.#promptInFlightCount !== 0) return;`, and one in `compact()`'s `finally`.

When a steer aborts an interruptible tool, the message strands while the run is still in flight (`isStreaming` true, `promptInFlightCount > 0`). No drain path is reachable, so the loop parks indefinitely and further steers queue unconsumed while delivery reports success. Extensions cannot help: `session_stop` only fires when `isStreaming` is false, and `steer`/`sendMessage` push onto the queue the frozen loop is not draining.

So the bug is both invisible and unrecoverable from inside the process. An outside observer that can cancel is the only thing that can clear it. That is why the dormancy detector lives in the daemon and why `--recover` sends a prompt rather than asking omp to fix itself.

## Provider and quota signals

Provider exhaustion shows up in the omp process log, not in Paseo:

```
warn agent turn ended with provider error
{"provider":"opencode-zen","model":"deepseek-v4-flash-free","errorStatus":429,
 "errorMessage":"429 Rate limit exceeded ... retry-after-ms=56092000 ... (type=FreeUsageLimitError)"}
```

A `retry-after-ms` in the tens of millions is daily quota exhaustion, not a transient limit. Fallback still works, so nothing breaks — but each call pays a failed round-trip first, because `isSelectorSuppressed` is consulted only when picking a _fallback_ candidate, never when assigning a _new_ session's initial model. Every fresh subagent therefore restarts on the dead tier. The fix is to point the model role at the working provider, not to enable usage-aware fallback.

**Do not enable `retry.usageAwareFallback` on an account with Anthropic extra-usage credits.** It preflights the provider's usage endpoint and treats a 100%-consumed `anthropic:5h` or `anthropic:7d` plan bucket as `depleted`, then switches models _before_ sending the request. The extra-usage row is excluded from that check, and omp cannot tell "plan limit reached, paid overage available" from "hard quota exhausted" — so the request never reaches Anthropic and the credits are never billed. It also would not suppress the free-tier 429 above, because providers without a registered usage endpoint report `unknown` and fail open.
