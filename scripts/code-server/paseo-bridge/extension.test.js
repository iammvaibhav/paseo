// Run with: node --test scripts/code-server/paseo-bridge/extension.test.js
const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const {
  captureEditorSession,
  createBrokerHandler,
  createRequestHandler,
  parseOpenPayload,
  restoreEditorSession,
  selectBrokerTargets,
} = require("./extension.js");

function mockReq({ method, url, body }) {
  const req = Readable.from(body != null ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  return req;
}

function runHandler(handler, req) {
  return new Promise((resolve) => {
    let settled = false;
    const res = {
      status: 0,
      headers: null,
      body: "",
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) {
          this.body = String(chunk);
        }
        if (!settled) {
          settled = true;
          resolve(this);
        }
      },
    };
    handler(req, res);
  });
}

test("parseOpenPayload normalizes fields", () => {
  assert.deepEqual(parseOpenPayload(JSON.stringify({ path: "/a", line: 3, column: 2 })), {
    path: "/a",
    line: 3,
    column: 2,
  });
  assert.equal(parseOpenPayload("{}").error, "missing path");
  assert.equal(parseOpenPayload("not json").error, "invalid json");
  assert.equal(parseOpenPayload(JSON.stringify({ path: "/a", line: 0 })).line, null);
});

test("GET /health returns ok", async () => {
  const handler = createRequestHandler({ openFile: async () => {} });
  const res = await runHandler(handler, mockReq({ method: "GET", url: "/health" }));
  assert.equal(res.status, 200);
  assert.match(res.body, /paseo-bridge/);
});

test("POST /open calls openFile with parsed args", async () => {
  const calls = [];
  const handler = createRequestHandler({
    openFile: async (path, line, column) => {
      calls.push([path, line, column]);
    },
  });
  const res = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/open",
      body: JSON.stringify({ path: "/repo/a.ts", line: 5, column: 1 }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [["/repo/a.ts", 5, 1]]);
});

test("POST /open with a missing path returns 400 and does not open", async () => {
  let called = false;
  const handler = createRequestHandler({
    openFile: async () => {
      called = true;
    },
  });
  const res = await runHandler(
    handler,
    mockReq({ method: "POST", url: "/open", body: JSON.stringify({}) }),
  );
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test("POST /close-all closes every editor in the worker window", async () => {
  let called = false;
  const savedFolders = [];
  const handler = createRequestHandler({
    closeEditors: async () => {
      called = true;
    },
    saveSession: async (folder) => savedFolders.push(folder),
  });
  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/close-all",
      body: JSON.stringify({ folder: "/repo" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.deepEqual(savedFolders, ["/repo"]);
});

test("captureEditorSession records file order, groups, and the globally active tab", () => {
  const first = { input: { uri: { fsPath: "/repo/a.ts" } } };
  const second = { input: { uri: { fsPath: "/repo/b.ts" } } };
  const ignored = { input: {} };
  const session = captureEditorSession({
    window: {
      tabGroups: {
        activeTabGroup: { activeTab: second },
        all: [
          { viewColumn: 1, tabs: [first, ignored] },
          { viewColumn: 2, tabs: [second] },
        ],
      },
    },
  });

  assert.deepEqual(session, {
    version: 1,
    files: [
      { path: "/repo/a.ts", viewColumn: 1, active: false },
      { path: "/repo/b.ts", viewColumn: 2, active: true },
    ],
  });
});

test("restoreEditorSession closes stale editors and focuses the saved active file last", async () => {
  const calls = [];
  const vscode = {
    Uri: { file: (filePath) => ({ fsPath: filePath }) },
    commands: {
      executeCommand: async (command) => calls.push(["command", command]),
    },
    window: {
      showTextDocument: async (uri, options) => calls.push(["open", uri.fsPath, options]),
    },
  };

  const result = await restoreEditorSession(
    {
      files: [
        { path: "/repo/active.ts", viewColumn: 1, active: true },
        { path: "/repo/other.ts", viewColumn: 2, active: false },
      ],
    },
    vscode,
  );

  assert.deepEqual(result, { restored: 2, failed: 0 });
  assert.equal(calls[0][1], "workbench.action.closeAllEditors");
  assert.equal(calls[1][1], "/repo/other.ts");
  assert.equal(calls[1][2].preserveFocus, true);
  assert.equal(calls[2][1], "/repo/active.ts");
  assert.equal(calls[2][2].preserveFocus, false);
});

test("POST /restore restores the saved session for the worker folder", async () => {
  const folders = [];
  const handler = createRequestHandler({
    restoreSession: async (folder) => {
      folders.push(folder);
      return { found: true, restored: 2, failed: 0 };
    },
  });
  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/restore",
      body: JSON.stringify({ folder: "/repo" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(folders, ["/repo"]);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    found: true,
    restored: 2,
    failed: 0,
  });
});

test("unknown route returns 404", async () => {
  const handler = createRequestHandler({ openFile: async () => {} });
  const res = await runHandler(handler, mockReq({ method: "GET", url: "/nope" }));
  assert.equal(res.status, 404);
});

test("broker prefers the newest worker for the page's exact workspace folder", () => {
  const now = 10_000;
  const registrations = new Map([
    [
      "old-hidden",
      {
        id: "old-hidden",
        port: 9001,
        folders: ["/repo/old"],
        focused: true,
        startedAt: 100,
        lastSeen: now,
      },
    ],
    [
      "current",
      {
        id: "current",
        port: 9002,
        folders: ["/repo/current"],
        focused: false,
        startedAt: 200,
        lastSeen: now,
      },
    ],
    [
      "stale-same-folder",
      {
        id: "stale-same-folder",
        port: 9003,
        folders: ["/repo/current"],
        focused: false,
        startedAt: 150,
        lastSeen: now,
      },
    ],
  ]);

  const targets = selectBrokerTargets(
    registrations,
    { path: "/outside/file.ts", folder: "/repo/current" },
    now,
  );

  assert.equal(targets[0].id, "current");
  assert.equal(targets[1].id, "stale-same-folder");
  assert.equal(targets.length, 2);
});

test("broker drops expired workers and uses file containment without a folder hint", () => {
  const now = 20_000;
  const registrations = new Map([
    [
      "expired",
      {
        id: "expired",
        port: 9001,
        folders: ["/repo"],
        focused: true,
        startedAt: 300,
        lastSeen: 1,
      },
    ],
    [
      "matching",
      {
        id: "matching",
        port: 9002,
        folders: ["/repo"],
        focused: false,
        startedAt: 100,
        lastSeen: now,
      },
    ],
  ]);

  const targets = selectBrokerTargets(registrations, { path: "/repo/src/file.ts" }, now);

  assert.deepEqual(
    targets.map((target) => target.id),
    ["matching"],
  );
});

test("broker forwards its dedicated open route to the matching worker", async () => {
  const calls = [];
  const registrations = new Map([
    [
      "current",
      {
        id: "current",
        port: 9002,
        folders: ["/repo/current"],
        focused: false,
        startedAt: 200,
        sequence: 1,
        lastSeen: 10_000,
      },
    ],
  ]);
  const handler = createBrokerHandler({
    registrations,
    now: () => 10_000,
    forward: async (input) => {
      calls.push(input);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    },
  });

  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/broker/open",
      body: JSON.stringify({
        path: "/outside/file.ts",
        folder: "/repo/current",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, 9002);
});

test("broker does not expose the legacy fixed-port open route", async () => {
  const handler = createBrokerHandler();
  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/open",
      body: JSON.stringify({ path: "/repo/file.ts", folder: "/repo" }),
    }),
  );

  assert.equal(response.status, 404);
});

test("broker routes close-all to the matching worker", async () => {
  const calls = [];
  const registrations = new Map([
    [
      "current",
      {
        id: "current",
        port: 9002,
        folders: ["/repo/current"],
        focused: false,
        startedAt: 200,
        sequence: 1,
        lastSeen: 10_000,
      },
    ],
  ]);
  const handler = createBrokerHandler({
    registrations,
    now: () => 10_000,
    forward: async (input) => {
      calls.push(input);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    },
  });
  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/broker/close-all",
      body: JSON.stringify({ folder: "/repo/current" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "/close-all");
});

test("broker routes restore to the matching worker", async () => {
  const calls = [];
  const registrations = new Map([
    [
      "current",
      {
        id: "current",
        port: 9002,
        folders: ["/repo/current"],
        focused: false,
        startedAt: 200,
        sequence: 1,
        lastSeen: 10_000,
      },
    ],
  ]);
  const handler = createBrokerHandler({
    registrations,
    now: () => 10_000,
    forward: async (input) => {
      calls.push(input);
      return { status: 200, body: JSON.stringify({ ok: true, restored: 2 }) };
    },
  });
  const response = await runHandler(
    handler,
    mockReq({
      method: "POST",
      url: "/broker/restore",
      body: JSON.stringify({ folder: "/repo/current" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "/restore");
});
