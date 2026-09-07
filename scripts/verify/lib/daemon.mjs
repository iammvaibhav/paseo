import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { getNodeCompileCacheDir, getWorktreeRoot } from "./paths.mjs";

/**
 * Resolve the supervisor entrypoint script.
 */
export function resolveSupervisorScript(worktreeRoot = getWorktreeRoot()) {
  const distCandidate = path.join(
    worktreeRoot,
    "packages",
    "server",
    "dist",
    "scripts",
    "supervisor-entrypoint.js",
  );
  if (existsSync(distCandidate)) {
    return distCandidate;
  }

  const tsCandidate = path.join(
    worktreeRoot,
    "packages",
    "server",
    "scripts",
    "supervisor-entrypoint.ts",
  );
  if (existsSync(tsCandidate)) {
    return tsCandidate;
  }

  throw new Error(`Supervisor entrypoint not found at ${distCandidate} or ${tsCandidate}`);
}

/**
 * Build the exact environment dictionary for the daemon process.
 */
export function buildDaemonEnv({
  paseoHome,
  port,
  webUiDistDir,
  worktreeRoot = getWorktreeRoot(),
}) {
  const env = { ...process.env };

  // Crucial: remove leaky environment variables
  delete env.PASEO_PASSWORD;
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;

  env.PASEO_HOME = paseoHome;
  env.PASEO_LISTEN = port !== undefined && port !== null ? `127.0.0.1:${port}` : "127.0.0.1:0";
  env.PASEO_WEB_UI_ENABLED = webUiDistDir ? "1" : "0";
  if (webUiDistDir) {
    env.PASEO_WEB_UI_DIST_DIR = webUiDistDir;
  } else {
    delete env.PASEO_WEB_UI_DIST_DIR;
  }
  env.PASEO_RELAY_ENABLED = "0";
  env.PASEO_TUNNEL_AUTOSTART = "0";
  env.PASEO_VOICE_MODE_ENABLED = "0";
  env.PASEO_DICTATION_ENABLED = "0";
  env.PASEO_SERVICE_PROXY_ENABLED = "0";
  env.PASEO_NODE_INSPECT = "0";
  env.PASEO_LOG_LEVEL = "warn";
  env.NODE_COMPILE_CACHE = getNodeCompileCacheDir(worktreeRoot);

  return env;
}

/**
 * Spawn an isolated daemon host process.
 */
export function spawnDaemonHost({
  hostName,
  homeDir,
  port,
  webUiDistDir,
  worktreeRoot = getWorktreeRoot(),
}) {
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(path.join(homeDir, "mission-control"), { recursive: true });
  mkdirSync(path.join(homeDir, "projects"), { recursive: true });

  const logFile = path.join(homeDir, "daemon.log");
  const logFd = openSync(logFile, "a");

  const env = buildDaemonEnv({
    paseoHome: homeDir,
    port,
    webUiDistDir,
    worktreeRoot,
  });

  const script = resolveSupervisorScript(worktreeRoot);
  const args = script.endsWith(".ts") ? ["--import", "tsx", script] : [script];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: worktreeRoot,
    env,
  });

  child.unref();

  return {
    hostName,
    child,
    pid: child.pid,
    homeDir,
    logFile,
  };
}

/**
 * Poll a daemon until it responds 200 OK to /api/health and returns boot info.
 */
export async function waitForDaemonHealth({
  homeDir,
  expectedPort,
  timeoutMs = 30000,
  pollIntervalMs = 25,
}) {
  const startMs = Date.now();
  const pidPath = path.join(homeDir, "paseo.pid");
  const logFile = path.join(homeDir, "daemon.log");

  while (Date.now() - startMs < timeoutMs) {
    if (existsSync(pidPath)) {
      try {
        const raw = readFileSync(pidPath, "utf8");
        const info = JSON.parse(raw);
        if (info && info.listen) {
          const resolvedPort = Number(info.listen.split(":").pop());
          if (!Number.isNaN(resolvedPort) && resolvedPort > 0) {
            const health = await checkHealthEndpoint(resolvedPort);
            if (health.ok) {
              const bootMs = Date.now() - startMs;
              return {
                port: resolvedPort,
                pid: typeof info.pid === "number" ? info.pid : null,
                bootMs,
                httpUrl: `http://127.0.0.1:${resolvedPort}`,
                wsUrl: `ws://127.0.0.1:${resolvedPort}/ws`,
                logFile,
              };
            }
          }
        }
      } catch {
        // Ignore JSON parse errors or partial file reads during write
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // If timed out, extract daemon.log tail for debugging
  let logTail = "(empty log)";
  if (existsSync(logFile)) {
    try {
      const content = readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n");
      logTail = lines.slice(-40).join("\n");
    } catch {}
  }

  throw new Error(
    `Daemon in ${homeDir} failed to become healthy within ${timeoutMs}ms (expected port: ${expectedPort ?? "any"}).\nDaemon log tail:\n${logTail}`,
  );
}

/**
 * Check GET /api/health on a given port.
 */
function checkHealthEndpoint(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        timeout: 500,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(body);
              if (json.status === "ok") {
                resolve({ ok: true, data: json });
                return;
              }
            } catch {}
          }
          resolve({ ok: false, statusCode: res.statusCode });
        });
      },
    );

    req.on("error", () => {
      resolve({ ok: false });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}
