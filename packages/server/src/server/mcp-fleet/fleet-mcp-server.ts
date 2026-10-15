import { randomUUID } from "node:crypto";
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
import { FLEET_WAIT_RESULT_SCHEMA } from "../agent/tools/fleet-wait.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolResult,
} from "../agent/tools/types.js";
import {
  MAX_NOTIFY_CONTEXT_LENGTH,
  type McpFinishNotifier,
  type McpFinishWaitForAgent,
  type McpNotifyAgent,
  type McpNotifyTarget,
} from "./finish-notifier.js";
import { loadFleetSkillText } from "./skill.js";

export const FLEET_MCP_INSTRUCTIONS =
  "You control the whole Paseo fleet across all peered hosts. Every Paseo tool is listed directly. " +
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
        "(and paseo.agent.needs_permission if it blocks on a permission). Returns immediately. " +
        "Once you arm it for an agent, later fleet_send_prompt calls to that agent arm it by default " +
        "(reusing your last notifyContext); pass false on a send to stop. " +
        "The watch survives a daemon restart: it reports the run the restarted daemon resumes, or " +
        'reason "interrupted" when the run never resumes. If the agent\'s host restarts mid-run you ' +
        "first get a non-final paseo.agent.interrupted event (final: false), then paseo.agent.finished " +
        "for the run the host resumes.",
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

/** A tool's input as one object schema; null when it is not an object (unions, effects). */
function inputObjectSchema(tool: PaseoToolDefinition): z.ZodObject | null {
  const schema = tool.inputSchema;
  if (schema === undefined) return z.object({});
  if (schema instanceof z.ZodObject) return schema;
  if (schema instanceof z.ZodType) return null;
  return z.object(schema);
}

function mcpInputObject(tool: PaseoToolDefinition): PaseoToolConfig["inputSchema"] {
  const object = inputObjectSchema(tool);
  if (!object) {
    return NOTIFY_TOOLS.has(tool.name) ? withNotifyInput(tool.inputSchema) : tool.inputSchema;
  }
  return (NOTIFY_TOOLS.has(tool.name) ? object.extend(NOTIFY_INPUT_SHAPE) : object).loose();
}

/** Edit distance, for suggesting the argument a client meant. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function closestArgName(key: string, known: readonly string[]): string | null {
  const lower = key.toLowerCase();
  const contained = known.find(
    (name) => lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower),
  );
  if (contained) return contained;
  const ranked = known
    .map((name) => ({ name, distance: editDistance(lower, name.toLowerCase()) }))
    .sort((left, right) => left.distance - right.distance)[0];
  return ranked && ranked.distance <= Math.max(2, Math.floor(key.length / 3)) ? ranked.name : null;
}

/**
 * Unknown arguments are an error on /mcp/fleet: silently dropping one (a
 * misnamed delivery mode) runs the call with defaults the client never chose.
 */
function describeUnknownArgKeys(
  toolName: string,
  known: readonly string[],
  args: Record<string, unknown>,
): string | null {
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  const named = unknown.map((key) => {
    const suggestion = closestArgName(key, known);
    return suggestion ? `"${key}" (did you mean "${suggestion}"?)` : `"${key}"`;
  });
  return `${toolName} has no argument ${named.join(", ")}. Valid arguments: ${known.join(", ")}.`;
}

function describeUnknownArgs(
  tool: PaseoToolDefinition,
  args: Record<string, unknown>,
): string | null {
  const object = inputObjectSchema(tool);
  if (!object) return null;
  const known = [
    ...Object.keys(object.shape),
    ...(NOTIFY_TOOLS.has(tool.name) ? Object.keys(NOTIFY_INPUT_SHAPE) : []),
  ];
  return describeUnknownArgKeys(tool.name, known, args);
}

const ACTIVE_TURN_STATUS_SCHEMA = z.object({
  running: z.object({ activeTurnId: z.string().nullable() }).nullable(),
});

const NOTIFY_AGENT_ID_SCHEMA = z
  .string()
  .min(1)
  .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed.");

const NOTIFY_ON_FINISH_INPUT = z.object({
  agents: z
    .array(
      z.object({
        agentId: NOTIFY_AGENT_ID_SCHEMA,
        host: z.string().min(1).optional().describe("Optional host hint."),
        turnId: z
          .string()
          .min(1)
          .optional()
          .describe("Bind to this turn; omitted → the agent's run in progress."),
      }),
    )
    .optional()
    .describe("Agents to watch, each optionally bound to a turnId."),
  agentIds: z.array(NOTIFY_AGENT_ID_SCHEMA).optional().describe("Shorthand for agents."),
  perAgent: z
    .boolean()
    .optional()
    .describe("POST paseo.agent.finished for each agent (default true)."),
  group: z
    .boolean()
    .optional()
    .describe("POST one paseo.agents.group_finished once every agent finished (default false)."),
  notifyContext: z
    .string()
    .max(MAX_NOTIFY_CONTEXT_LENGTH)
    .optional()
    .describe("Free-form tag echoed back verbatim as `context` in the webhook payloads."),
});

const WEBHOOK_DELIVERIES_INPUT = z.object({
  agentId: z.string().min(1).optional().describe("Only deliveries about this agent."),
  failedOnly: z
    .boolean()
    .optional()
    .describe("Only attempts that did not deliver (failed, or failed and retried)."),
  since: z.iso.datetime().optional().describe("ISO timestamp; only attempts at or after it."),
  limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 50)."),
});

function errorResult(text: string): PaseoToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** What a start/prompt call that armed the webhook tells the client. */
function armedNotice(inherited: boolean): Record<string, unknown> {
  if (!inherited) {
    return {
      notify: { armed: true },
      guidance:
        "Paseo will POST paseo.agent.finished to your webhook when this run ends. Do not poll for it.",
    };
  }
  return {
    notify: { armed: true, inherited: true },
    guidance:
      "notifyOnFinish is on for this agent from your earlier request: Paseo will POST paseo.agent.finished " +
      "to your webhook when this run ends. Do not poll for it. Pass notifyOnFinish: false to stop.",
  };
}

/** Validates fleet_notify_on_finish arguments into the agents to watch and how to notify. */
function parseNotifyOnFinishRequest(args: Record<string, unknown>):
  | {
      agents: Array<{ agentId: string; host?: string; turnId?: string }>;
      perAgent: boolean;
      group: boolean;
      notifyContext: string | null;
    }
  | { error: string } {
  const unknownArgError = describeUnknownArgKeys(
    "fleet_notify_on_finish",
    Object.keys(NOTIFY_ON_FINISH_INPUT.shape),
    args,
  );
  if (unknownArgError) return { error: unknownArgError };
  const parsed = NOTIFY_ON_FINISH_INPUT.safeParse(args);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  const input = parsed.data;
  const agents = [
    ...(input.agents ?? []),
    ...(input.agentIds ?? []).map((agentId) => ({ agentId })),
  ];
  if (agents.length === 0) return { error: "Pass at least one agent in agents or agentIds." };
  const perAgent = input.perAgent ?? true;
  const group = input.group ?? false;
  if (!perAgent && !group) return { error: "Set perAgent, group, or both; nothing would be sent." };
  return { agents, perAgent, group, notifyContext: input.notifyContext ?? null };
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

/** The finish watcher's view of an agent: one bounded, turn-bound fleet_wait_agent through this client's catalog. */
export function createFleetMcpWaitForAgent(catalog: PaseoToolCatalog): McpFinishWaitForAgent {
  return async (input) => {
    const result = await catalog.executeTool("fleet_wait_agent", {
      agentId: input.agentId,
      ...(input.host ? { host: input.host } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      timeoutSeconds: Math.max(
        1,
        Math.min(WAIT_TOOL_MAX_SECONDS, Math.ceil(input.timeoutMs / 1000)),
      ),
    });
    if (result.isError) {
      throw new Error(result.content.map((block) => block.text ?? "").join(" ") || "wait failed");
    }
    return FLEET_WAIT_RESULT_SCHEMA.parse(result.structuredContent);
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

  const waitForAgent = createFleetMcpWaitForAgent(catalog);

  /** The turn an agent is on right now (null when idle), read via fleet_agent_status. */
  const readActiveTurn = async (agentId: string, host?: string): Promise<string | null> => {
    const status = await catalog
      .executeTool("fleet_agent_status", { agentId, ...(host ? { host } : {}) })
      .catch(() => null);
    const parsed = ACTIVE_TURN_STATUS_SCHEMA.safeParse(status?.structuredContent);
    return parsed.success ? (parsed.data.running?.activeTurnId ?? null) : null;
  };

  /**
   * Whether a start/prompt call arms the client's webhook, and with which
   * context. A follow-up send inherits the client's standing request for the
   * agent, so a client that asked at create time keeps hearing about the runs
   * its later prompts start; notifyOnFinish: false on a send drops it.
   */
  const resolveNotify = (
    name: string,
    toolArgs: Record<string, unknown>,
    notify: z.infer<typeof NotifyArgsSchema>,
  ): { arm: boolean; inherited: boolean; context: string | null } => {
    const { clientName, finishNotifier } = options;
    const sendAgentId =
      !CREATE_TOOLS.has(name) && typeof toolArgs.agentId === "string" ? toolArgs.agentId : null;
    if (notify.notifyOnFinish === false) {
      if (sendAgentId && clientName) finishNotifier?.unsubscribe(clientName, sendAgentId);
      return { arm: false, inherited: false, context: null };
    }
    const subscription =
      sendAgentId && clientName && options.notifyTarget
        ? (finishNotifier?.subscription(clientName, sendAgentId) ?? null)
        : null;
    return {
      arm: notify.notifyOnFinish === true || subscription !== null,
      inherited: notify.notifyOnFinish === undefined,
      context: notify.notifyContext ?? subscription?.context ?? null,
    };
  };

  // Runs a catalog tool for this MCP client. For the agent start/prompt tools
  // it takes notifyOnFinish/notifyContext off the arguments and, after the
  // tool succeeds, arms the client's webhook instead.
  function extractStatusNotifyFields(
    structured: Record<string, unknown>,
    args: Record<string, unknown>,
  ) {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    let host = "local";
    if (typeof structured.host === "string") {
      host = structured.host;
    } else if (typeof args.host === "string") {
      host = args.host;
    }
    const title = typeof structured.title === "string" ? structured.title : null;
    const running = structured.running as { activeTurnId?: string | null } | null | undefined;
    const turnId = running?.activeTurnId ?? null;
    let context: string | null = null;
    if (typeof args.notifyContext === "string") {
      context = args.notifyContext;
    } else if (typeof args.context === "string") {
      context = args.context;
    }
    const targetHost = typeof args.host === "string" ? args.host : host;
    return { agentId, targetHost, title, turnId, context };
  }

  const handleStatusNotify = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PaseoToolResult> => {
    if (args.fresh !== true) {
      return errorResult("notify: true is only valid when fresh: true");
    }
    const { finishNotifier, notifyTarget, clientName } = options;
    if (!finishNotifier || !notifyTarget || !clientName) {
      return errorResult(
        "notify: true needs a webhook for this MCP client (daemon.mcp.remoteClients[].notify), and none is configured. " +
          "Call again without notify: true instead.",
      );
    }
    const requestId = typeof args.requestId === "string" ? args.requestId : `req_${randomUUID()}`;
    const result = await catalog.executeTool(name, { ...args, requestId }, { signal });
    if (result.isError) return result;

    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const { agentId, targetHost, title, turnId, context } = extractStatusNotifyFields(
      structured,
      args,
    );
    const isLocal = targetHost === "local" || targetHost === "";
    const peerClient =
      !isLocal && options.hostDependencies.peerManager
        ? options.hostDependencies.peerManager.getPeerClient(targetHost)
        : null;

    finishNotifier.armStatusReport({
      client: clientName,
      target: notifyTarget,
      requestId: typeof structured.requestId === "string" ? structured.requestId : requestId,
      agentId,
      host: targetHost,
      title,
      turnId,
      context,
      waitForAgent,
      subscribeSelfReports: options.hostDependencies.missionControlService
        ? (listener) =>
            options.hostDependencies.missionControlService!.subscribeSelfReports(listener)
        : undefined,
      peerClient,
    });

    return result;
  };

  const handleNotifyOnFinish = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PaseoToolResult> => {
    const { notifyOnFinish: _notify, notifyContext: _context, ...toolArgs } = args;
    const notify = NotifyArgsSchema.safeParse(args);
    if (!notify.success) {
      return errorResult(
        `Invalid notify arguments: ${notify.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const plan = resolveNotify(name, toolArgs, notify.data);
    const { finishNotifier, notifyTarget, clientName } = options;
    if (plan.arm && (!finishNotifier || !notifyTarget || !clientName)) {
      return errorResult(
        "notifyOnFinish needs a webhook for this MCP client (daemon.mcp.remoteClients[].notify), and none is configured. " +
          "Call again without notifyOnFinish and use fleet_wait_agent instead.",
      );
    }
    if (CATALOG_NOTIFY_TOOLS.has(name)) toolArgs.notifyOnFinish = false;
    const result = await catalog.executeTool(name, toolArgs, { signal });
    if (!plan.arm || result.isError) return result;

    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const agentId = CREATE_TOOLS.has(name) ? structured.agentId : toolArgs.agentId;
    if (typeof agentId !== "string" || !agentId) {
      return {
        ...result,
        structuredContent: {
          ...structured,
          notify: { armed: false },
          guidance: "notifyOnFinish was not armed: no agent was started.",
        },
      };
    }
    const host = typeof toolArgs.host === "string" ? toolArgs.host : undefined;
    const turnId = typeof structured.turnId === "string" ? structured.turnId : null;
    void finishNotifier!.arm({
      client: clientName!,
      target: notifyTarget!,
      agentId,
      ...(host ? { host } : {}),
      turnId,
      tool: name,
      context: plan.context,
      waitForAgent,
    });
    return { ...result, structuredContent: { ...structured, ...armedNotice(plan.inherited) } };
  };

  const runCatalogTool = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PaseoToolResult> => {
    const tool = catalog.getTool(name);
    const unknownArgError = tool ? describeUnknownArgs(tool, args) : null;
    if (unknownArgError) return errorResult(unknownArgError);
    if (name === "fleet_agent_status" && args.notify === true) {
      return handleStatusNotify(name, args, signal);
    }
    if (!NOTIFY_TOOLS.has(name)) return catalog.executeTool(name, args, { signal });
    return handleNotifyOnFinish(name, args, signal);
  };

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Loose, so unknown arguments reach runCatalogTool and get a clear
        // error instead of being stripped silently.
        inputSchema: mcpInputObject(tool),
      },
      async (args: Record<string, unknown>, context?: McpToolContext) =>
        toMcpToolResult(await runCatalogTool(tool.name, args, context?.signal)),
    );
  }

  server.registerTool(
    "fleet_notify_on_finish",
    {
      title: "Webhook when agents finish",
      description:
        "Arm webhook callbacks for one or more agents without holding a call open. perAgent (default true) " +
        "POSTs paseo.agent.finished as each agent's turn ends; group POSTs one paseo.agents.group_finished " +
        "once every agent's turn has ended. needs_permission always POSTs per agent and does not complete " +
        "the group. Each agent binds to the turnId given, else to its run in progress; an idle agent with " +
        "no run fires at once with turnId null. Watches survive a daemon restart: each agent reports the " +
        'run the restarted daemon resumes, or reason "interrupted" when it never resumes. An agent whose ' +
        "host restarts mid-run first POSTs a non-final paseo.agent.interrupted. Returns immediately.",
      inputSchema: NOTIFY_ON_FINISH_INPUT.loose(),
    },
    async (args: Record<string, unknown>) => {
      const request = parseNotifyOnFinishRequest(args);
      if ("error" in request) return toMcpToolResult(errorResult(request.error));
      if (!options.finishNotifier || !options.notifyTarget || !options.clientName) {
        return toMcpToolResult(
          errorResult(
            "fleet_notify_on_finish needs a webhook for this MCP client (daemon.mcp.remoteClients[].notify), " +
              "and none is configured. Use fleet_wait_agents instead.",
          ),
        );
      }
      const agents = await Promise.all(
        request.agents.map(async ({ agentId, host, turnId }): Promise<McpNotifyAgent> => {
          const bound = turnId ?? (await readActiveTurn(agentId, host));
          return host ? { agentId, host, turnId: bound } : { agentId, turnId: bound };
        }),
      );
      const common = {
        client: options.clientName,
        target: options.notifyTarget,
        tool: "fleet_notify_on_finish",
        context: request.notifyContext,
        waitForAgent,
      };
      const groupId = request.group ? `grp_${randomUUID()}` : undefined;
      if (groupId) {
        void options.finishNotifier.armGroup({
          ...common,
          groupId,
          agents,
          perAgent: request.perAgent,
        });
      } else {
        for (const agent of agents) void options.finishNotifier.arm({ ...common, ...agent });
      }
      const structuredContent = {
        armed: agents.map(({ agentId, turnId }) => ({ agentId, turnId: turnId ?? null })),
        ...(groupId ? { groupId } : {}),
        guidance: "Paseo will POST to your webhook when these turns end. Do not poll for them.",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "fleet_webhook_deliveries",
    {
      title: "Webhook delivery history",
      description:
        "List the POSTs Paseo made to your webhook (finish, needs_permission, interrupted, group and " +
        "status-report events), newest first: one row per attempt with the event, agent, turn, " +
        "notifyContext, HTTP status, response snippet, attempt number and outcome " +
        '("delivered", "retrying", "failed"). totals counts every match, not just the returned page. ' +
        "Use failedOnly to find events you never received.",
      inputSchema: WEBHOOK_DELIVERIES_INPUT.shape,
    },
    async (args: z.infer<typeof WEBHOOK_DELIVERIES_INPUT>) => {
      if (!options.finishNotifier || !options.clientName) {
        return toMcpToolResult(
          errorResult(
            "This MCP client has no webhook configured (daemon.mcp.remoteClients[].notify).",
          ),
        );
      }
      const structuredContent = await options.finishNotifier.listDeliveries({
        client: options.clientName,
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.since ? { since: args.since } : {}),
        failedOnly: args.failedOnly ?? false,
        limit: args.limit ?? 50,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
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
