import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { OmpRuntime, OmpRuntimeSession } from "./runtime.js";

/** How often the pool health-sweeps its idle entries. */
const WARM_POOL_SWEEP_INTERVAL_MS = 60_000;
/** An idle process must answer get_state this fast or it is treated as dead. */
const WARM_POOL_SWEEP_GETSTATE_TIMEOUT_MS = 3_000;

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

/**
 * Warm pool of idle OMP processes.
 *
 * A cold omp launch costs ~1.9s of boot (native modules, TTSR, mental models,
 * session construction) before the first prompt can start. New agent creates
 * pay that on every occurrence. This pool keeps one booted, idle process per
 * (cwd, launch-mode, system-prompt) key so a create can hand it off and only
 * pay the ~100ms of RPC reconfiguration instead.
 *
 * Handoff contract (verified against omp 17.2.9): a process launched with
 * `--session <throwaway>` can be re-targeted in-process via `new_session`
 * (mints a fresh session file in the same directory), `set_model`, and
 * `set_thinking_level`. Model/thinking are the only per-create dimensions that
 * differ between creates of the same key, so they are applied at claim time.
 * System prompt and approval mode are launch-only and therefore part of the
 * key.
 *
 * The pool is lazy: fills happen after a claim (miss or hit), so the first
 * create after daemon start is cold and every subsequent create of the same
 * key is warm. Failures never surface to callers — claim returns null and the
 * caller cold-starts.
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
  throwawayPath: string | null;
}

export class OmpWarmPool {
  private readonly runtime: OmpRuntime;
  private readonly logger: Logger;
  private readonly entries: WarmEntry[] = [];
  private readonly filling = new Map<string, Promise<void>>();
  /** Most recent claim input per key, so a health sweep can refill dead entries. */
  private readonly lastInputByKey = new Map<string, OmpWarmPoolInput>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: OmpWarmPoolOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger;
  }

  /**
   * Start the periodic health sweep: entries whose process stopped answering
   * get_state are disposed and their key is refilled, so an idle pooled
   * process that dies does not silently leave the next create cold.
   */
  startSweep(): void {
    if (this.sweepTimer) {
      return;
    }
    const timer = setInterval(() => void this.sweep(), WARM_POOL_SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.sweepTimer = timer;
  }

  private async sweep(): Promise<void> {
    if (this.closed) {
      return;
    }
    const liveKeys = new Set<string>();
    const dead: WarmEntry[] = [];
    for (const entry of this.entries) {
      try {
        await withTimeout(entry.session.getState(), WARM_POOL_SWEEP_GETSTATE_TIMEOUT_MS);
        liveKeys.add(entry.key);
      } catch {
        dead.push(entry);
      }
    }
    if (dead.length > 0) {
      this.entries.splice(
        0,
        this.entries.length,
        ...this.entries.filter((entry) => !dead.includes(entry)),
      );
      for (const entry of dead) {
        void this.dispose(entry);
      }
      this.logger.info({ dead: dead.length }, "OMP warm pool sweep disposed unresponsive entries");
    }
    // Refill keys whose last live entry died. In-flight fills are deduped by
    // key inside fill(), so concurrent sweeps/claims cannot double-spawn.
    for (const [key, input] of this.lastInputByKey) {
      if (!liveKeys.has(key) && !this.filling.has(key)) {
        this.fill(input);
      }
    }
  }

  /**
   * Hand off a booted, idle process for a create matching `input`, or null
   * when the pool is cold, closed, or every candidate failed a liveness ping.
   * A replacement fill is always triggered behind the claim so the next
   * create of the same key stays warm.
   */
  async claim(input: OmpWarmPoolInput): Promise<OmpRuntimeSession | null> {
    if (this.closed) {
      return null;
    }
    const key = keyFor(input);
    const systemPrompt = input.systemPrompt.trim();
    this.lastInputByKey.set(key, input);

    // Drop entries that can never satisfy this claim: different key (mode or
    // cwd drift) or same key with a different system prompt (the daemon append
    // prompt changed). They are dead weight — a process cannot be re-targeted
    // to another prompt without relaunch.
    const stale: WarmEntry[] = [];
    const matching: WarmEntry[] = [];
    for (const entry of this.entries) {
      if (entry.key === key && entry.systemPrompt === systemPrompt) {
        matching.push(entry);
      } else {
        stale.push(entry);
      }
    }
    this.entries.length = 0;
    for (const entry of stale) {
      void this.dispose(entry);
    }

    while (matching.length > 0) {
      const entry = matching.shift()!;
      try {
        await entry.session.getState();
      } catch {
        void this.dispose(entry);
        continue;
      }
      void this.unlink(entry.throwawayPath);
      void this.fill(input);
      return entry.session;
    }

    // Cold: prime the pool so the *next* create of this key is warm.
    void this.fill(input);
    return null;
  }

  /** Close every pooled process. Idempotent; safe to call mid-fill. */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const entries = this.entries.splice(0);
    await Promise.all(entries.map((entry) => this.dispose(entry)));
    // Wait for in-flight fills so their freshly spawned processes are closed
    // too (they check `closed` before being admitted to the pool).
    const pending = [...this.filling.values()];
    await Promise.allSettled(pending);
  }

  private fill(input: OmpWarmPoolInput): void {
    if (this.closed) {
      return;
    }
    const key = keyFor(input);
    if (this.filling.has(key)) {
      return;
    }
    const filling = this.doFill(input, key);
    this.filling.set(key, filling);
  }

  private async doFill(input: OmpWarmPoolInput, key: string): Promise<void> {
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
    } finally {
      this.filling.delete(key);
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
  // cwd + launch-only flags + system prompt + any significant env fully
  // determine a launch; model and thinking are applied per-claim over RPC.
  // The identity pair (PASEO_AGENT_ID/PASEO_AGENT_CWD) is deliberately
  // excluded: it differs per create and is plumbing, not behavior.
  const env = input.env ? { ...input.env } : undefined;
  if (env) {
    delete env.PASEO_AGENT_ID;
    delete env.PASEO_AGENT_CWD;
  }
  return JSON.stringify({
    cwd: path.resolve(input.cwd),
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
