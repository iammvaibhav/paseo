// x-search: MCP server (Streamable HTTP, stateless) exposing read-only X
// (Twitter) tools backed by Grok's x_search. See ../README.md.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import pkg from "../package.json";
import { registerTools } from "./tools";

const token = process.env.X_SEARCH_TOKEN ?? "";
if (token.length < 32) {
  console.error(
    "x-search: set X_SEARCH_TOKEN (at least 32 characters); /mcp requires it as a Bearer token.",
  );
  process.exit(1);
}
const expected = Buffer.from(`Bearer ${token}`);
const [hostname, port] = (process.env.X_SEARCH_BIND ?? "127.0.0.1:8792").split(/:(?=\d+$)/);

function authorized(request: Request): boolean {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = Bun.serve({
  hostname,
  port: Number(port),
  // Grok runs several X searches per call; Bun's default 10 s idle timeout
  // would drop the connection mid-call.
  idleTimeout: 255,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return Response.json({ ok: true, version: pkg.version });
    if (pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!authorized(request)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
    // Stateless: a fresh server and transport per request, no session ids.
    const mcp = new McpServer({ name: "x-search", title: "X search", version: pkg.version });
    registerTools(mcp);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    const started = Date.now();
    const response = await transport.handleRequest(request);
    console.log(`[x-search] ${request.method} /mcp ${response.status} ${Date.now() - started}ms`);
    return response;
  },
});

console.log(`x-search ${pkg.version} listening on http://${server.hostname}:${server.port}/mcp`);
