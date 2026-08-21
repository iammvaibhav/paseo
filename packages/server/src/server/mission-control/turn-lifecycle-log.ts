import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

/**
 * Retained turn-step lifecycle record (module "mission-control", component
 * "turn-lifecycle").
 *
 * WHY: the daemon log (~/.paseo/daemon.log) is a single append-only pino
 * file with no rotation — it had already rotated past a 30-minute-old
 * incident window (live incident 2026-08-08: agent 3a71c7bb wedged
 * 10:25:08–10:51:14 UTC and the daemon could not show the wedge state at
 * all). Turn-step transitions (run started, request issued, tool started,
 * tool result, turn ended — with ages) are mirrored here as JSON lines so a
 * 30-minute-old (or older) incident is always diagnosable.
 *
 * RETENTION POLICY (bounded): the file rotates at 10 MB by renaming the
 * current file to `<name>.1` (overwriting any previous backup), so retained
 * history is capped at ~20 MB. At ~400 bytes/line that is ~25k current +
 * 25k rotated lines — hours-to-days of turn-step history at fleet scale,
 * comfortably past the 30-minute diagnostic window the incident needed.
 *
 * Writes are synchronous and must NEVER throw into the caller's hot path:
 * a lifecycle-record failure is logged once and dropped.
 */
const LIFECYCLE_LOG_FILENAME = "mission-control-lifecycle.jsonl";
/** Rotate at 10 MB: rename current -> .1, start fresh (bounded ~20 MB total). */
const ROTATION_CAP_BYTES = 10 * 1024 * 1024;

export class TurnLifecycleLog {
  private readonly path: string;
  private readonly logger: Logger;
  private size: number | null = null;

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.path = join(options.paseoHome, LIFECYCLE_LOG_FILENAME);
    this.logger = options.logger.child({ module: "mission-control", component: "turn-lifecycle" });
  }

  private currentSize(): number {
    if (this.size === null) {
      try {
        this.size = statSync(this.path).size;
      } catch {
        this.size = 0;
      }
    }
    return this.size;
  }

  /**
   * Append one JSON line. Rotates when the file exceeds the cap (rename to
   * `.1`, start fresh). Failures are logged and swallowed — turn-step
   * recording must never break the mission-control sweep.
   */
  write(entry: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
    } catch {
      return;
    }
    try {
      if (this.currentSize() + line.length > ROTATION_CAP_BYTES) {
        renameSync(this.path, `${this.path}.1`);
        this.size = 0;
      }
      appendFileSync(this.path, line, "utf8");
      this.size = (this.size ?? 0) + line.length;
    } catch (error) {
      this.size = null;
      this.logger.warn({ err: error }, "Failed to write mission-control turn-lifecycle record");
    }
  }
}
