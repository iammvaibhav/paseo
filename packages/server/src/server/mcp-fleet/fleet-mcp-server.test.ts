import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PaseoToolCatalog, PaseoToolDefinition } from "../agent/tools/types.js";
import type { ArmMcpFinishNotification } from "./finish-notifier.js";
import { createFleetMcpServer, FLEET_MCP_INSTRUCTIONS } from "./fleet-mcp-server.js";
import { CORE_FLEET_TOOL_NAMES, META_FLEET_TOOL_NAMES } from "./tool-search.js";
import type { PaseoToolHostDependencies } from "../agent/tools/paseo-tools.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";

function createTestHostDependencies(): PaseoToolHostDependencies {
  return {
    agentManager: {
      listAgents: () => [],
      getAgent: () => undefined,
      getPaseoToolPolicy: () => undefined,
      getRegisteredProviderIds: () => [],
    } as unknown as AgentManager,
    agentStorage: {
      get: async () => null,
      list: async () => [],
    } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    logger: createTestLogger(),
  };
}

function extractFirstTextContent(result: { content: unknown[] }): string {
  const first = result.content[0];
  if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

describe("createFleetMcpServer", () => {
  test("creates server with instructions and expected tool registrations", async () => {
    const hostDeps = createTestHostDependencies();
    const server = await createFleetMcpServer({ hostDependencies: hostDeps });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toBe(FLEET_MCP_INSTRUCTIONS);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    // Catalog tools that exist in this stub hostDeps
    const catalog = await createPaseoToolCatalog(hostDeps);
    const expectedCore = CORE_FLEET_TOOL_NAMES.filter((name) => catalog.tools.has(name));
    const expectedTotal = [...expectedCore, ...META_FLEET_TOOL_NAMES];

    expect(toolNames.sort()).toEqual(expectedTotal.sort());

    await client.close();
    await server.close();
  });

  test("paseo_tool_call executes a real catalog tool", async () => {
    const hostDeps = createTestHostDependencies();
    const server = await createFleetMcpServer({ hostDependencies: hostDeps });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "paseo_tool_call",
      arguments: {
        name: "list_agents",
        arguments: {},
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();

    await client.close();
    await server.close();
  });

  test("paseo_tool_call returns error with hint when tool name is unknown", async () => {
    const hostDeps = createTestHostDependencies();
    const server = await createFleetMcpServer({ hostDependencies: hostDeps });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "paseo_tool_call",
      arguments: {
        name: "nonexistent_tool_xyz",
        arguments: {},
      },
    });

    expect(result.isError).toBe(true);
    expect(extractFirstTextContent(result)).toContain("paseo_tool_search");

    await client.close();
    await server.close();
  });

  test("paseo_skill returns the skill document", async () => {
    const hostDeps = createTestHostDependencies();
    const server = await createFleetMcpServer({ hostDependencies: hostDeps });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "paseo_skill",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(extractFirstTextContent(result)).toContain("# Paseo fleet");

    await client.close();
    await server.close();
  });
});

describe("notifyOnFinish for MCP clients", () => {
  // A two-tool catalog: the wrapper's behavior does not depend on the rest.
  function setup(options: { withTarget: boolean }) {
    const toolCalls: Array<Record<string, unknown>> = [];
    const armed: ArmMcpFinishNotification[] = [];
    const tool = (name: string, handler: PaseoToolDefinition["handler"]): PaseoToolDefinition => ({
      name,
      description: name,
      inputSchema: z.object({ host: z.string().optional() }).passthrough(),
      handler,
    });
    const tools = new Map<string, PaseoToolDefinition>([
      [
        "fleet_create_agent",
        tool("fleet_create_agent", async (input) => {
          toolCalls.push(input as Record<string, unknown>);
          return { content: [], structuredContent: { agentId: "agent-9", status: "running" } };
        }),
      ],
    ]);
    const catalog: PaseoToolCatalog = {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: (name, input, context) => tools.get(name)!.handler(input, context ?? {}),
    };
    return {
      toolCalls,
      armed,
      server: createFleetMcpServer({
        hostDependencies: createTestHostDependencies(),
        catalog,
        clientName: "grok-bot",
        finishNotifier: {
          arm: async (input) => {
            armed.push(input);
          },
        },
        notifyTarget: options.withTarget ? { url: "https://hook.example/x" } : null,
      }),
    };
  }

  async function connect(serverPromise: Promise<McpServer>) {
    const server = await serverPromise;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => (await client.close(), await server.close()) };
  }

  test("arms the client's webhook with the context and hides the notify args from the tool", async () => {
    const { toolCalls, armed, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "fleet_create_agent",
      arguments: { host: "blrofc3", notifyOnFinish: true, notifyContext: "essay-42" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ agentId: "agent-9", notify: { armed: true } });
    expect(toolCalls).toEqual([{ host: "blrofc3", notifyOnFinish: false }]);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      client: "grok-bot",
      agentId: "agent-9",
      host: "blrofc3",
      tool: "fleet_create_agent",
      context: "essay-42",
      target: { url: "https://hook.example/x" },
    });
    await close();
  });

  test("refuses notifyOnFinish without a webhook, before running the tool", async () => {
    const { toolCalls, armed, server } = setup({ withTarget: false });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "paseo_tool_call",
      arguments: { name: "fleet_create_agent", arguments: { notifyOnFinish: true } },
    });
    expect(result.isError).toBe(true);
    expect(extractFirstTextContent(result as { content: unknown[] })).toContain("fleet_wait_agent");
    expect(toolCalls).toEqual([]);
    expect(armed).toEqual([]);
    await close();
  });

  test("rejects a notifyContext over the limit", async () => {
    const { toolCalls, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "paseo_tool_call",
      arguments: {
        name: "fleet_create_agent",
        arguments: { notifyOnFinish: true, notifyContext: "x".repeat(2001) },
      },
    });
    expect(result.isError).toBe(true);
    expect(toolCalls).toEqual([]);
    await close();
  });

  test("a call without notifyOnFinish never arms", async () => {
    const { armed, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    await client.callTool({ name: "fleet_create_agent", arguments: { host: "local" } });
    expect(armed).toEqual([]);
    await close();
  });
});
