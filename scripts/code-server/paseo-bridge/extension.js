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

// Keep in sync with CODE_SERVER_BRIDGE_PORT in packages/app/src/workspace/browser-editor-url.ts.
const DEFAULT_PORT = 8766;

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

/**
 * Builds the HTTP request handler. `openFile(path, line, column)` is injected so
 * the routing/parsing can be tested without the vscode module.
 */
function createRequestHandler({ openFile }) {
  return async function handleRequest(req, res) {
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "paseo-bridge" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/open") {
        const parsed = parseOpenPayload(await readBody(req));
        if (parsed.error) {
          sendJson(res, 400, { ok: false, error: parsed.error });
          return;
        }
        await openFile(parsed.path, parsed.line, parsed.column);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

let server = null;

function activate(context) {
  const vscode = require("vscode");
  const port = resolvePort();

  const openFile = async (filePath, line, column) => {
    const uri = vscode.Uri.file(filePath);
    const options = { preview: false };
    if (line) {
      const position = new vscode.Position(line - 1, (column ?? 1) - 1);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(uri, options);
  };

  server = http.createServer(createRequestHandler({ openFile }));

  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      // Another code-server window already serves the bridge on this port. Only
      // one window needs to; stand down quietly.
      console.warn(`[paseo-bridge] port ${port} already in use; another window is serving.`);
      server = null;
      return;
    }
    console.error("[paseo-bridge] server error:", error);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[paseo-bridge] listening on 127.0.0.1:${port}`);
  });

  context.subscriptions.push({
    dispose() {
      if (server) {
        server.close();
        server = null;
      }
    },
  });
}

function deactivate() {
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
