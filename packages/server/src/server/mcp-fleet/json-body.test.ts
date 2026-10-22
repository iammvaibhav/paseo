import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpJsonBodyParser } from "./json-body.js";

let server: Server | null = null;

async function listen(limitBytes?: number): Promise<string> {
  const app = express();
  app.use("/mcp", createMcpJsonBodyParser(limitBytes));
  // The daemon's global parser runs after the MCP one and must not re-read the body.
  app.use(express.json());
  app.post("/mcp/fleet", (req, res) => {
    res.json({ bytes: JSON.stringify(req.body).length });
  });
  const { promise, resolve } = Promise.withResolvers<string>();
  server = app.listen(0, "127.0.0.1", () => {
    const address = server?.address();
    if (address && typeof address === "object") resolve(`http://127.0.0.1:${address.port}`);
  });
  return promise;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function rpcBody(payloadBytes: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "fleet_create_agent", arguments: { data: "A".repeat(payloadBytes) } },
  });
}

describe("MCP JSON body parser", () => {
  it("accepts an image-sized tool call well above the old 100kb express default", async () => {
    const base = await listen();
    const body = rpcBody(2 * 1024 * 1024);
    const res = await fetch(`${base}/mcp/fleet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ bytes: body.length });
  });

  it("answers an oversized body with a JSON-RPC 413 naming the limit and the upload tool", async () => {
    const base = await listen(64 * 1024);
    const res = await fetch(`${base}/mcp/fleet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpcBody(100 * 1024),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const json = z
      .object({ jsonrpc: z.string(), id: z.null(), error: z.object({ message: z.string() }) })
      .parse(await res.json());
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBeNull();
    expect(json.error.message).toMatch(/exceeds the 64 KB \/mcp request limit/);
    expect(json.error.message).toMatch(/fleet_upload_file/);
  });

  it("answers malformed JSON with a JSON-RPC parse error instead of an HTML page", async () => {
    const base = await listen();
    const res = await fetch(`${base}/mcp/fleet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const json = z.object({ error: z.object({ code: z.number() }) }).parse(await res.json());
    expect(json.error.code).toBe(-32700);
  });
});
