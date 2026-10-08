import net from "node:net";

/**
 * Reserve an ephemeral OS port (close-on-bind; used as daemon listen port).
 */
export async function allocatePort(host = "127.0.0.1") {
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, host, () => {
    const address = server.address();
    const port = address.port;
    server.close((err) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
  return await promise;
}

/**
 * Allocate count unique ports.
 */
export async function allocatePorts(count, host = "127.0.0.1") {
  const ports = [];
  while (ports.length < count) {
    const port = await allocatePort(host);
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

/**
 * Check if a process ID is currently alive.
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process group cleanly (SIGTERM, wait up to timeoutMs, then SIGKILL).
 */
export async function killProcessGroup(pgid, { timeoutMs = 5000, signal = "SIGTERM" } = {}) {
  if (!pgid || typeof pgid !== "number" || pgid <= 0) {
    return true;
  }

  if (!isPidAlive(pgid)) {
    return true;
  }

  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if (err.code === "ESRCH") return true;
    // Fall back to direct pid kill if pgid kill fails (e.g. not group leader)
    try {
      process.kill(pgid, signal);
    } catch (e) {
      if (e.code === "ESRCH") return true;
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pgid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Force kill if still alive after timeout
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pgid, "SIGKILL");
    } catch {}
  }

  const forceStart = Date.now();
  while (Date.now() - forceStart < 1000) {
    if (!isPidAlive(pgid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return !isPidAlive(pgid);
}

/**
 * Test if a TCP port is currently free to bind on host.
 */
export async function isPortFree(port, host = "127.0.0.1") {
  const { promise, resolve } = Promise.withResolvers();
  const server = net.createServer();
  server.unref();
  server.once("error", () => {
    resolve(false);
  });
  server.listen(port, host, () => {
    server.close(() => {
      resolve(true);
    });
  });
  return await promise;
}

/**
 * Wait until a port is free or timeoutMs expires.
 */
export async function waitForPortFree(port, { timeoutMs = 5000, host = "127.0.0.1" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port, host)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return await isPortFree(port, host);
}
