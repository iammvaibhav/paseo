# omp observability extension

How Paseo learns whether an omp agent has a model request in flight, so the dormant-turn detector can stop guessing at a 300-second ceiling. Read this before touching the dormant-turn detector, the stall config, or the omp launch config.

## The gap

Paseo cannot observe a model request in flight. omp logs no request-start anywhere: the session JSONL's only lifecycle markers are `tool_execution_start` and `session_exit`, the assistant row is written once at completion carrying duration/ttft, and the per-process log (`~/.omp/logs/omp.<date>.<pid>.log` — 1,244 lines across 27 distinct messages with debug on) has zero request-start lines. Every model-related line is an end event.

That blind spot sets the dormancy threshold. The detector must treat "no output, no tool in flight" as potentially healthy, because a legitimate model call can sit silent for up to 178.6s (max of 8,242 `claude-opus-5` tool-use calls, mean 11.4s; one 727k-token call took 54s with 48s TTFT). So `dormantTurnSeconds` defaults to 300. With the extension the ceiling no longer applies: a silent agent whose feed tail is inside a model call is covered, and the uncovered clock can run at ~30s — a 10x detection-speed difference no cron tuning can buy.

## The hook set

Subscribe to these documented hooks (`omp://hooks.md`, types in `packages/coding-agent/src/extensibility/hooks/types.ts`):

| Hook                                  | When                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `agent_start` / `agent_end`           | Session opens / closes                                                   |
| `turn_start` / `turn_end`             | A model call starts / ends                                               |
| `tool_call`                           | Pre-execution — the model call that produced the tool request has ENDED  |
| `tool_result`                         | Post-execution — the tool is done; the next model call is about to start |
| `auto_retry_start` / `auto_retry_end` | A model call errored and omp is backing off / retrying                   |

State machine, per session:

```
agent_start → empty
empty --turn_start--> model     (a turn opens with a model call)
model --tool_call--> tool       (the call that produced the request is done)
tool --tool_result--> model     (tool done; the next call is in flight)
model --turn_end--> empty
model --auto_retry_start--> retry   (backoff/retry — still covered)
retry --auto_retry_end--> model
any --agent_end--> closed
```

A gap between a `tool_result` and the next `tool_call`/`turn_end` is a model request in flight. That inference is the whole point: the state that used to be invisible — and forced the 300s ceiling — is now a named segment. Covered states (never dormant): `tool`, `model`, `retry`. Uncovered states (the dormancy clock runs): `empty` and `closed`.

## Output contract

One JSONL per omp session at `<dir>/<sessionId>.jsonl`, where `<dir>` is `PASEO_OBSERVABILITY_DIR` or `~/.paseo/omp-observability`. The session id is the omp session id — `agent.persistence.sessionId` on the daemon side, the same id the daemon already uses to address the session. The extension reads it from the hook context's session manager.

Rows (one per line, append-only, `v` for schema detection):

```json
{"v":1,"ts":1786348800000,"kind":"turn_start","session":"abc123","turnId":"t-1"}
{"v":1,"ts":1786348801200,"kind":"tool_call","session":"abc123","turnId":"t-1","toolCallId":"tc-9","toolName":"bash"}
{"v":1,"ts":1786348803200,"kind":"tool_result","session":"abc123","turnId":"t-1","toolCallId":"tc-9","toolName":"bash","isError":false}
{"v":1,"ts":1786348803400,"kind":"turn_end","session":"abc123","turnId":"t-1"}
```

Common fields: `ts` (epoch ms UTC — not the omp log's local time; see docs/observability.md), `kind`, `session`. Turn/tool events carry `turnId`/`toolCallId`/`toolName`; `tool_result` carries `isError`. Bounds: rotate at 5 MiB by renaming to `<name>.1`, overwriting the previous backup (the mission-control-lifecycle.jsonl convention, docs/mission-control.md Logging); Paseo deletes the file when the agent is archived.

A file beats an RPC because the consumer must work while omp is wedged and across daemon restarts. A file is readable in both cases; a push RPC needs reconnect, backfill, and a new protocol message (the protocol is additive-only — a file is outside the protocol entirely). The daemon already reads omp artifacts off disk (session JSONL via `provider-disk-history.ts`, stats.db `file_offsets` cursor), so tail-from-offset is the established pattern.

## How Paseo consumes it

The dormant-turn detector in `MissionControlService` (packages/server/src/server/mission-control/service.ts, stall sweep feeding `fireDormantRecovery`) gains a per-agent feed reader. The predicate becomes:

- tool in flight (existing `inFlightToolsByAgent` set) → covered, never dormant
- feed tail state `model` or `retry`, segment younger than the trust bound → covered
- otherwise, no activity for `dormantTurnSeconds` → dormant

The activity clock times from the newer of `lastStreamAt` and the feed's newest row — a busy-but-silent agent (long calls, no timeline rows) must not accumulate dormancy time.

Thresholds:

- `dormantTurnSeconds` default 300 → **30**. Uncovered time in a healthy run is inter-turn bookkeeping — seconds, because a turn cannot advance without a model call. The numbers that used to set the floor (178.6s max call, 48s TTFT) are now covered time and never count. 30s is an order-of-magnitude margin over the observed bookkeeping gap and trips 10x faster than today. The knob stays user-editable; operators who see false positives raise it.
- New constant `ompModelSegmentMaxSeconds` = **240** (178.6s max observed call + ~60s margin). A `model`/`retry` segment open past it is a wedged turn, not a call — no call that long exists in 8,242 samples. Without this bound a parked loop whose tail reads "model in flight" would shield forever, which is worse than today's 300s stop.

Gate: the tightened threshold applies only when the feed is present for the run — the daemon saw an `agent_start` row (or later) with ts at/after run start. Feed absent → the legacy predicate with 300s, byte-for-byte today. A feed that goes silent mid-run IS the dormancy signal, not a fallback trigger: a wedged loop stops emitting events, so the tail freezes.

Also update the `dormantTurnSeconds` help text and the config.ts floor comment — both currently say "Paseo cannot observe a model request in flight" and "values under ~4 min risk false positives"; that premise is what this extension removes.

## Non-goals

No recovery from inside omp. `session_stop` only fires when `isStreaming === false`, and a parked turn holds it true; `steer`/`sendMessage` only push onto the queue the frozen loop is not draining. Recovery stays external — the daemon's detector, per docs/observability.md "Why recovery has to be external". The extension observes and never recovers.

No behavior changes to omp. The extension returns nothing from any handler — no blocks, no input overrides, no context mutation.

No dependency on omp internals beyond the documented hook surface. If a hook name changes, the extension no-ops that event and the consumer degrades to 300s (below).

## Risks

- **In-process crash blast radius**: extensions run in-process without isolation; an unhandled rejection can crash the session. The handlers are fully try/catch-wrapped, and — critically — `tool_call`/`tool_result` handler errors propagate and BLOCK the tool (`emitToolCall` is stricter than `emit` in hooks.md), so those two handlers must never throw and never return an override. Observation-only by construction: a bug corrupts the feed, never the agent's behavior.
- **Hook overhead per tool call**: two handler invocations plus one buffered append per tool call. The hook runner is already in the path; append-without-fsync amortizes the write. Negligible against the tool call itself.
- **Log growth**: ~200 bytes/row, 5 MiB rotation per session file, files deleted on archive. A 1,000-event session is ~200 KB.
- **Version drift**: hook names can change across omp versions. The extension subscribes only to documented events; an unknown event no-ops. The consumer treats the feed as advisory — a malformed or missing feed degrades to 300s, never breaks.
- **Absent extension**: no feed, no tightened threshold. Nothing in the daemon assumes the extension; uninstall restores today's behavior exactly.

## Implementation sketch

```
packages/omp-observability/
  extension.ts        # default-export factory: pi.on(...) for the 8 hooks, buffered JSONL append
  extension.test.ts   # state-machine transitions + record shape
```

The factory subscribes to the hook set above, derives `session` from the hook context's session manager, and appends rows through a small write queue (batch, no fsync, rotation cap). Install: the daemon passes `--extension <path>` at omp launch — the pi provider already threads `extensionPaths` into argv (packages/server/src/server/agent/providers/pi/runtime.ts), so this is one more entry in the launch config, added to the deploy script inventory (same convention as `verifier-agent.md`). Enablement is presence: install the extension → the feed appears → the daemon's gate flips; uninstall → 300s. `PASEO_OBSERVABILITY_DIR` lets the daemon point the extension at `$PASEO_HOME/omp-observability`.
