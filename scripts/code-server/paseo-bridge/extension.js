const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const BROKER_PORT = 8766;
const OPEN_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 4000;
const RESTORE_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1000;
const REGISTRATION_TTL_MS = 10_000;
const SESSION_VERSION = 1;

let workerServer = null;
let brokerServer = null;
let brokerCandidate = null;
let brokerStarting = false;
let heartbeatTimer = null;
let registerSoonTimer = null;
let windowStateDisposable = null;
let workspaceFoldersDisposable = null;
let sessionDisposables = [];
let extensionContext = null;
let sessionSavePromise = Promise.resolve();
let sessionSaveRequested = false;
let restoringSession = false;
let sessionPersistenceReady = false;
let workerPort = null;
let workerId = null;
let workerStartedAt = null;
let registrationSequence = 0;
const brokerRegistrations = new Map();

function writeLog(line) {
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    fs.appendFileSync(
      path.join(os.homedir(), ".local", "share", "paseo-bridge.log"),
      `${new Date().toISOString()} pid=${process.pid} ${line}\n`,
    );
  } catch {
    // Logging must never break the bridge.
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseOpenPayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "invalid json" };
  }
  const filePath = typeof parsed.path === "string" ? parsed.path.trim() : "";
  if (!filePath) {
    return { error: "missing path" };
  }
  const payload = {
    path: filePath,
    line: positiveIntegerOrNull(parsed.line),
    column: positiveIntegerOrNull(parsed.column),
  };
  const folder = typeof parsed.folder === "string" ? parsed.folder.trim() : "";
  if (folder) {
    payload.folder = folder;
  }
  return payload;
}

function parseFolderPayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "invalid json" };
  }
  const folder = typeof parsed.folder === "string" ? parsed.folder.trim() : "";
  if (!folder) {
    return { error: "missing folder" };
  }
  return { path: folder, folder };
}

function parseRegistrationPayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "invalid json" };
  }
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const port = positiveIntegerOrNull(parsed.port);
  if (!id || !port || port > 65_535) {
    return { error: "invalid registration" };
  }
  return {
    id,
    port,
    folders: Array.isArray(parsed.folders)
      ? parsed.folders.filter((folder) => typeof folder === "string" && folder.trim())
      : [],
    focused: parsed.focused === true,
    startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0,
    sequence: Number.isFinite(parsed.sequence) ? parsed.sequence : 0,
  };
}

async function openFileWithTimeout(filePath, line, column) {
  const vscode = require("vscode");
  const uri = vscode.Uri.file(filePath);
  const options = { preview: false };
  if (line) {
    const position = new vscode.Position(line - 1, (column ?? 1) - 1);
    options.selection = new vscode.Range(position, position);
  }
  let timeout;
  try {
    await Promise.race([
      vscode.window.showTextDocument(uri, options),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("showTextDocument timed out")),
          OPEN_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function closeAllEditors() {
  const vscode = require("vscode");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

function editorSessionStorageKey(folder) {
  const digest = crypto.createHash("sha256").update(path.resolve(folder)).digest("hex");
  return `paseoBridge.editorSession.v${SESSION_VERSION}.${digest}`;
}

function captureEditorSession(vscode = require("vscode")) {
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab ?? null;
  const files = [];
  for (const group of vscode.window.tabGroups.all ?? []) {
    for (const tab of group.tabs ?? []) {
      const uri = tab.input?.uri;
      if (!uri || typeof uri.fsPath !== "string" || !uri.fsPath) {
        continue;
      }
      files.push({
        path: uri.fsPath,
        viewColumn: positiveIntegerOrNull(group.viewColumn),
        active: tab === activeTab,
      });
    }
  }
  return { version: SESSION_VERSION, files };
}

async function restoreEditorSession(session, vscode = require("vscode")) {
  const files = Array.isArray(session?.files)
    ? session.files.filter((file) => typeof file?.path === "string" && file.path.trim())
    : [];
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const activeFile = files.find((file) => file.active === true) ?? null;
  const orderedFiles = activeFile
    ? [...files.filter((file) => file !== activeFile), activeFile]
    : files;
  let restored = 0;
  let failed = 0;
  for (const file of orderedFiles) {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file.path), {
        preview: false,
        preserveFocus: file !== activeFile,
        ...(positiveIntegerOrNull(file.viewColumn)
          ? { viewColumn: positiveIntegerOrNull(file.viewColumn) }
          : {}),
      });
      restored += 1;
    } catch (error) {
      failed += 1;
      writeLog(`session restore skipped path=${file.path}: ${String(error?.message ?? error)}`);
    }
  }
  return { restored, failed };
}

function currentWorkspaceFolder() {
  const vscode = require("vscode");
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

async function persistCurrentEditorSession(folder) {
  if (!extensionContext || restoringSession) {
    return;
  }
  const targetFolder = folder ?? currentWorkspaceFolder();
  if (!targetFolder) {
    return;
  }
  sessionPersistenceReady = true;
  const session = captureEditorSession();
  await extensionContext.globalState.update(editorSessionStorageKey(targetFolder), session);
  writeLog(`session saved folder=${targetFolder} files=${session.files.length}`);
}

function scheduleSessionPersistence() {
  if (!sessionPersistenceReady || restoringSession) {
    return;
  }
  sessionSaveRequested = true;
  sessionSavePromise = sessionSavePromise
    .catch(() => {})
    .then(async () => {
      while (sessionSaveRequested) {
        sessionSaveRequested = false;
        await persistCurrentEditorSession();
      }
      return undefined;
    })
    .catch((error) => {
      writeLog(`session save FAILED: ${String(error?.message ?? error)}`);
    });
}

async function restoreSavedEditorSession(folder) {
  if (!extensionContext) {
    throw new Error("extension context unavailable");
  }
  const session = extensionContext.globalState.get(editorSessionStorageKey(folder));
  sessionPersistenceReady = true;
  if (!session) {
    writeLog(`session restore skipped folder=${folder}: no saved session`);
    return { found: false, restored: 0, failed: 0 };
  }
  restoringSession = true;
  try {
    const result = await restoreEditorSession(session);
    writeLog(`session restored folder=${folder} files=${result.restored} failed=${result.failed}`);
    return { found: true, ...result };
  } finally {
    restoringSession = false;
  }
}

async function handleWorkerCloseAll({ res, parsed, closeEditors, saveSession, log }) {
  try {
    await closeEditors();
    await saveSession(parsed.folder);
    log(`worker close-all OK folder=${parsed.folder}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`worker close-all FAILED folder=${parsed.folder}: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
  }
}

async function handleWorkerOpen({ res, parsed, openFile, saveSession, log }) {
  log(`worker open path=${parsed.path} line=${parsed.line ?? "-"} col=${parsed.column ?? "-"}`);
  try {
    await openFile(parsed.path, parsed.line, parsed.column);
    await saveSession(parsed.folder);
    log(`worker open OK path=${parsed.path}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`worker open FAILED path=${parsed.path}: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
  }
}

async function handleWorkerRestore({ res, parsed, restoreSession, log }) {
  try {
    const result = await restoreSession(parsed.folder);
    log(
      `worker restore OK folder=${parsed.folder} found=${result.found} files=${result.restored} failed=${result.failed}`,
    );
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`worker restore FAILED folder=${parsed.folder}: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
  }
}

function createRequestHandler({
  openFile = openFileWithTimeout,
  closeEditors = closeAllEditors,
  saveSession = persistCurrentEditorSession,
  restoreSession = restoreSavedEditorSession,
  acceptsPayload = () => true,
  log = writeLog,
} = {}) {
  return async (req, res) => {
    if (req.method === "OPTIONS") {
      sendOptions(res);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, service: "paseo-bridge-worker", workerId });
      return;
    }
    const isOpen = req.method === "POST" && req.url === "/open";
    const isCloseAll = req.method === "POST" && req.url === "/close-all";
    const isRestore = req.method === "POST" && req.url === "/restore";
    if (!isOpen && !isCloseAll && !isRestore) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    let parsed;
    try {
      const body = await readBody(req);
      parsed = isOpen ? parseOpenPayload(body) : parseFolderPayload(body);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      return;
    }
    if (parsed.error) {
      sendJson(res, 400, { ok: false, error: parsed.error });
      return;
    }
    if (!acceptsPayload(parsed)) {
      log(`worker rejected path=${parsed.path} folder=${parsed.folder ?? "-"}`);
      sendJson(res, 409, { ok: false, error: "workspace folder mismatch" });
      return;
    }
    if (isCloseAll) {
      await handleWorkerCloseAll({ res, parsed, closeEditors, saveSession, log });
      return;
    }
    if (isRestore) {
      await handleWorkerRestore({ res, parsed, restoreSession, log });
      return;
    }
    await handleWorkerOpen({ res, parsed, openFile, saveSession, log });
  };
}

function workerAcceptsPayload(payload) {
  const folders = currentRegistration().folders;
  if (payload.folder) {
    return folders.some((folder) => path.resolve(folder) === path.resolve(payload.folder));
  }
  return folders.some((folder) => pathIsInside(folder, payload.path));
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function selectBrokerTargets(registrations, payload, now = Date.now()) {
  const scored = Array.from(registrations.values())
    .filter((registration) => now - registration.lastSeen <= REGISTRATION_TTL_MS)
    .map((registration) => {
      const exactFolder =
        payload.folder &&
        registration.folders.some(
          (folder) => path.resolve(folder) === path.resolve(payload.folder),
        );
      const containsFile = registration.folders.some((folder) =>
        pathIsInside(folder, payload.path),
      );
      let folderScore = 0;
      if (exactFolder) {
        folderScore = 2;
      } else if (containsFile) {
        folderScore = 1;
      }
      return Object.assign({}, registration, { folderScore });
    });
  const eligible = scored.filter((registration) =>
    payload.folder ? registration.folderScore === 2 : registration.folderScore === 1,
  );
  return eligible.sort(
    (left, right) =>
      right.folderScore - left.folderScore ||
      right.startedAt - left.startedAt ||
      Number(right.focused) - Number(left.focused) ||
      right.lastSeen - left.lastSeen,
  );
}

function requestLoopback({ port, method, route, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: HOST,
        port,
        path: route,
        method,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 500, body: responseBody });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function handleBrokerRegistration({ req, res, registrations, now, log }) {
  let parsed;
  try {
    parsed = parseRegistrationPayload(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    return;
  }
  if (parsed.error) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }
  const existing = registrations.get(parsed.id);
  const isNew = !existing;
  if (!existing || parsed.sequence >= existing.sequence) {
    registrations.set(parsed.id, { ...parsed, lastSeen: now() });
  } else {
    registrations.set(parsed.id, { ...existing, lastSeen: now() });
  }
  if (isNew) {
    log(
      `broker registered worker=${parsed.id} port=${parsed.port} folders=${parsed.folders.join(",") || "-"}`,
    );
  }
  sendJson(res, 200, { ok: true });
}

async function handleBrokerOpen({
  req,
  res,
  registrations,
  now,
  forward,
  log,
  parsePayload = parseOpenPayload,
  workerRoute = "/open",
  action = "open",
}) {
  let payload;
  try {
    payload = parsePayload(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    return;
  }
  if (payload.error) {
    sendJson(res, 400, { ok: false, error: payload.error });
    return;
  }

  const targets = selectBrokerTargets(registrations, payload, now());
  if (targets.length === 0) {
    log(`broker ${action} FAILED path=${payload.path}: no registered windows`);
    sendJson(res, 503, { ok: false, error: "no registered VS Code windows" });
    return;
  }
  for (const target of targets) {
    log(
      `broker ${action} path=${payload.path} folder=${payload.folder ?? "-"} worker=${target.id} port=${target.port}`,
    );
    try {
      const result = await forward({ port: target.port, payload, route: workerRoute });
      if (result.status === 409) {
        registrations.delete(target.id);
        log(`broker worker rejected workspace worker=${target.id}`);
        continue;
      }
      res.writeHead(result.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(result.body);
      return;
    } catch (error) {
      registrations.delete(target.id);
      log(`broker worker unavailable worker=${target.id}: ${String(error?.message ?? error)}`);
    }
  }
  sendJson(res, 503, { ok: false, error: "all registered VS Code windows are unavailable" });
}

function createBrokerHandler({
  registrations = brokerRegistrations,
  now = Date.now,
  forward = ({ port, payload, route }) =>
    requestLoopback({
      port,
      method: "POST",
      route,
      body: JSON.stringify(payload),
      timeoutMs: route === "/restore" ? RESTORE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    }),
  log = writeLog,
} = {}) {
  return async (req, res) => {
    if (req.method === "OPTIONS") {
      sendOptions(res);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "paseo-bridge-broker",
        registrations: registrations.size,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/register") {
      await handleBrokerRegistration({ req, res, registrations, now, log });
      return;
    }
    if (req.method === "POST" && req.url === "/broker/open") {
      await handleBrokerOpen({ req, res, registrations, now, forward, log });
      return;
    }
    if (req.method === "POST" && req.url === "/broker/close-all") {
      await handleBrokerOpen({
        req,
        res,
        registrations,
        now,
        forward,
        log,
        parsePayload: parseFolderPayload,
        workerRoute: "/close-all",
        action: "close-all",
      });
      return;
    }
    if (req.method === "POST" && req.url === "/broker/restore") {
      await handleBrokerOpen({
        req,
        res,
        registrations,
        now,
        forward,
        log,
        parsePayload: parseFolderPayload,
        workerRoute: "/restore",
        action: "restore",
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  };
}

function currentRegistration(sequence = registrationSequence) {
  const vscode = require("vscode");
  return {
    id: workerId,
    port: workerPort,
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    focused: vscode.window.state.focused,
    startedAt: workerStartedAt,
    sequence,
  };
}

function attemptBrokerElection() {
  if (brokerServer || brokerStarting) {
    return;
  }
  brokerStarting = true;
  const candidate = http.createServer(createBrokerHandler());
  brokerCandidate = candidate;
  brokerRegistrations.clear();
  candidate.once("error", (error) => {
    brokerStarting = false;
    if (brokerCandidate === candidate) {
      brokerCandidate = null;
    }
    if (error?.code !== "EADDRINUSE") {
      writeLog(`broker election FAILED: ${String(error?.message ?? error)}`);
    }
  });
  candidate.listen(BROKER_PORT, HOST, () => {
    if (!workerId) {
      candidate.close();
      return;
    }
    brokerStarting = false;
    brokerCandidate = null;
    brokerServer = candidate;
    writeLog(`broker elected port=${BROKER_PORT}`);
    void registerWorker();
  });
}

async function registerWorker() {
  if (!workerId || !workerPort) {
    return;
  }
  try {
    const sequence = ++registrationSequence;
    const result = await requestLoopback({
      port: BROKER_PORT,
      method: "POST",
      route: "/register",
      body: JSON.stringify(currentRegistration(sequence)),
      timeoutMs: 1000,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`broker registration returned ${result.status}`);
    }
  } catch {
    attemptBrokerElection();
  }
}

function scheduleRegistration() {
  clearTimeout(registerSoonTimer);
  registerSoonTimer = setTimeout(() => {
    registerSoonTimer = null;
    void registerWorker();
  }, 50);
  registerSoonTimer.unref?.();
}

function activate(context) {
  const vscode = require("vscode");
  extensionContext = context;
  sessionPersistenceReady = false;
  workerId = crypto.randomUUID();
  workerStartedAt = Date.now();
  workerServer = http.createServer(createRequestHandler({ acceptsPayload: workerAcceptsPayload }));
  workerServer.on("error", (error) => {
    writeLog(`worker server FAILED: ${String(error?.message ?? error)}`);
  });
  workerServer.listen(0, HOST, () => {
    const address = workerServer?.address();
    workerPort = typeof address === "object" && address ? address.port : null;
    writeLog(
      `activate worker=${workerId} port=${workerPort} folders=${currentRegistration().folders.join(",") || "-"}`,
    );
    attemptBrokerElection();
    scheduleRegistration();
    heartbeatTimer = setInterval(() => void registerWorker(), HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  });
  windowStateDisposable = vscode.window.onDidChangeWindowState(scheduleRegistration);
  workspaceFoldersDisposable = vscode.workspace.onDidChangeWorkspaceFolders(scheduleRegistration);
  sessionDisposables = [
    vscode.window.tabGroups.onDidChangeTabs(scheduleSessionPersistence),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleSessionPersistence),
    vscode.window.onDidChangeActiveTextEditor(scheduleSessionPersistence),
  ];
}

function deactivate() {
  clearInterval(heartbeatTimer);
  clearTimeout(registerSoonTimer);
  heartbeatTimer = null;
  registerSoonTimer = null;
  windowStateDisposable?.dispose();
  workspaceFoldersDisposable?.dispose();
  for (const disposable of sessionDisposables) {
    disposable.dispose();
  }
  sessionDisposables = [];
  windowStateDisposable = null;
  workspaceFoldersDisposable = null;
  extensionContext = null;
  sessionSavePromise = Promise.resolve();
  sessionSaveRequested = false;
  restoringSession = false;
  sessionPersistenceReady = false;
  workerServer?.close();
  brokerServer?.close();
  brokerCandidate?.close();
  workerServer = null;
  brokerServer = null;
  brokerCandidate = null;
  brokerStarting = false;
  brokerRegistrations.clear();
  writeLog(`deactivate worker=${workerId ?? "-"}`);
  workerPort = null;
  workerId = null;
  workerStartedAt = null;
  registrationSequence = 0;
}

module.exports = {
  activate,
  createBrokerHandler,
  createRequestHandler,
  captureEditorSession,
  deactivate,
  parseOpenPayload,
  restoreEditorSession,
  selectBrokerTargets,
};
