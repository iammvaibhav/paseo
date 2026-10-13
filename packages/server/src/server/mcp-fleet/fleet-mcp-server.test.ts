import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PaseoToolCatalog, PaseoToolDefinition } from "../agent/tools/types.js";
import type {
  ArmMcpFinishNotification,
  ArmMcpGroupNotification,
  ArmMcpStatusReportNotification,
} from "./finish-notifier.js";
import { createFleetMcpServer, FLEET_MCP_INSTRUCTIONS } from "./fleet-mcp-server.js";
import {
  CORE_FLEET_TOOL_NAMES,
  MCP_ONLY_FLEET_TOOL_NAMES,
  META_FLEET_TOOL_NAMES,
} from "./tool-search.js";
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
    const expectedTotal = [...expectedCore, ...META_FLEET_TOOL_NAMES, ...MCP_ONLY_FLEET_TOOL_NAMES];

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
    const armedGroups: ArmMcpGroupNotification[] = [];
    const armedStatusReports: ArmMcpStatusReportNotification[] = [];
    const tool = (
      name: string,
      handler: PaseoToolDefinition["handler"],
      schema?: Record<string, z.ZodTypeAny>,
    ): PaseoToolDefinition => ({
      name,
      description: name,
      inputSchema: schema ?? { host: z.string().optional(), agentId: z.string().optional() },
      handler,
    });
    const tools = new Map<string, PaseoToolDefinition>([
      [
        "fleet_create_agent",
        tool("fleet_create_agent", async (input) => {
          toolCalls.push(input as Record<string, unknown>);
          return {
            content: [],
            structuredContent: { agentId: "agent-9", status: "running", turnId: "turn-9" },
          };
        }),
      ],
      [
        "fleet_send_prompt",
        tool("fleet_send_prompt", async (input) => {
          toolCalls.push(input as Record<string, unknown>);
          return {
            content: [],
            structuredContent: { success: true, deliveryMode: "steer", turnId: "turn-10" },
          };
        }),
      ],
      [
        "fleet_agent_status",
        tool(
          "fleet_agent_status",
          async (input) => {
            const argObj =
              input && typeof input === "object" ? (input as Record<string, unknown>) : {};
            toolCalls.push(argObj);
            return {
              content: [],
              structuredContent: {
                running: { activeTurnId: "turn-live" },
                title: "Worker Agent",
                host: "local",
                requested: Boolean(argObj.notify),
                requestId: typeof argObj.requestId === "string" ? argObj.requestId : "req_test",
              },
            };
          },
          {
            host: z.string().optional(),
            agentId: z.string().optional(),
            fresh: z.boolean().optional(),
            notify: z.boolean().optional(),
            notifyContext: z.string().optional(),
            requestId: z.string().optional(),
          },
        ),
      ],
    ]);
    const catalog: PaseoToolCatalog = {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: (name, input, context) => tools.get(name)!.handler(input, context ?? {}),
    };
    const subscriptions = new Map<string, string | null>();
    return {
      toolCalls,
      armed,
      armedGroups,
      server: createFleetMcpServer({
        hostDependencies: createTestHostDependencies(),
        catalog,
        clientName: "grok-bot",
        finishNotifier: {
          arm: async (input) => {
            armed.push(input);
            subscriptions.set(`${input.client}/${input.agentId}`, input.context);
          },
          armGroup: async (input) => {
            armedGroups.push(input);
          },
          subscription: (client, agentId) => {
            const key = `${client}/${agentId}`;
            return subscriptions.has(key) ? { context: subscriptions.get(key) ?? null } : null;
          },
          unsubscribe: (client, agentId) => {
            subscriptions.delete(`${client}/${agentId}`);
          },
          restore: async () => ({ restored: 0, settled: Promise.resolve() }),
          suspend: async () => {},
          armStatusReport: (input) => {
            armedStatusReports.push(input);
          },
        },
        notifyTarget: options.withTarget ? { url: "https://hook.example/x" } : null,
      }),
      armedStatusReports,
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
      // Bound to the turn the create started, never an earlier run.
      turnId: "turn-9",
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

  test("a follow-up send to an agent the client watched arms by default until it opts out", async () => {
    const { armed, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    await client.callTool({
      name: "fleet_create_agent",
      arguments: { host: "local", notifyOnFinish: true, notifyContext: "essay-42" },
    });
    const followUp = await client.callTool({
      name: "fleet_send_prompt",
      arguments: { agentId: "agent-9" },
    });
    expect(followUp.structuredContent).toMatchObject({ notify: { armed: true, inherited: true } });
    expect(armed).toHaveLength(2);
    expect(armed[1]).toMatchObject({
      agentId: "agent-9",
      turnId: "turn-10",
      tool: "fleet_send_prompt",
      // The create's context carries over, so the client can route the event.
      context: "essay-42",
    });

    const optOut = await client.callTool({
      name: "fleet_send_prompt",
      arguments: { agentId: "agent-9", notifyOnFinish: false },
    });
    expect(optOut.structuredContent).not.toHaveProperty("notify");
    await client.callTool({ name: "fleet_send_prompt", arguments: { agentId: "agent-9" } });
    expect(armed).toHaveLength(2);
    await close();
  });

  test("a send to an agent the client never watched does not arm", async () => {
    const { armed, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    await client.callTool({ name: "fleet_send_prompt", arguments: { agentId: "agent-9" } });
    expect(armed).toEqual([]);
    await close();
  });

  test("an undeclared argument is an error naming the closest real one; the tool never runs", async () => {
    const { toolCalls, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const direct = await client.callTool({
      name: "fleet_create_agent",
      arguments: { host: "local", hots: "typo" },
    });
    expect(direct.isError).toBe(true);
    expect(extractFirstTextContent(direct as { content: unknown[] })).toContain(
      '"hots" (did you mean "host"?)',
    );
    const viaCall = await client.callTool({
      name: "paseo_tool_call",
      arguments: { name: "fleet_create_agent", arguments: { agentIdentifier: "x" } },
    });
    expect(extractFirstTextContent(viaCall as { content: unknown[] })).toContain(
      'did you mean "agentId"?',
    );
    expect(toolCalls).toEqual([]);
    await close();
  });

  test("fleet_notify_on_finish arms one group bound to each agent's turn", async () => {
    const { armed, armedGroups, server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "fleet_notify_on_finish",
      arguments: {
        agents: [{ agentId: "a", turnId: "turn-a" }, { agentId: "b" }],
        group: true,
        perAgent: false,
        notifyContext: "batch",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(armed).toEqual([]);
    expect(armedGroups).toHaveLength(1);
    expect(armedGroups[0]).toMatchObject({
      perAgent: false,
      context: "batch",
      agents: [
        { agentId: "a", turnId: "turn-a" },
        // No turnId given: bound to the run in progress at arm time.
        { agentId: "b", turnId: "turn-live" },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      groupId: armedGroups[0]!.groupId,
      armed: [
        { agentId: "a", turnId: "turn-a" },
        { agentId: "b", turnId: "turn-live" },
      ],
    });
    await close();
  });

  test("fleet_agent_status with notify: true rejects when fresh is false", async () => {
    const { server } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "fleet_agent_status",
      arguments: { agentId: "agent-1", notify: true, fresh: false },
    });
    expect(result.isError).toBe(true);
    const firstBlock = result.content[0];
    const blockText =
      firstBlock &&
      typeof firstBlock === "object" &&
      "text" in firstBlock &&
      typeof firstBlock.text === "string"
        ? firstBlock.text
        : "";
    expect(blockText).toContain("notify: true is only valid when fresh: true");
    await close();
  });

  test("fleet_agent_status with notify: true rejects when webhook target is missing", async () => {
    const { server } = setup({ withTarget: false });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "fleet_agent_status",
      arguments: { agentId: "agent-1", notify: true, fresh: true },
    });
    expect(result.isError).toBe(true);
    const firstBlock = result.content[0];
    const blockText =
      firstBlock &&
      typeof firstBlock === "object" &&
      "text" in firstBlock &&
      typeof firstBlock.text === "string"
        ? firstBlock.text
        : "";
    expect(blockText).toContain("notify: true needs a webhook for this MCP client");
    await close();
  });

  test("fleet_agent_status with notify: true arms armStatusReport and returns immediately", async () => {
    const { server, armedStatusReports, toolCalls } = setup({ withTarget: true });
    const { client, close } = await connect(server);
    const result = await client.callTool({
      name: "fleet_agent_status",
      arguments: { agentId: "agent-1", notify: true, fresh: true, notifyContext: "status-tag" },
    });
    expect(result.isError).toBeFalsy();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ agentId: "agent-1", fresh: true, notify: true });
    expect(armedStatusReports).toHaveLength(1);
    expect(armedStatusReports[0]).toMatchObject({
      client: "grok-bot",
      agentId: "agent-1",
      context: "status-tag",
    });
    await close();
  });
});
