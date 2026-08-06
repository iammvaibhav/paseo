import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { OmpRuntime, OmpRuntimeSession } from "./runtime.js";

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
  private closed = false;

  constructor(options: OmpWarmPoolOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger;
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
  // cwd + launch-only flags + system prompt fully determine a launch; model
  // and thinking are applied per-claim over RPC.
  return JSON.stringify({
    cwd: path.resolve(input.cwd),
    modeId: input.modeId,
    extraArgs: input.extraArgs,
    systemPrompt: input.systemPrompt.trim(),
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
