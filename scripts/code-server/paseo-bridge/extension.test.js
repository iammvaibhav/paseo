// Run with: node --test scripts/code-server/paseo-bridge/extension.test.js
const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { createRequestHandler, parseOpenPayload } = require("./extension.js");

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

test("unknown route returns 404", async () => {
  const handler = createRequestHandler({ openFile: async () => {} });
  const res = await runHandler(handler, mockReq({ method: "GET", url: "/nope" }));
  assert.equal(res.status, 404);
});
