import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { OmpRuntime, OmpRuntimeSession } from "./runtime.js";

/**
 * How often the pool reconciles itself against its invariant (drop dead idle
 * processes, refill tracked keys). Short enough that a process dying between
 * creates is replaced before the next create arrives.
 */
const WARM_POOL_MAINTAIN_INTERVAL_MS = 15_000;
/**
 * An idle process must answer get_state this fast or it is treated as dead.
 * Bounds both the maintenance check and the claim's liveness ping: a hung
 * process must never cost a create the 30s default RPC budget.
 */
const WARM_POOL_LIVENESS_TIMEOUT_MS = 2_000;
/**
 * How many idle processes each key keeps. Two, so a create that consumes one
 * still leaves a warm process for the create right behind it (and for the
 * window before the replacement finishes booting).
 */
const WARM_POOL_TARGET_IDLE = 2;
/**
 * How many distinct launch keys (mode + launch flags + system prompt) stay
 * warm at once. Workspaces are NOT part of a key — a pooled process is moved
 * to the target workspace at claim time — so this only spans genuinely
 * different launches, and the pool costs at most MAX_KEYS * TARGET_IDLE
 * processes (~300MB each).
 */
const WARM_POOL_MAX_KEYS = 2;
/**
 * Budget for re-targeting a pooled process to the claiming workspace. The move
 * itself measures ~30ms; this only bounds a wedged process so it costs the
 * create a cold start instead of a stall.
 */
const WARM_POOL_MOVE_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
        return undefined;
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
        return undefined;
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Warm pool of idle OMP processes.
 *
 * A cold omp launch costs ~0.6-2s of boot (native modules, TTSR, mental
 * models, session construction) before the first prompt can start. New agent
 * creates pay that every time. This pool keeps booted, idle processes around
 * so a create hands one off and pays tens of milliseconds of RPC instead.
 *
 * Handoff contract (verified against omp 17.2.9/17.2.10): a process launched
 * with `--session <throwaway>` can be fully re-targeted in-process:
 *   - `/move <dir>` (sent as a prompt) relocates the session to another
 *     workspace — ~30ms — and omp reloads settings, plugins and project rules
 *     for the new cwd, so the agent sees the right AGENTS.md.
 *   - `new_session` mints a fresh session file in the (new) directory.
 *   - `set_model` / `set_thinking_level` apply the per-create model choice.
 * Only the launch flags (mode, approval mode, system prompt, significant env)
 * are fixed at spawn, so only those form the pool key. Workspace is not a key
 * dimension: any pooled process can serve any workspace.
 *
 * The pool maintains an invariant rather than filling opportunistically: each
 * of the WARM_POOL_MAX_KEYS most recently used keys keeps WARM_POOL_TARGET_IDLE
 * live idle processes, reconciled every WARM_POOL_MAINTAIN_INTERVAL_MS (drop
 * processes that stopped answering, top up the rest). Failures never surface
 * to callers: claim returns null and the caller cold-starts.
 */
export interface OmpWarmPoolInput {
  cwd: string;
  modeId: string;
  extraArgs: string[];
  /** Trimmed system prompt the claiming agent would launch with. */
  systemPrompt: string;
  /**
   * Launch env. Only the identity bookkeeping vars are expected here
   * (`PASEO_AGENT_ID`/`PASEO_AGENT_CWD`); callers must cold-start when the
   * env carries anything else. The identity pair is set on warm spawns so
   * agent-spawned CLIs keep working.
   */
  env?: Record<string, string>;
}

interface OmpWarmPoolOptions {
  runtime: OmpRuntime;
  logger: Logger;
}

interface WarmEntry {
  key: string;
  session: OmpRuntimeSession;
  systemPrompt: string;
  /** Workspace the process currently sits in; changed by `/move` on claim. */
  cwd: string;
  throwawayPath: string | null;
}

interface TrackedKey {
  input: OmpWarmPoolInput;
  usedAt: number;
}

export class OmpWarmPool {
  private readonly runtime: OmpRuntime;
  private readonly logger: Logger;
  private readonly entries: WarmEntry[] = [];
  private readonly filling = new Map<string, Promise<void>[]>();
  /**
   * Keys seen recently, newest-first by `usedAt`. The maintenance loop keeps
   * one live idle process for each of the most recent WARM_POOL_MAX_KEYS keys
   * — a create in one workspace must never cost another workspace its warm
   * process, which is what makes multi-worktree work stay fast.
   */
  private readonly trackedKeys = new Map<string, TrackedKey>();
  private maintainTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: OmpWarmPoolOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger;
  }

  /**
   * Start the maintenance loop. It reconciles the pool against its invariant:
   * dispose entries whose process stopped answering, then refill any tracked
   * key that has no live idle entry. Without it the pool only refills behind a
   * claim, so an idle process that dies leaves the next create cold.
   */
  startSweep(): void {
    if (this.maintainTimer) {
      return;
    }
    const timer = setInterval(() => void this.maintain(), WARM_POOL_MAINTAIN_INTERVAL_MS);
    timer.unref?.();
    this.maintainTimer = timer;
  }

  private async maintain(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.dropDeadEntries();
    this.evictKeysBeyondBudget();
    for (const key of this.keysWithinBudget()) {
      const tracked = this.trackedKeys.get(key);
      if (tracked) {
        this.fill(tracked.input);
      }
    }
  }

  /** Liveness-check every idle entry and drop the ones that stopped answering. */
  private async dropDeadEntries(): Promise<void> {
    const checks = this.entries.map(async (entry) => {
      try {
        await withTimeout(entry.session.getState(), WARM_POOL_LIVENESS_TIMEOUT_MS);
        return null;
      } catch {
        return entry;
      }
    });
    const dead = (await Promise.all(checks)).filter((entry): entry is WarmEntry => entry !== null);
    if (dead.length === 0) {
      return;
    }
    const survivors = this.entries.filter((entry) => !dead.includes(entry));
    this.entries.splice(0, this.entries.length, ...survivors);
    for (const entry of dead) {
      void this.dispose(entry);
    }
    this.logger.info({ dead: dead.length }, "OMP warm pool dropped unresponsive idle processes");
  }

  /** Keys we keep warm: the most recently used ones, capped for memory. */
  private keysWithinBudget(): string[] {
    return [...this.trackedKeys.entries()]
      .sort(([, left], [, right]) => right.usedAt - left.usedAt)
      .slice(0, WARM_POOL_MAX_KEYS)
      .map(([key]) => key);
  }

  /**
   * Retire keys that fell out of the budget: forget them and close any idle
   * process still held for them. Claims never evict another key's process —
   * only this bounded, least-recently-used retirement does.
   */
  private evictKeysBeyondBudget(): void {
    const keep = new Set(this.keysWithinBudget());
    for (const key of this.trackedKeys.keys()) {
      if (!keep.has(key)) {
        this.trackedKeys.delete(key);
      }
    }
    const retired = this.entries.filter((entry) => !keep.has(entry.key));
    if (retired.length === 0) {
      return;
    }
    const survivors = this.entries.filter((entry) => keep.has(entry.key));
    this.entries.splice(0, this.entries.length, ...survivors);
    for (const entry of retired) {
      void this.dispose(entry);
    }
  }

  /**
   * Hand off a booted, idle process for a create matching `input`, or null
   * when no live idle process is available. The process is moved to the
   * claiming workspace first when it sits elsewhere. A replacement fill is
   * always triggered behind the claim so the next create stays warm.
   */
  async claim(input: OmpWarmPoolInput): Promise<OmpRuntimeSession | null> {
    if (this.closed) {
      return null;
    }
    const key = keyFor(input);
    const cwd = path.resolve(input.cwd);
    this.trackedKeys.set(key, { input, usedAt: Date.now() });

    for (;;) {
      // Prefer a process already sitting in the target workspace: that claim
      // costs nothing at all. Otherwise take any process of this key and move
      // it. Entries of other keys must survive.
      let index = this.entries.findIndex((entry) => entry.key === key && entry.cwd === cwd);
      if (index === -1) {
        index = this.entries.findIndex((entry) => entry.key === key);
      }
      if (index === -1) {
        break;
      }
      const [entry] = this.entries.splice(index, 1);
      if (!entry) {
        break;
      }
      try {
        // Bounded: a hung process must cost the create milliseconds, not the
        // 30s default RPC budget.
        await withTimeout(entry.session.getState(), WARM_POOL_LIVENESS_TIMEOUT_MS);
      } catch {
        void this.dispose(entry);
        continue;
      }
      if (entry.cwd !== cwd && !(await this.retarget(entry, cwd))) {
        void this.dispose(entry);
        continue;
      }
      void this.unlink(entry.throwawayPath);
      void this.fill(input);
      return entry.session;
    }

    // Cold: prime the pool so the *next* create is warm.
    void this.fill(input);
    return null;
  }

  /**
   * Move an idle process to another workspace with omp's `/move` command.
   * omp relocates the session file, reloads settings/plugins and re-derives
   * project rules for the new cwd. Completion is observed as the session file
   * changing directory — `/move` is asynchronous behind the prompt ack.
   */
  private async retarget(entry: WarmEntry, cwd: string): Promise<boolean> {
    try {
      const before = await withTimeout(entry.session.getState(), WARM_POOL_LIVENESS_TIMEOUT_MS);
      await withTimeout(entry.session.prompt(`/move ${cwd}`), WARM_POOL_LIVENESS_TIMEOUT_MS);
      const deadline = Date.now() + WARM_POOL_MOVE_TIMEOUT_MS;
      for (;;) {
        const state = await withTimeout(entry.session.getState(), WARM_POOL_LIVENESS_TIMEOUT_MS);
        if (state.sessionFile && state.sessionFile !== before.sessionFile) {
          entry.cwd = cwd;
          // The throwaway session travelled with the move; track its new path
          // so the claim's cleanup deletes the right file.
          entry.throwawayPath = state.sessionFile;
          return true;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await sleep(20);
      }
    } catch (error) {
      this.logger.warn({ err: error, cwd }, "OMP warm pool move failed; create will cold start");
      return false;
    }
  }

  /** Close every pooled process. Idempotent; safe to call mid-fill. */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.maintainTimer) {
      clearInterval(this.maintainTimer);
      this.maintainTimer = null;
    }
    const entries = this.entries.splice(0);
    await Promise.all(entries.map((entry) => this.dispose(entry)));
    // Wait for in-flight fills so their freshly spawned processes are closed
    // too (they check `closed` before being admitted to the pool).
    const pending = [...this.filling.values()].flat();
    await Promise.allSettled(pending);
  }

  /**
   * Top this key up to WARM_POOL_TARGET_IDLE live-or-booting processes. Safe
   * to call from anywhere: it counts what already exists and never overfills.
   */
  private fill(input: OmpWarmPoolInput): void {
    if (this.closed) {
      return;
    }
    const key = keyFor(input);
    const inFlight = this.filling.get(key) ?? [];
    const live = this.entries.reduce((count, entry) => count + (entry.key === key ? 1 : 0), 0);
    for (let slot = live + inFlight.length; slot < WARM_POOL_TARGET_IDLE; slot++) {
      const pending: Promise<void> = this.doFill(input).finally(() => {
        const rest = (this.filling.get(key) ?? []).filter((other) => other !== pending);
        if (rest.length > 0) {
          this.filling.set(key, rest);
        } else {
          this.filling.delete(key);
        }
      });
      inFlight.push(pending);
    }
    if (inFlight.length > 0) {
      this.filling.set(key, inFlight);
    }
  }

  private async doFill(input: OmpWarmPoolInput): Promise<void> {
    try {
      const entry = await this.spawnWarm(input);
      if (entry && !this.closed) {
        this.entries.push(entry);
      } else if (entry) {
        void this.dispose(entry);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, cwd: input.cwd, modeId: input.modeId },
        "OMP warm pool fill failed; next create will cold start",
      );
    }
  }

  private async spawnWarm(input: OmpWarmPoolInput): Promise<WarmEntry | null> {
    const throwawayPath = this.throwawaySessionPath(input.cwd);
    const session = await this.runtime.startSession({
      cwd: input.cwd,
      protocolMode: "rpc-ui",
      modeId: input.modeId,
      extraArgs: input.extraArgs,
      session: throwawayPath,
      // Model/thinking are deliberately omitted: they are applied per-create
      // via RPC at claim time.
      systemPrompt: input.systemPrompt.trim() || undefined,
      // Identity plumbing only: the claimer's agent id differs from the fill's,
      // but these vars are only read by agent-spawned CLIs and cwd is pinned by
      // the pool key. Anything behavioral in env would have made the create
      // cold-start (eligibility), so only the identity pair can arrive here.
      env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
    });
    try {
      // Blocks until the process has booted and answered `ready`.
      await session.getState();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return {
      key: keyFor(input),
      session,
      systemPrompt: input.systemPrompt.trim(),
      cwd: path.resolve(input.cwd),
      throwawayPath,
    };
  }

  private async dispose(entry: WarmEntry): Promise<void> {
    void this.unlink(entry.throwawayPath);
    await entry.session.close().catch(() => undefined);
  }

  private async unlink(filePath: string | null): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      await rm(filePath, { force: true });
    } catch {
      // Best effort: a leftover throwaway file is harmless.
    }
  }

  /**
   * A canonical throwaway session path, placed in omp's sessions directory so
   * the session minted by `new_session` at claim time lands in the same
   * directory omp would pick for a normal create of `cwd`.
   */
  private throwawaySessionPath(cwd: string): string {
    const dir = path.join(
      homedir(),
      ".omp",
      "agent",
      "sessions",
      encodeOmpSessionDirName(path.resolve(cwd)),
    );
    // omp mints its session files itself; make sure the directory exists so a
    // fresh pool path (e.g. a brand-new workspace) never races its mkdir.
    void mkdir(dir, { recursive: true }).catch(() => undefined);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(dir, `${stamp}_${randomUUID()}.jsonl`);
  }
}

function keyFor(input: OmpWarmPoolInput): string {
  // Launch-only flags + system prompt + any significant env fully determine a
  // launch. Workspace is excluded: a pooled process is moved to the claiming
  // workspace over RPC. Model and thinking are applied per-claim. The identity
  // pair (PASEO_AGENT_ID/PASEO_AGENT_CWD) is plumbing, not behavior.
  const env = input.env ? { ...input.env } : undefined;
  if (env) {
    delete env.PASEO_AGENT_ID;
    delete env.PASEO_AGENT_CWD;
  }
  return JSON.stringify({
    modeId: input.modeId,
    extraArgs: input.extraArgs,
    systemPrompt: input.systemPrompt.trim(),
    env: env && Object.keys(env).length > 0 ? env : undefined,
  });
}

/**
 * Mirrors omp's `encodeRelativeSessionDirName` + cwd classification
 * (pi-coding-agent/src/session/session-paths.ts): home-relative paths get the
 * "-" prefix, tmp-relative paths "-tmp", anything else the legacy absolute
 * form. Paseo's session paths must match omp's so `--continue`/history
 * discovery and the pool's minted sessions agree on a directory.
 */
export function encodeOmpSessionDirName(cwd: string): string {
  const home = homedir();
  const homeRelative = path.relative(home, cwd);
  if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
    return homeRelative === "" ? "-" : `-${homeRelative.replace(/[/\\:]/g, "-")}`;
  }
  const tmp = tmpdir();
  const tmpRelative = path.relative(tmp, cwd);
  if (tmpRelative === "" || (!tmpRelative.startsWith("..") && !path.isAbsolute(tmpRelative))) {
    return tmpRelative === "" ? "-tmp" : `-tmp-${tmpRelative.replace(/[/\\:]/g, "-")}`;
  }
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
