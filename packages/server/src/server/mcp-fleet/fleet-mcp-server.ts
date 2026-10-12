import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { addModelVisibleStructuredContent } from "../agent/tools/paseo-tool-serialization.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "../agent/tools/paseo-tools.js";
import type { PaseoToolResult } from "../agent/tools/types.js";
import { CORE_FLEET_TOOL_NAMES, resolveTypeSafeApiKey, searchCatalogTools } from "./tool-search.js";
import { loadFleetSkillText } from "./skill.js";

export const FLEET_MCP_INSTRUCTIONS =
  "You control the whole Paseo fleet across all peered hosts. " +
  "Core tools are listed directly; call paseo_tool_search to discover any other catalog tool, and call paseo_tool_call to execute it. " +
  "Call paseo_skill before using the paseo CLI for host-local work.";

export interface FleetMcpServerOptions {
  hostDependencies: PaseoToolHostDependencies;
  clientName?: string;
  explicitSkillPath?: string | null;
}

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createFleetMcpServer(options: FleetMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options.hostDependencies);
  const server = new McpServer(
    {
      name: "paseo-fleet",
      version: "2.0.0",
    },
    {
      instructions: FLEET_MCP_INSTRUCTIONS,
    },
  );

  for (const toolName of CORE_FLEET_TOOL_NAMES) {
    const tool = catalog.getTool(toolName);
    if (!tool) {
      continue;
    }
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  server.registerTool(
    "paseo_tool_search",
    {
      title: "Search Paseo tools",
      description:
        "Search non-core Paseo catalog tools by intent or keywords. Returns tool names, descriptions, and input schemas.",
      inputSchema: {
        query: z.string().describe("What you want to do (e.g. 'move an agent to another host')"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of tools to return (default 12)"),
      },
    },
    async (args: { query: string; limit?: number }, context?: McpToolContext) => {
      const typesafeApiKey = await resolveTypeSafeApiKey({
        missionControlService: options.hostDependencies.missionControlService,
      });
      const tools = await searchCatalogTools({
        catalog,
        query: args.query,
        limit: args.limit,
        typesafeApiKey,
        signal: context?.signal,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tools }, null, 2),
          },
        ],
        structuredContent: { tools },
      };
    },
  );

  server.registerTool(
    "paseo_tool_call",
    {
      title: "Call a Paseo tool",
      description:
        "Execute any Paseo catalog tool by name with arguments. The tool validates its own input.",
      inputSchema: {
        name: z.string().describe("The name of the catalog tool to run"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments object to pass to the tool"),
      },
    },
    async (
      args: { name: string; arguments?: Record<string, unknown> },
      context?: McpToolContext,
    ) => {
      const tool = catalog.getTool(args.name);
      if (!tool) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool "${args.name}" is not registered in the catalog. Use paseo_tool_search to find available tools.`,
            },
          ],
        };
      }
      const result = await catalog.executeTool(args.name, args.arguments ?? {}, {
        signal: context?.signal,
      });
      return toMcpToolResult(result);
    },
  );

  server.registerTool(
    "paseo_skill",
    {
      title: "Paseo fleet skill",
      description:
        "Retrieve guidance on how to control the whole Paseo fleet, recommended core tools, and CLI commands for host-local work.",
    },
    async () => {
      const text = loadFleetSkillText(options.explicitSkillPath);
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    },
  );

  return server;
}
