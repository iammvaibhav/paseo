const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const HOST = "127.0.0.1";
// The trial instance in multiroot-trial.sh sets its own so it never registers
// with the live code-server's broker.
const BROKER_PORT = Number(process.env.PASEO_BRIDGE_BROKER_PORT) || 8766;
const OPEN_TIMEOUT_MS = 2500;
// Must stay under REQUEST_TIMEOUT_MS: the broker gives up on the worker first.
const DIFF_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 4000;
const RESTORE_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1000;
const REGISTRATION_TTL_MS = 10_000;
const SESSION_VERSION = 1;
/** URI scheme for one git revision of one file (the read-only side of a diff). */
const GIT_REVISION_SCHEME = "paseo-git";

let workerServer = null;
let brokerServer = null;
let brokerCandidate = null;
let brokerStarting = false;
let heartbeatTimer = null;
let registerSoonTimer = null;
let windowStateDisposable = null;
let workspaceFoldersDisposable = null;
let gitRevisionDisposable = null;
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

// Chat links and typed paths use `~`; only this host knows what it expands to.
function expandHomePath(target, homeDir = require("node:os").homedir()) {
  if (target === "~") {
    return homeDir;
  }
  return target.startsWith("~/") ? path.join(homeDir, target.slice(2)) : target;
}

function parseOpenPayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "invalid json" };
  }
  const filePath = typeof parsed.path === "string" ? expandHomePath(parsed.path.trim()) : "";
  if (!filePath) {
    return { error: "missing path" };
  }
  const payload = {
    path: filePath,
    line: positiveIntegerOrNull(parsed.line),
    column: positiveIntegerOrNull(parsed.column),
    mode: parsed.mode === "diff" ? "diff" : "file",
  };
  const baseRef = typeof parsed.baseRef === "string" ? parsed.baseRef.trim() : "";
  if (baseRef) {
    payload.baseRef = baseRef;
  }
  const folder = typeof parsed.folder === "string" ? parsed.folder.trim() : "";
  if (folder) {
    payload.folder = folder;
  }
  return payload;
}

/** App-facing command names → the VS Code commands they run. Nothing else runs. */
const BRIDGE_COMMANDS = {
  quickOpen: "workbench.action.quickOpen",
  openFile: "workbench.action.files.openFile",
};

function parseCommandPayload(body) {
  const parsed = parseFolderPayload(body);
  if (parsed.error) {
    return parsed;
  }
  const command = JSON.parse(body).command;
  if (!Object.hasOwn(BRIDGE_COMMANDS, command)) {
    return { error: "unknown command" };
  }
  return { ...parsed, command };
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

function parseSwitchPayload(body) {
  const parsed = parseFolderPayload(body);
  if (parsed.error) {
    return parsed;
  }
  const workspaceFile = JSON.parse(body).workspaceFile;
  if (typeof workspaceFile !== "string" || !workspaceFile.trim()) {
    return { error: "missing workspaceFile" };
  }
  return { ...parsed, folder: expandHomePath(parsed.folder), workspaceFile: workspaceFile.trim() };
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
    workspaceFile:
      typeof parsed.workspaceFile === "string" && parsed.workspaceFile.trim()
        ? parsed.workspaceFile.trim()
        : null,
    startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0,
    sequence: Number.isFinite(parsed.sequence) ? parsed.sequence : 0,
  };
}

async function withTimeout(promise, message, timeoutMs = OPEN_TIMEOUT_MS) {
  let timeout;
  try {
    await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function openFileWithTimeout(filePath, line, column) {
  const vscode = require("vscode");
  const options = { preview: false };
  if (line) {
    const position = new vscode.Position(line - 1, (column ?? 1) - 1);
    options.selection = new vscode.Range(position, position);
  }
  await withTimeout(
    vscode.window.showTextDocument(vscode.Uri.file(filePath), options),
    "showTextDocument timed out",
  );
}

/**
 * Read-only side of a diff: one revision of one file, served by this extension.
 *
 * The git extension's own `git:` URIs are not usable here. It only resolves paths
 * belonging to a repository it has opened, and a superproject over
 * `git.detectSubmodulesLimit` (10) submodules never opens them — so every
 * SCM-backed command silently fails for files inside a submodule, which is
 * exactly where Paseo's changes come from. `git show` needs none of that.
 */
function gitRevisionUri(vscode, params) {
  return vscode.Uri.from({
    scheme: GIT_REVISION_SCHEME,
    // Keep the real filename in the path so VS Code picks the language mode.
    path: `/${params.path}`,
    query: JSON.stringify(params),
  });
}

function gitRepoRoot(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", path.dirname(filePath), "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function gitShow(repoRoot, ref, relativePath) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoRoot, "show", `${ref}:${relativePath}`],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      // A path absent at that ref is an added file. An empty left side is the
      // diff to show, not an error.
      (error, stdout) => resolve(error ? Buffer.alloc(0) : stdout),
    );
  });
}

function createGitRevisionProvider(vscode) {
  const emitter = new vscode.EventEmitter();
  const read = async (uri) => {
    const params = JSON.parse(uri.query);
    return gitShow(params.repo, params.ref, params.path);
  };
  return {
    onDidChangeFile: emitter.event,
    watch: () => new vscode.Disposable(() => {}),
    async stat(uri) {
      const content = await read(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: content.length,
        permissions: vscode.FilePermission.Readonly,
      };
    },
    readFile: read,
    readDirectory: () => [],
    createDirectory: () => {},
    writeFile: () => {
      throw vscode.FileSystemError.NoPermissions();
    },
    delete: () => {
      throw vscode.FileSystemError.NoPermissions();
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions();
    },
  };
}

function hasDiffTab(vscode, left, right) {
  for (const group of vscode.window.tabGroups.all ?? []) {
    for (const tab of group.tabs ?? []) {
      const input = tab.input;
      if (
        input?.original?.toString() === left.toString() &&
        input?.modified?.toString() === right.toString()
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * VS Code's native diff editor for a changed file. Without a base ref the right
 * side is the working file, so it stays editable — the same shape as the SCM
 * view's "Open Changes". With one it is `baseRef..HEAD`, matching what Paseo's
 * Committed view lists.
 *
 * Success is "the diff tab exists", not "the `vscode.diff` command resolved".
 * That command settles only once the diff has been *computed*, and VS Code caps
 * its own diff algorithm at `diffEditor.maxComputationTime` (5s by default) —
 * so a heavily rewritten file resolved after any timeout small enough to fit
 * the broker's request budget, and the caller reloaded away from an editor that
 * was already on screen.
 */
async function openDiffWithTimeout(filePath, baseRef) {
  const vscode = require("vscode");
  const repo = await gitRepoRoot(filePath);
  const relativePath = path.relative(repo, filePath);
  const name = path.basename(filePath);
  const left = gitRevisionUri(vscode, { repo, ref: baseRef ?? "HEAD", path: relativePath });
  const right = baseRef
    ? gitRevisionUri(vscode, { repo, ref: "HEAD", path: relativePath })
    : vscode.Uri.file(filePath);

  let failure = null;
  vscode.commands
    .executeCommand(
      "vscode.diff",
      left,
      right,
      baseRef ? `${name} (${baseRef} ↔ HEAD)` : `${name} (working tree)`,
      { preview: false },
    )
    .then(undefined, (error) => {
      failure = error;
    });

  const deadline = Date.now() + DIFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failure) {
      throw failure;
    }
    if (hasDiffTab(vscode, left, right)) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
  throw new Error("openDiff timed out");
}

async function closeAllEditors() {
  const vscode = require("vscode");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

// Shows the folder in VS Code's Explorer (which also makes the sidebar visible).
async function revealFolderWithTimeout(folderPath) {
  const vscode = require("vscode");
  await withTimeout(
    vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(folderPath)),
    "revealInExplorer timed out",
  );
}

// Not awaited: Quick Open and the Open File dialog settle only when the user
// closes them, which would hold the request open past every timeout.
function runBridgeCommand(command) {
  const vscode = require("vscode");
  Promise.resolve(vscode.commands.executeCommand(BRIDGE_COMMANDS[command])).catch((error) => {
    writeLog(`command ${command} FAILED: ${String(error?.message ?? error)}`);
  });
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

// In a multi-root window (opened from a `.code-workspace` file) folder 0 is the
// fixed root that keeps the window alive across switches and the project is the
// last folder; a plain folder window has just the one.
function currentWorkspaceFolder() {
  const vscode = require("vscode");
  const folders = vscode.workspace.workspaceFolders ?? [];
  const project = vscode.workspace.workspaceFile ? folders.at(-1) : folders[0];
  return project?.uri.fsPath ?? null;
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

/**
 * Swaps the project folder of a multi-root window in place: no page reload, no
 * new extension host. Folder 0 (the fixed root) never changes, because changing
 * the first workspace folder restarts every extension. The project's editor
 * tabs are saved and restored the same way a reload would.
 */
async function switchProjectFolder(nextFolder) {
  const vscode = require("vscode");
  if (!vscode.workspace.workspaceFile) {
    throw new Error("switch needs a multi-root (.code-workspace) window");
  }
  const started = Date.now();
  // Per-phase milliseconds, returned and logged: a slow switch says where.
  const phases = {};
  let mark = started;
  const lap = (name) => {
    const now = Date.now();
    phases[name] = now - mark;
    mark = now;
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  const previous = folders.length > 1 ? currentWorkspaceFolder() : null;
  if (previous && path.resolve(previous) === path.resolve(nextFolder)) {
    // The app asks for the open project after every window load. A fresh
    // window opens with no editors (code-server's web session restore is
    // unreliable), so bring back the saved tabs; otherwise leave them alone.
    const hasTabs = vscode.window.tabGroups.all.some((group) => group.tabs.length > 0);
    const restored = hasTabs ? { restored: 0 } : await restoreSavedEditorSession(nextFolder);
    lap("restoreTabs");
    return { switched: false, ms: Date.now() - started, restored: restored.restored, phases };
  }
  if (previous) {
    await persistCurrentEditorSession(previous);
  }
  lap("save");
  restoringSession = true;
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    lap("closeEditors");
    let subscription = null;
    const changed = new Promise((resolve) => {
      subscription = vscode.workspace.onDidChangeWorkspaceFolders(resolve);
    });
    try {
      writeProjectIntoWorkspace(nextFolder, { swapFolder: true });
      await withTimeout(changed, "workspace folder change timed out", 10_000);
    } finally {
      subscription?.dispose();
    }
    lap("swapFolderAndSettings");
  } finally {
    restoringSession = false;
  }
  const restored = await restoreSavedEditorSession(nextFolder);
  lap("restoreTabs");
  return { switched: true, ms: Date.now() - started, restored: restored.restored, phases };
}

const MIRRORED_SETTINGS_KEY = "paseoBridge.mirroredProjectSettingKeys";

/**
 * Writes the project into the window's `.code-workspace` file in one write:
 * optionally the project folder (folder 1; folder 0 never changes), and the
 * project's `.vscode/settings.json` copied into the workspace settings.
 *
 * Why the copy: a multi-root window applies only resource-scoped settings from
 * a folder's own settings file and ignores window-scoped ones (and some
 * extension settings). In the workspace settings all of it applies, as in a
 * plain folder window. Only keys this bridge copied are ever removed again.
 *
 * Why one direct write: `updateWorkspaceFolders` and every
 * `WorkspaceConfiguration.update` each rewrite and reload the workspace file
 * (150–450 ms apiece, measured), so a switch cost one cycle per settings key.
 * VS Code watches the file and applies folders and settings from it together.
 */
function writeProjectIntoWorkspace(projectFolder, { swapFolder }) {
  const vscode = require("vscode");
  const workspacePath = vscode.workspace.workspaceFile?.fsPath;
  if (!workspacePath) {
    throw new Error("no .code-workspace file for this window");
  }
  let projectSettings = {};
  try {
    projectSettings = parseJsonc(
      fs.readFileSync(path.join(projectFolder, ".vscode", "settings.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      writeLog(
        `settings mirror: unreadable settings in ${projectFolder}: ${error?.message ?? error}`,
      );
    }
  }
  const current = fs.readFileSync(workspacePath, "utf8");
  const workspace = parseJsonc(current);
  const settings = { ...workspace.settings };
  for (const key of extensionContext?.workspaceState.get(MIRRORED_SETTINGS_KEY) ?? []) {
    delete settings[key];
  }
  Object.assign(settings, resolveProjectFolderVariables(projectSettings, projectFolder));
  const next = {
    ...workspace,
    folders: swapFolder ? [workspace.folders[0], { path: projectFolder }] : workspace.folders,
    settings,
  };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text !== current) {
    fs.writeFileSync(workspacePath, text);
  }
  void extensionContext?.workspaceState.update(MIRRORED_SETTINGS_KEY, Object.keys(projectSettings));
}

function mirrorProjectSettings(folder) {
  try {
    writeProjectIntoWorkspace(folder, { swapFolder: false });
  } catch (error) {
    writeLog(`settings mirror FAILED for ${folder}: ${error?.message ?? error}`);
  }
}

/**
 * Rewrites `${workspaceFolder}` (and its deprecated alias `${workspaceRoot}`)
 * and `${workspaceFolderBasename}` in copied project settings to the project
 * itself. In the project's own folder settings they mean that folder; copied
 * into workspace settings of a two-folder window they are ambiguous, and
 * extensions resolve them against the first folder (the fixed root) or not at
 * all. Scoped `${workspaceFolder:name}` is already unambiguous and stays.
 */
function resolveProjectFolderVariables(value, projectFolder) {
  if (typeof value === "string") {
    return value
      .replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, projectFolder)
      .replace(/\$\{workspaceFolderBasename\}/g, path.basename(projectFolder));
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveProjectFolderVariables(item, projectFolder));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveProjectFolderVariables(item, projectFolder),
      ]),
    );
  }
  return value;
}

/** JSON with comments and trailing commas, the format of VS Code settings files. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        index += 1;
        out += text[index] ?? "";
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else if (char === ",") {
      // Drop a trailing comma: one followed only by blanks/comments and a closer.
      if (!/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*[}\]]/.test(text.slice(index + 1))) {
        out += char;
      }
    } else {
      out += char;
    }
  }
  return JSON.parse(out);
}

async function handleWorkerSwitch({ res, parsed, switchFolder, log }) {
  try {
    const result = await switchFolder(parsed.folder);
    log(
      `worker switch OK folder=${parsed.folder} ms=${result.ms} restored=${result.restored} phases=${JSON.stringify(result.phases ?? {})}`,
    );
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`worker switch FAILED folder=${parsed.folder}: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
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

async function handleWorkerOpen({ res, parsed, deps, log }) {
  log(
    `worker ${parsed.mode} path=${parsed.path} line=${parsed.line ?? "-"} col=${parsed.column ?? "-"} base=${parsed.baseRef ?? "-"}`,
  );
  // Opening a path that does not exist would leave VS Code showing an empty
  // editor named after it, and the caller retrying with a `?payload` reload
  // makes that phantom editor survive. Report it instead.
  if (!deps.fileExists(parsed.path)) {
    log(`worker ${parsed.mode} MISSING path=${parsed.path}`);
    sendJson(res, 404, { ok: false, error: "file not found" });
    return;
  }
  try {
    if (parsed.mode === "diff") {
      await deps.openDiff(parsed.path, parsed.baseRef ?? null);
    } else if (deps.isDirectory(parsed.path)) {
      await deps.revealFolder(parsed.path);
    } else {
      await deps.openFile(parsed.path, parsed.line, parsed.column);
    }
    await deps.saveSession(parsed.folder);
    log(`worker ${parsed.mode} OK path=${parsed.path}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`worker ${parsed.mode} FAILED path=${parsed.path}: ${message}`);
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
  openDiff = openDiffWithTimeout,
  revealFolder = revealFolderWithTimeout,
  runCommand = runBridgeCommand,
  fileExists = (target) => fs.existsSync(target),
  isDirectory = (target) => fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() === true,
  closeEditors = closeAllEditors,
  saveSession = persistCurrentEditorSession,
  restoreSession = restoreSavedEditorSession,
  switchFolder = switchProjectFolder,
  acceptsPayload = () => true,
  log = writeLog,
} = {}) {
  const parsersByRoute = {
    "/open": parseOpenPayload,
    "/close-all": parseFolderPayload,
    "/restore": parseFolderPayload,
    "/command": parseCommandPayload,
    "/switch": parseSwitchPayload,
  };
  return async (req, res) => {
    if (req.method === "OPTIONS") {
      sendOptions(res);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, service: "paseo-bridge-worker", workerId });
      return;
    }
    const parsePayload = req.method === "POST" ? parsersByRoute[req.url] : undefined;
    if (!parsePayload) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    let parsed;
    try {
      parsed = parsePayload(await readBody(req));
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
    switch (req.url) {
      case "/close-all":
        await handleWorkerCloseAll({ res, parsed, closeEditors, saveSession, log });
        return;
      case "/restore":
        await handleWorkerRestore({ res, parsed, restoreSession, log });
        return;
      case "/command":
        log(`worker command ${parsed.command} folder=${parsed.folder}`);
        runCommand(parsed.command);
        sendJson(res, 200, { ok: true });
        return;
      case "/switch":
        await handleWorkerSwitch({ res, parsed, switchFolder, log });
        return;
      default:
        await handleWorkerOpen({
          res,
          parsed,
          deps: { openFile, openDiff, revealFolder, fileExists, isDirectory, saveSession },
          log,
        });
    }
  };
}

function workerAcceptsPayload(payload) {
  const registration = currentRegistration();
  if (payload.workspaceFile) {
    return (
      registration.workspaceFile !== null &&
      path.resolve(registration.workspaceFile) === path.resolve(payload.workspaceFile)
    );
  }
  const folders = registration.folders;
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
  const live = Array.from(registrations.values()).filter(
    (registration) => now - registration.lastSeen <= REGISTRATION_TTL_MS,
  );
  // A switch targets the window by its workspace file: the folder it is about
  // to show is not in any window yet.
  if (payload.workspaceFile) {
    return live
      .filter(
        (registration) =>
          registration.workspaceFile &&
          path.resolve(registration.workspaceFile) === path.resolve(payload.workspaceFile),
      )
      .sort((left, right) => right.startedAt - left.startedAt);
  }
  const scored = live.map((registration) => {
    const exactFolder =
      payload.folder &&
      registration.folders.some((folder) => path.resolve(folder) === path.resolve(payload.folder));
    const containsFile = registration.folders.some((folder) => pathIsInside(folder, payload.path));
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
    if (req.method === "POST" && req.url === "/broker/switch") {
      await handleBrokerOpen({
        req,
        res,
        registrations,
        now,
        forward,
        log,
        parsePayload: parseSwitchPayload,
        workerRoute: "/switch",
        action: "switch",
      });
      return;
    }
    if (req.method === "POST" && req.url === "/broker/command") {
      await handleBrokerOpen({
        req,
        res,
        registrations,
        now,
        forward,
        log,
        parsePayload: parseCommandPayload,
        workerRoute: "/command",
        action: "command",
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
    workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
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
  gitRevisionDisposable = vscode.workspace.registerFileSystemProvider(
    GIT_REVISION_SCHEME,
    createGitRevisionProvider(vscode),
    { isReadonly: true, isCaseSensitive: true },
  );
  sessionDisposables = [
    vscode.window.tabGroups.onDidChangeTabs(scheduleSessionPersistence),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleSessionPersistence),
    vscode.window.onDidChangeActiveTextEditor(scheduleSessionPersistence),
  ];
  context.subscriptions.push(
    vscode.commands.registerCommand("paseo.downloadFile", downloadFileToBrowser),
  );
  if (vscode.workspace.workspaceFile) {
    const project = currentWorkspaceFolder();
    if (project && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      void mirrorProjectSettings(project);
    }
    const watcher = vscode.workspace.createFileSystemWatcher("**/.vscode/settings.json");
    const remirror = (uri) => {
      const current = currentWorkspaceFolder();
      if (current && path.dirname(path.dirname(uri.fsPath)) === path.resolve(current)) {
        void mirrorProjectSettings(current);
      }
    };
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(remirror),
      watcher.onDidCreate(remirror),
      watcher.onDidDelete(remirror),
    );
  }
}

/**
 * Download for an editor tab (images included). VS Code only offers Download in
 * the Explorer context menu, and `explorer.download` takes no argument: it acts
 * on the Explorer selection. Revealing the file selects it first, which only
 * works for a file inside a workspace folder.
 */
async function downloadFileToBrowser(uri) {
  const vscode = require("vscode");
  const target = uri ?? vscode.window.tabGroups.activeTabGroup?.activeTab?.input?.uri;
  if (!target) {
    return;
  }
  if (!vscode.workspace.getWorkspaceFolder(target)) {
    void vscode.window.showInformationMessage(
      "Download... works for files inside the workspace. For this file, use Download in Paseo's Files sidebar.",
    );
    return;
  }
  await vscode.commands.executeCommand("revealInExplorer", target);
  await vscode.commands.executeCommand("explorer.download");
}

function deactivate() {
  clearInterval(heartbeatTimer);
  clearTimeout(registerSoonTimer);
  heartbeatTimer = null;
  registerSoonTimer = null;
  windowStateDisposable?.dispose();
  workspaceFoldersDisposable?.dispose();
  gitRevisionDisposable?.dispose();
  for (const disposable of sessionDisposables) {
    disposable.dispose();
  }
  sessionDisposables = [];
  windowStateDisposable = null;
  workspaceFoldersDisposable = null;
  gitRevisionDisposable = null;
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
  parseJsonc,
  resolveProjectFolderVariables,
  captureEditorSession,
  deactivate,
  hasDiffTab,
  parseOpenPayload,
  restoreEditorSession,
  selectBrokerTargets,
};
