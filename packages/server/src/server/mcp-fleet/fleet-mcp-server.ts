import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  addModelVisibleStructuredContent,
  serializePaseoToolInputParameters,
} from "../agent/tools/paseo-tool-serialization.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "../agent/tools/paseo-tools.js";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-control-tools.js";
import type { PaseoToolCatalog, PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import {
  MAX_NOTIFY_CONTEXT_LENGTH,
  type McpFinishNotifier,
  type McpNotifyTarget,
} from "./finish-notifier.js";
import { CORE_FLEET_TOOL_NAMES, resolveTypeSafeApiKey, searchCatalogTools } from "./tool-search.js";
import { loadFleetSkillText } from "./skill.js";

export const FLEET_MCP_INSTRUCTIONS =
  "You control the whole Paseo fleet across all peered hosts. " +
  "Core tools are listed directly; call paseo_tool_search to discover any other catalog tool, and call paseo_tool_call to execute it. " +
  "Call paseo_skill before using the paseo CLI for host-local work.";

export interface FleetMcpServerOptions {
  hostDependencies: PaseoToolHostDependencies;
  /** A catalog built earlier from the same hostDependencies; skips rebuilding it per request. */
  catalog?: PaseoToolCatalog;
  clientName?: string;
  explicitSkillPath?: string | null;
  /** Delivers notifyOnFinish to the client's webhook; absent → notifyOnFinish is refused. */
  finishNotifier?: McpFinishNotifier;
  notifyTarget?: McpNotifyTarget | null;
}

// Tools that start or prompt an agent. On /mcp/fleet their notifyOnFinish
// means "POST to my webhook", never the catalog's agent-thread notification:
// the MCP principal runs as the Commander, so that would wake the Commander.
const NOTIFY_TOOLS = new Set([
  "fleet_create_agent",
  "fleet_send_prompt",
  "create_agent",
  "send_agent_prompt",
]);
const CREATE_TOOLS = new Set(["fleet_create_agent", "create_agent"]);
// Tools whose own schema has notifyOnFinish; it is forced off before they run.
const CATALOG_NOTIFY_TOOLS = new Set(["fleet_create_agent", "create_agent", "send_agent_prompt"]);
const WAIT_TOOL_MAX_SECONDS = 1800;

const NOTIFY_INPUT_SHAPE = {
  notifyOnFinish: z
    .boolean()
    .optional()
    .describe(
      "POST a paseo.agent.finished event to your configured webhook when this agent's run ends " +
        "(and paseo.agent.needs_permission if it blocks on a permission). Returns immediately.",
    ),
  notifyContext: z
    .string()
    .max(MAX_NOTIFY_CONTEXT_LENGTH)
    .optional()
    .describe("Free-form tag echoed back verbatim as `context` in the webhook payload."),
};

// Parsed off the tool arguments before the catalog tool runs.
const NotifyArgsSchema = z.object(NOTIFY_INPUT_SHAPE);

function withNotifyInput(schema: PaseoToolConfig["inputSchema"]): PaseoToolConfig["inputSchema"] {
  if (schema instanceof z.ZodObject) return schema.extend(NOTIFY_INPUT_SHAPE);
  if (schema === undefined || schema instanceof z.ZodType) return schema;
  return { ...schema, ...NOTIFY_INPUT_SHAPE };
}

function errorResult(text: string): PaseoToolResult {
  return { isError: true, content: [{ type: "text", text }] };
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
  const catalog = options.catalog ?? (await createPaseoToolCatalog(options.hostDependencies));
  const server = new McpServer(
    {
      name: "paseo-fleet",
      version: "2.0.0",
    },
    {
      instructions: FLEET_MCP_INSTRUCTIONS,
    },
  );

  const waitForAgent = async (input: {
    agentId: string;
    host?: string;
    timeoutMs: number;
  }): Promise<FleetAgentWaitResult> => {
    const result = await catalog.executeTool("fleet_wait_agent", {
      agentId: input.agentId,
      ...(input.host ? { host: input.host } : {}),
      timeoutSeconds: Math.max(
        1,
        Math.min(WAIT_TOOL_MAX_SECONDS, Math.ceil(input.timeoutMs / 1000)),
      ),
    });
    if (result.isError) {
      throw new Error(result.content.map((block) => block.text ?? "").join(" ") || "wait failed");
    }
    return result.structuredContent as FleetAgentWaitResult;
  };

  // Runs a catalog tool for this MCP client. For the agent start/prompt tools
  // it takes notifyOnFinish/notifyContext off the arguments and, after the
  // tool succeeds, arms the client's webhook instead.
  const runCatalogTool = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PaseoToolResult> => {
    if (!NOTIFY_TOOLS.has(name)) return catalog.executeTool(name, args, { signal });
    const { notifyOnFinish: _notify, notifyContext: _context, ...toolArgs } = args;
    const notify = NotifyArgsSchema.safeParse(args);
    if (!notify.success) {
      return errorResult(
        `Invalid notify arguments: ${notify.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const wantsNotify = notify.data.notifyOnFinish === true;
    if (wantsNotify && (!options.finishNotifier || !options.notifyTarget || !options.clientName)) {
      return errorResult(
        "notifyOnFinish needs a webhook for this MCP client (daemon.mcp.remoteClients[].notify), and none is configured. " +
          "Call again without notifyOnFinish and use fleet_wait_agent instead.",
      );
    }
    if (CATALOG_NOTIFY_TOOLS.has(name)) toolArgs.notifyOnFinish = false;
    const result = await catalog.executeTool(name, toolArgs, { signal });
    if (!wantsNotify || result.isError) return result;

    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const agentId = CREATE_TOOLS.has(name) ? structured.agentId : toolArgs.agentId;
    if (typeof agentId !== "string" || !agentId) {
      return {
        ...result,
        structuredContent: {
          ...structured,
          notify: { armed: false },
          guidance:
            "notifyOnFinish was not armed: no agent was started (the request may be pending approval).",
        },
      };
    }
    const host = typeof toolArgs.host === "string" ? toolArgs.host : undefined;
    void options.finishNotifier!.arm({
      client: options.clientName!,
      target: options.notifyTarget!,
      agentId,
      ...(host ? { host } : {}),
      tool: name,
      context: notify.data.notifyContext ?? null,
      waitForAgent,
    });
    return {
      ...result,
      structuredContent: {
        ...structured,
        notify: { armed: true },
        guidance:
          "Paseo will POST paseo.agent.finished to your webhook when this run ends. Do not poll for it.",
      },
    };
  };

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
        inputSchema: NOTIFY_TOOLS.has(tool.name)
          ? withNotifyInput(tool.inputSchema)
          : tool.inputSchema,
      },
      async (args: Record<string, unknown>, context?: McpToolContext) =>
        toMcpToolResult(await runCatalogTool(tool.name, args, context?.signal)),
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
      // Show the webhook arguments on the tools that take them here too.
      for (const item of tools) {
        const tool = catalog.getTool(item.name);
        if (!tool || !NOTIFY_TOOLS.has(item.name)) continue;
        item.inputSchema = serializePaseoToolInputParameters({
          ...tool,
          inputSchema: withNotifyInput(tool.inputSchema),
        });
      }
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
      const result = await runCatalogTool(args.name, args.arguments ?? {}, context?.signal);
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
