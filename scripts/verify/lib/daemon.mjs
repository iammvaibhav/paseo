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
  password = null,
  skillsHome = null,
  listenHost = "127.0.0.1",
}) {
  const env = { ...process.env };

  // Crucial: remove leaky environment variables
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;

  if (password) {
    env.PASEO_PASSWORD = password;
  } else {
    delete env.PASEO_PASSWORD;
  }

  if (skillsHome) {
    env.PASEO_SKILLS_HOME = skillsHome;
  }

  env.PASEO_HOME = paseoHome;
  env.PASEO_LISTEN =
    port !== undefined && port !== null ? `${listenHost}:${port}` : `${listenHost}:0`;
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
  // info (not warn): itsaplan bridge proof lines (itsaplan.project.mapped / existing_adopted) log at info.
  env.PASEO_LOG_LEVEL = "info";
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
  password = null,
  skillsHome = null,
  listenHost = "127.0.0.1",
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
    password,
    skillsHome,
    listenHost,
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

function parseListenAddress(listen, fallbackHost) {
  const colonIdx = listen.lastIndexOf(":");
  if (colonIdx < 0) {
    return { hostPart: fallbackHost, port: Number(listen) };
  }
  return {
    hostPart: listen.slice(0, colonIdx) || fallbackHost,
    port: Number(listen.slice(colonIdx + 1)),
  };
}

function resolveHealthHost(listenHost, hostPart) {
  if (listenHost && listenHost !== "127.0.0.1") {
    return listenHost;
  }
  return hostPart || "127.0.0.1";
}

function readPidInfo(pidPath) {
  try {
    return JSON.parse(readFileSync(pidPath, "utf8"));
  } catch {
    // Ignore JSON parse errors or partial file reads during write
    return null;
  }
}

async function pollPidForHealth({ pidPath, listenHost, startMs, logFile }) {
  if (!existsSync(pidPath)) {
    return null;
  }
  const info = readPidInfo(pidPath);
  if (!info || !info.listen) {
    return null;
  }
  const { hostPart, port } = parseListenAddress(info.listen, listenHost);
  if (Number.isNaN(port) || port <= 0) {
    return null;
  }
  const host = resolveHealthHost(listenHost, hostPart);
  const health = await checkHealthEndpoint(port, host);
  if (!health.ok) {
    return null;
  }
  return {
    port,
    host,
    pid: typeof info.pid === "number" ? info.pid : null,
    bootMs: Date.now() - startMs,
    httpUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    logFile,
  };
}

function readLogTail(logFile) {
  if (!existsSync(logFile)) {
    return "(empty log)";
  }
  try {
    const content = readFileSync(logFile, "utf8");
    return content.trim().split("\n").slice(-40).join("\n");
  } catch {
    return "(empty log)";
  }
}

/**
 * Poll a daemon until it responds 200 OK to /api/health and returns boot info.
 */
export async function waitForDaemonHealth({
  homeDir,
  expectedPort,
  timeoutMs = 30000,
  pollIntervalMs = 25,
  listenHost = "127.0.0.1",
}) {
  const startMs = Date.now();
  const pidPath = path.join(homeDir, "paseo.pid");
  const logFile = path.join(homeDir, "daemon.log");

  while (Date.now() - startMs < timeoutMs) {
    const healthy = await pollPidForHealth({ pidPath, listenHost, startMs, logFile });
    if (healthy) {
      return healthy;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // If timed out, extract daemon.log tail for debugging
  const logTail = readLogTail(logFile);

  throw new Error(
    `Daemon in ${homeDir} failed to become healthy within ${timeoutMs}ms (expected port: ${expectedPort ?? "any"}).\nDaemon log tail:\n${logTail}`,
  );
}

/**
 * Check GET /api/health on a given port.
 */
function checkHealthEndpoint(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: host,
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
