import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
