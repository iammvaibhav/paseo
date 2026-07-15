// Paseo Bridge — a minimal code-server extension that lets the Paseo desktop app
// open files in an already-loaded VS Code Web window with no page reload.
//
// The app reaches this listener same-origin through code-server's built-in
// reverse proxy: a fetch("/proxy/<PORT>/open", …) from the workbench page is
// forwarded to http://127.0.0.1:<PORT>/open here, and we call
// vscode.window.showTextDocument. Keeping the listener on loopback means we do
// not expose a new control port on the VPN.
//
// Plain CommonJS on purpose — code-server loads unpacked extensions from
// ~/.local/share/code-server/extensions/ with no build step. `vscode` is
// required lazily inside activate() so the request-handling logic below can be
// unit-tested under plain Node.

const http = require("http");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");

// Keep in sync with CODE_SERVER_BRIDGE_PORT in packages/app/src/workspace/browser-editor-url.ts.
const DEFAULT_PORT = 8766;

// If showTextDocument doesn't resolve in this long, assume the window holding the
// port is backgrounded/hidden (can't render an editor) and fail so the app falls
// back to a reload — the file still opens, just not in place.
const OPEN_TIMEOUT_MS = 2500;

// Debug log the app author can read (host-local): ~/.paseo-bridge.log
const LOG_FILE = nodePath.join(os.homedir(), ".paseo-bridge.log");

function logLine(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Never let logging break the bridge.
  }
}

function resolvePort() {
  const fromEnv = Number.parseInt(process.env.PASEO_BRIDGE_PORT ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

function toPositiveInt(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseOpenPayload(raw) {
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: "invalid json" };
  }
  const path = typeof data.path === "string" ? data.path.trim() : "";
  if (!path) {
    return { error: "missing path" };
  }
  return { path, line: toPositiveInt(data.line), column: toPositiveInt(data.column) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Guard against unbounded bodies; open requests are tiny.
      if (size > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(payload);
}

async function handleOpen(req, res, openFile, log) {
  const parsed = parseOpenPayload(await readBody(req));
  if (parsed.error) {
    log(`open bad-request: ${parsed.error}`);
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }
  log(`open path=${parsed.path} line=${parsed.line ?? "-"} col=${parsed.column ?? "-"}`);
  // Wait for showTextDocument, but bounded: it hangs forever when the window
  // holding this port is backgrounded/hidden. On timeout, respond 500 so the app
  // falls back to a reload (the file still opens). On success, 200 (fast, in
  // place). Either way we never hang the app.
  let timer;
  try {
    await Promise.race([
      Promise.resolve(openFile(parsed.path, parsed.line, parsed.column)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("showTextDocument timed out")), OPEN_TIMEOUT_MS);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
    clearTimeout(timer);
    log(`open OK path=${parsed.path}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    clearTimeout(timer);
    log(`open FAILED path=${parsed.path}: ${String(error?.message ?? error)}`);
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
}

/**
 * Builds the HTTP request handler. `openFile(path, line, column)` is injected so
 * the routing/parsing can be tested without the vscode module. `log` is optional
 * so tests stay quiet.
 */
function createRequestHandler({ openFile, log = () => {} }) {
  return async function handleRequest(req, res) {
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      log(`${req.method} ${url.pathname}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "paseo-bridge" });
        return;
      }

      // Lets the Paseo app push correlation logs into the same file.
      if (req.method === "POST" && url.pathname === "/log") {
        const raw = await readBody(req);
        let msg = raw;
        try {
          msg = JSON.parse(raw)?.msg ?? raw;
        } catch {
          // keep raw
        }
        log(`[app] ${msg}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/open") {
        await handleOpen(req, res, openFile, log);
        return;
      }

      log(`404 ${req.method} ${url.pathname}`);
      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

let server = null;

function activate() {
  const vscode = require("vscode");
  const port = resolvePort();
  logLine(`activate pid=${process.pid} port=${port}`);

  const openFile = async (filePath, line, column) => {
    const uri = vscode.Uri.file(filePath);
    const options = { preview: false };
    if (line) {
      const position = new vscode.Position(line - 1, (column ?? 1) - 1);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(uri, options);
  };

  server = http.createServer(createRequestHandler({ openFile, log: logLine }));

  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      // Another code-server window already serves the bridge on this port. Only
      // one window needs to; stand down quietly.
      logLine(`port ${port} already in use; another window is serving; standing down`);
      server = null;
      return;
    }
    logLine(`server error: ${String(error?.message ?? error)}`);
  });

  server.listen(port, "127.0.0.1", () => {
    logLine(`listening on 127.0.0.1:${port}`);
  });
}

function deactivate() {
  logLine("deactivate");
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  activate,
  deactivate,
  createRequestHandler,
  parseOpenPayload,
  resolvePort,
  DEFAULT_PORT,
};
