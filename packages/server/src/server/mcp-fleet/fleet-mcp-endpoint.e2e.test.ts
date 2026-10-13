import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  CORE_FLEET_TOOL_NAMES,
  MCP_ONLY_FLEET_TOOL_NAMES,
  META_FLEET_TOOL_NAMES,
} from "./tool-search.js";

async function getAvailablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("Failed to acquire port")));
      return;
    }
    server.close(() => resolve(address.port));
  });
  return promise;
}

function extractFirstTextContent(result: { content: unknown[] }): string {
  const first = result.content[0];
  if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

describe("Fleet MCP Endpoint E2E (/mcp/fleet)", () => {
  test("authenticates remote clients, exposes core+meta tools, and executes tools", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-"));
    const port = await getAvailablePort();

    const validToken = "grok-secret-token-1234";
    const tokenHash = hashDaemonPassword(validToken);

    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [
              {
                name: "grok-bot",
                tokenHash,
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const url = `http://127.0.0.1:${port}/mcp/fleet`;

    try {
      // 1. Missing Authorization header -> 401
      const noAuthRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(noAuthRes.status).toBe(401);

      // 2. Wrong token -> 401
      const wrongAuthRes = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token-5678",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(wrongAuthRes.status).toBe(401);

      // 3. Non-POST -> 405
      const getRes = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(getRes.status).toBe(405);

      const deleteRes = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(deleteRes.status).toBe(405);

      // 4. Valid token -> MCP Client connects and tools/list works
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { Authorization: `Bearer ${validToken}` },
        },
      });
      const client = new Client({ name: "e2e-client", version: "1.0.0" });
      await client.connect(transport);

      const toolsList = await client.listTools();
      const registeredNames = toolsList.tools.map((t) => t.name);

      // tools/list contains exactly the core, meta and MCP-only tools that exist
      for (const meta of [...META_FLEET_TOOL_NAMES, ...MCP_ONLY_FLEET_TOOL_NAMES]) {
        expect(registeredNames).toContain(meta);
      }
      for (const tool of toolsList.tools) {
        const isKnown = (
          [
            ...CORE_FLEET_TOOL_NAMES,
            ...META_FLEET_TOOL_NAMES,
            ...MCP_ONLY_FLEET_TOOL_NAMES,
          ] as readonly string[]
        ).includes(tool.name);
        expect(isKnown).toBe(true);
      }

      // 5. paseo_skill returns the skill instructions
      const skillResult = await client.callTool({
        name: "paseo_skill",
        arguments: {},
      });
      expect(skillResult.isError).toBeFalsy();
      const skillText = extractFirstTextContent(skillResult);
      expect(skillText).toContain("# Paseo fleet");

      // 6. paseo_tool_search lexical fallback finds fleet_move_agent for 'move an agent to another host'
      const searchResult = await client.callTool({
        name: "paseo_tool_search",
        arguments: {
          query: "move an agent to another host",
        },
      });
      expect(searchResult.isError).toBeFalsy();
      const searchRawText = extractFirstTextContent(searchResult);
      const searchParsed = JSON.parse(searchRawText);
      const toolList = Array.isArray(searchParsed?.tools) ? searchParsed.tools : [];
      const foundMove = toolList.some((t: { name: string }) => t.name === "fleet_move_agent");
      expect(foundMove).toBe(true);

      // 7. paseo_tool_call executes a real catalog tool
      const callResult = await client.callTool({
        name: "paseo_tool_call",
        arguments: {
          name: "fleet_list_agents",
          arguments: {},
        },
      });
      expect(callResult.isError).toBeFalsy();

      await client.close();
    } finally {
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 45_000);

  test("a remote client spawns and prompts local agents directly, and waits see the newest run", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-spawn-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-spawn-"));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "paseo-work-fleet-spawn-"));
    const port = await getAvailablePort();
    const token = "grok-secret-token-spawn";
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
          },
        },
      }),
      "utf8",
    );
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const created = await client.callTool({
        name: "fleet_create_agent",
        arguments: {
          host: "local",
          cwd: workDir,
          isolation: "local",
          provider: "codex/gpt-5.4-mini",
          title: "bot worker",
          initialPrompt: "Respond with exactly: first",
        },
      });
      expect(created.isError).toBeFalsy();
      // A real agent id in the same call: the spawn never became a proposal.
      const agentId = created.structuredContent?.agentId;
      expect(agentId).toEqual(expect.any(String));

      const firstWait = await client.callTool({
        name: "fleet_wait_agent",
        arguments: { agentId, timeoutSeconds: 30 },
      });
      expect(firstWait.structuredContent).toMatchObject({ finished: true, lastMessage: "first" });

      const sent = await client.callTool({
        name: "fleet_send_prompt",
        arguments: { agentId, prompt: "Respond with exactly: second", mode: "queue" },
      });
      expect(sent.structuredContent).toMatchObject({ success: true });
      const secondWait = await client.callTool({
        name: "fleet_wait_agent",
        arguments: { agentId, timeoutSeconds: 30 },
      });
      // The fake provider's timeline joins consecutive assistant rows, so the
      // reply reads "firstsecond"; what matters is that the newest run is in it.
      expect(secondWait.structuredContent).toMatchObject({
        finished: true,
        lastMessage: expect.stringMatching(/second$/),
      });

      // No proposal was recorded, so nothing asked the user and nothing was
      // marked Commander-managed.
      const proposals = await readFile(
        path.join(paseoHome, "mission-control", "proposals.jsonl"),
        "utf8",
      ).catch(() => "");
      expect(proposals.trim()).toBe("");
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a remote client's agentMode applies to the created agent and to the prompt it sends with", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-mode-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-mode-"));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "paseo-work-fleet-mode-"));
    const port = await getAvailablePort();
    const token = "grok-secret-token-mode";
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
          },
        },
      }),
      "utf8",
    );
    // What the provider actually received, per prompt.
    const providerPrompts: string[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients({
          onStartTurn: (prompt) => {
            providerPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
          },
        }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      // The Commander-identity local path that used to drop settings.agentMode.
      const created = await client.callTool({
        name: "fleet_create_agent",
        arguments: {
          host: "local",
          cwd: workDir,
          isolation: "local",
          provider: "codex/gpt-5.4-mini",
          title: "research worker",
          initialPrompt: "Respond with exactly: first",
          settings: { agentMode: "research" },
        },
      });
      expect(created.isError).toBeFalsy();
      const agentId = created.structuredContent?.agentId as string;
      await client.callTool({
        name: "fleet_wait_agent",
        arguments: { agentId, timeoutSeconds: 30 },
      });
      expect(daemon.agentManager.getAgent(agentId)).toMatchObject({
        agentMode: "research",
        appliedAgentMode: "research",
      });
      expect(providerPrompts[0]).toMatch(
        /^<paseo-mode name="research">\n[\s\S]+\n\nRespond with exactly: first$/,
      );

      // A mode sent with a queued prompt rides that prompt, not the next one.
      const sent = await client.callTool({
        name: "fleet_send_prompt",
        arguments: {
          agentId,
          prompt: "Respond with exactly: second",
          mode: "queue",
          agentMode: "review",
        },
      });
      expect(sent.structuredContent).toMatchObject({ success: true });
      await client.callTool({
        name: "fleet_wait_agent",
        arguments: { agentId, timeoutSeconds: 30 },
      });
      expect(daemon.agentManager.getAgent(agentId)).toMatchObject({
        agentMode: "review",
        appliedAgentMode: "review",
      });
      expect(providerPrompts.at(-1)).toMatch(
        /^<paseo-mode name="review">\n[\s\S]+\n\nRespond with exactly: second$/,
      );
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("returns 404 when no remote clients are configured", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-empty-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-empty-"));
    const port = await getAvailablePort();

    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/fleet`, {
        method: "POST",
        headers: {
          Authorization: "Bearer any-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(res.status).toBe(404);
    } finally {
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("dynamically recognizes newly added remote client without daemon restart", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-reload-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-reload-"));
    const port = await getAvailablePort();

    // Start with empty clients
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const url = `http://127.0.0.1:${port}/mcp/fleet`;

    try {
      // Initially 404
      const initialRes = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer new-token" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(initialRes.status).toBe(404);

      // Now update config.json with a new client
      const newToken = "hot-reloaded-token-789";
      await writeFile(
        path.join(paseoHome, "config.json"),
        JSON.stringify({
          version: 1,
          daemon: {
            mcp: {
              enabled: true,
              remoteClients: [
                {
                  name: "dynamic-client",
                  tokenHash: hashDaemonPassword(newToken),
                },
              ],
            },
          },
        }),
        "utf8",
      );

      // Next request immediately succeeds without daemon restart!
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { Authorization: `Bearer ${newToken}` },
        },
      });
      const client = new Client({ name: "reloaded-client", version: "1.0.0" });
      await client.connect(transport);

      const toolsList = await client.listTools();
      expect(toolsList.tools.length).toBeGreaterThan(0);

      await client.close();
    } finally {
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
