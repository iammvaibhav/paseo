// Commander Voice — structured JSONL session logger.
// Writes event records for voice sessions, Gemini WS connection, and tool executions.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Resolve the directory path for session JSONL log files.
 * Uses VOICE_SESSION_LOG_DIR if set, otherwise $PASEO_HOME/commander-voice/sessions
 * or ~/.paseo/commander-voice/sessions.
 */
export function resolveSessionLogDir(overrideDir) {
  if (overrideDir) return overrideDir;
  if (process.env.VOICE_SESSION_LOG_DIR) return process.env.VOICE_SESSION_LOG_DIR;
  const base = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  return path.join(base, "commander-voice", "sessions");
}

/**
 * Truncate long result objects or strings for efficient log storage.
 */
export function truncateValue(val, maxLen = 500) {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") {
    return val.length > maxLen ? val.slice(0, maxLen) + "… [truncated]" : val;
  }
  try {
    const str = JSON.stringify(val);
    if (str.length > maxLen) {
      return str.slice(0, maxLen) + "… [truncated]";
    }
    return val;
  } catch {
    return String(val).slice(0, maxLen);
  }
}

export class SessionLogger {
  constructor({ sessionId, logDir } = {}) {
    this.sessionId = sessionId || `vs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.logDir = resolveSessionLogDir(logDir);
    this.filePath = path.join(this.logDir, `${this.sessionId}.jsonl`);
    this._closed = false;
    this._init();
  }

  _init() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });

      const latestPath = path.join(this.logDir, "latest.jsonl");
      try {
        fs.rmSync(latestPath, { force: true });
        fs.symlinkSync(`${this.sessionId}.jsonl`, latestPath);
      } catch {
        // Symlink creation is optional. Ignore when unsupported.
      }
    } catch (err) {
      console.error(`SessionLogger init error (${this.sessionId}):`, err.message);
    }
  }

  /**
   * Write one structured event line to the JSONL log file.
   */
  log(event, fields = {}) {
    if (this._closed) return;
    const entry = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      event,
      ...fields,
    };
    const line = JSON.stringify(entry) + "\n";
    try {
      fs.appendFileSync(this.filePath, line, "utf8");
    } catch (err) {
      console.error(`SessionLogger write error (${this.sessionId}):`, err.message);
    }
  }

  close() {
    this._closed = true;
  }
}

export function createSessionLogger(options) {
  return new SessionLogger(options);
}
