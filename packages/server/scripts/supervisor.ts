import { fork, spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import { signalProcessTree } from "../src/utils/tree-kill.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
// Kill only after this long without a worker heartbeat. Create/checkout on large
// repos (stackmod) routinely runs 12-27s; a 15s kill false-restarts mid-request.
const WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
const WORKER_HEALTH_PROBE_TIMEOUT_MS = 1_500;
const WORKER_TERMINATION_GRACE_MS = 10_000;

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
}

interface WorkerHeartbeatMessage {
  type: "paseo:worker-heartbeat";
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string }) => Promise<void> | void;
  /**
   * Optional liveness probe used when IPC heartbeats go quiet. Defaults to
   * GET /api/health on the worker listen target. Returning true keeps the
   * worker alive (IPC can lag under load while the daemon is still serving).
   */
  probeWorkerHealth?: (listen: string) => Promise<boolean>;
  /** Test seam: override the IPC heartbeat kill threshold (default 45s). */
  workerHeartbeatTimeoutMs?: number;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
}

export interface SupervisorController {
  requestShutdown(reason: string): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

function isWorkerHeartbeatMessage(msg: unknown): msg is WorkerHeartbeatMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type?: unknown }).type === "paseo:worker-heartbeat"
  );
}

function resolveWorkerHealthUrl(listen: string): string | null {
  const trimmed = listen.trim();
  if (!trimmed) {
    return null;
  }
  // TCP listen targets are "host:port". Prefer loopback so a bound 0.0.0.0 port
  // is still probeable from the supervisor process.
  if (trimmed.includes(":") && !trimmed.startsWith("/") && !trimmed.includes("://")) {
    const lastColon = trimmed.lastIndexOf(":");
    const port = Number(trimmed.slice(lastColon + 1));
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return `http://127.0.0.1:${port}/api/health`;
    }
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return `${trimmed.replace(/\/$/, "")}/api/health`;
  }
  return null;
}

async function defaultProbeWorkerHealth(listen: string): Promise<boolean> {
  const url = resolveWorkerHealthUrl(listen);
  if (!url) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_HEALTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

function createSupervisorLogStream(options: SupervisorLogFileOptions | undefined) {
  if (!options) {
    return null;
  }

  mkdirSync(path.dirname(options.path), { recursive: true });
  return createRotatingFileStream(path.basename(options.path), {
    path: path.dirname(options.path),
    size: toRotatingFileStreamSize(options.rotate.maxSize),
    maxFiles: options.rotate.maxFiles,
  });
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerHeartbeatTimeoutMs = options.workerHeartbeatTimeoutMs ?? WORKER_HEARTBEAT_TIMEOUT_MS;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const logStream = createSupervisorLogStream(options.logFile);

  const writeDurableChunk = (chunk: string | Buffer): void => {
    logStream?.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> =>
    new Promise((resolve) => {
      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const scheduleForceKill = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child !== currentChild) {
        return;
      }
      writeLifecycleLog("Worker did not exit after SIGTERM; forcing SIGKILL", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      void signalProcessTree(currentChild, "SIGKILL").catch((error) => {
        writeLifecycleLog("Failed to force-kill worker process tree", {
          error: error instanceof Error ? error.message : String(error),
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      });
    }, WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: workerEnv,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;
    let lastWorkerHeartbeatAt = Date.now();
    let workerListen: string | null = null;
    let healthProbeInFlight = false;
    const probeWorkerHealth = options.probeWorkerHealth ?? defaultProbeWorkerHealth;
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = { type: "paseo:supervisor-heartbeat" };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    const workerWatchdog = setInterval(() => {
      if (child !== currentChild || restarting || shuttingDown || healthProbeInFlight) {
        return;
      }
      const heartbeatAgeMs = Date.now() - lastWorkerHeartbeatAt;
      if (heartbeatAgeMs < workerHeartbeatTimeoutMs) {
        return;
      }

      // IPC heartbeats are best-effort. Under Git/agent load the worker event
      // loop or IPC backlog can delay process.send while the daemon is still
      // healthy. Probe /api/health before killing so workspace.create and
      // checkout_status are not aborted by a false worker_heartbeat_timeout.
      if (workerListen) {
        healthProbeInFlight = true;
        void probeWorkerHealth(workerListen)
          .then((healthy) => {
            if (child !== currentChild || restarting || shuttingDown) {
              return undefined;
            }
            if (healthy) {
              writeLifecycleLog("Worker heartbeat delayed but health ok; keeping worker", {
                heartbeatAgeMs: Date.now() - lastWorkerHeartbeatAt,
                supervisorPid: process.pid,
                workerPid: currentChild.pid ?? null,
                listen: workerListen,
              });
              lastWorkerHeartbeatAt = Date.now();
              return undefined;
            }
            writeLifecycleLog("Worker heartbeat timed out; restarting worker", {
              heartbeatAgeMs: Date.now() - lastWorkerHeartbeatAt,
              supervisorPid: process.pid,
              workerPid: currentChild.pid ?? null,
              healthProbe: "failed",
              listen: workerListen,
            });
            requestRestart("worker_heartbeat_timeout");
            return undefined;
          })
          .finally(() => {
            healthProbeInFlight = false;
          });
        return;
      }

      writeLifecycleLog("Worker heartbeat timed out; restarting worker", {
        heartbeatAgeMs,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
        healthProbe: "unavailable",
      });
      requestRestart("worker_heartbeat_timeout");
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    workerWatchdog.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    // Worker owns daemon.log (pino file destination). Do not tee stdout/stderr
    // into the durable log: under log bursts the pipe backpressures, the worker
    // event loop stalls, heartbeats stop, and this watchdog kills the daemon
    // mid-request (workspace.create → client "Transport closed").
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on("message", (msg: unknown) => {
      if (isWorkerHeartbeatMessage(msg)) {
        lastWorkerHeartbeatAt = Date.now();
        return;
      }
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        workerListen = lifecycleMessage.listen;
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        Promise.resolve(options.onWorkerReady?.({ listen: lifecycleMessage.listen })).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
          },
        );
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        requestShutdown(reason);
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearInterval(workerWatchdog);
      clearForceKillTimer();
      const exitDescriptor = describeExit(code, signal);
      writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }

      const crashed =
        restartOnCrash &&
        ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

      if (restarting || crashed) {
        restarting = false;
        log(
          crashed
            ? `Worker crashed (${exitDescriptor}). Restarting worker...`
            : `Worker exited (${exitDescriptor}). Restarting worker...`,
        );
        spawnWorker();
        return;
      }

      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 1);
    });
  };

  const signalWorker = (signal: NodeJS.Signals, reason: string): void => {
    if (!child) {
      return;
    }
    writeLifecycleLog("Supervisor sending signal to worker", {
      reason,
      signal,
      supervisorPid: process.pid,
      workerPid: child.pid ?? null,
    });
    child.kill(signal);
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    signalWorker("SIGTERM", reason);
    scheduleForceKill(reason);
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      exitSupervisor(0);
      return;
    }
    signalWorker("SIGTERM", reason);
    scheduleForceKill(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
