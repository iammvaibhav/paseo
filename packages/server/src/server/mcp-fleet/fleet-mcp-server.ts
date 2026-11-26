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
  createCatalogFleetHostResolver,
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "../agent/tools/paseo-tools.js";
import { FLEET_HOST_HINT_DESCRIPTION, listFleetHosts } from "../peers/fleet-hosts.js";
import { FLEET_WAIT_RESULT_SCHEMA } from "../agent/tools/fleet-wait.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolResult,
} from "../agent/tools/types.js";
import {
  describeTargetRef,
  MAX_NOTIFY_CONTEXT_LENGTH,
  type McpFinishNotifier,
  type McpFinishWaitForAgent,
  type McpNotifyAgent,
  type McpNotifyTarget,
  type McpNotifyTargetRef,
  type McpWebhookTarget,
} from "./finish-notifier.js";
import { loadFleetSkillText } from "./skill.js";

export const FLEET_MCP_INSTRUCTIONS =
  "You control the whole Paseo fleet across all peered hosts. Tools named fleet_* and memory_* act on " +
  "any host; call fleet_list_hosts before you pass host, and pass one of the names it lists. Every other " +
  "tool acts only on the host serving this endpoint. Call paseo_skill for the full guide.";

/**
 * Catalog tools /mcp/fleet does not list, each with the fleet tool that does
 * the same job on any host. Agent catalogs keep them: there they act for the
 * calling agent (its subagents, its workspace).
 */
export const FLEET_MCP_REPLACED_TOOLS: Readonly<Record<string, string>> = {
  list_hosts: "fleet_list_hosts",
  create_agent: "fleet_create_agent",
  send_agent_prompt: "fleet_send_prompt",
  get_agent_status: "fleet_agent_status",
  list_agents: "fleet_list_agents",
  get_agent_activity: "fleet_get_agent_activity",
  cancel_agent: "fleet_cancel_agent",
  kill_agent: "fleet_kill_agent",
  update_agent: "fleet_update_agent",
  set_agent_mode: "fleet_update_agent",
  archive_agent: "fleet_archive_agent",
  archive_workspace: "fleet_archive_workspace",
  rename_workspace: "fleet_rename_workspace",
  list_workspaces: "fleet_list_inventory",
  list_models: "fleet_list_models",
  itsaplan_ticketize: "fleet_ticketize_agent",
};

/**
 * A start/prompt call's request to watch one agent's turn for the targets it
 * named. A host forwards it to the agent's own host (NOTIFY_ARM_PEER_TOOL),
 * which parses it with this schema.
 */
export const FleetMcpNotifyArmRequestSchema = z.object({
  client: z.string().min(1),
  tool: z.string().min(1),
  agentId: z.string().min(1),
  /** The host hint the call passed; the arm finds the agent's host either way. */
  host: z.string().min(1).optional(),
  /** The turn the call started or joined; null → the run in progress. */
  turnId: z.string().nullable(),
  /** The call's prompt waits for this turn to end; the watch binds to the next one. */
  nextTurnAfter: z.string().nullable(),
  context: z.string().max(MAX_NOTIFY_CONTEXT_LENGTH).nullable(),
  targets: z
    .array(z.union([z.object({ name: z.string().min(1) }), z.object({ agent: z.string().min(1) })]))
    .min(1),
});

export type FleetMcpNotifyArmRequest = z.infer<typeof FleetMcpNotifyArmRequestSchema>;

/** Where the watch runs: "local" or the agent's peer host; an error when it could not be armed. */
export type FleetMcpNotifyArmResult = { armedOn: string } | { error: string };

export interface FleetMcpServerOptions {
  hostDependencies: PaseoToolHostDependencies;
  /** A catalog built earlier from the same hostDependencies; skips rebuilding it per request. */
  catalog?: PaseoToolCatalog;
  clientName?: string;
  explicitSkillPath?: string | null;
  /** Runs group and status-report watches here, and lists deliveries; absent → those tools are refused. */
  finishNotifier?: McpFinishNotifier;
  /** Named webhooks (daemon.mcp.notifyTargets) a call lists in notifyTargets. */
  namedNotifyTargets?: ReadonlyMap<string, McpWebhookTarget>;
  /** Arms a start/prompt call's watch on the agent's own host; absent → notifyTargets is refused. */
  armNotify?: (request: FleetMcpNotifyArmRequest) => Promise<FleetMcpNotifyArmResult>;
}

// Tools that start or prompt an agent. On /mcp/fleet their callbacks go to
// the targets the call names, never the catalog's agent-thread notification:
// the MCP principal runs as the Commander, so that would wake the Commander.
const NOTIFY_TOOLS = new Set(["fleet_create_agent", "fleet_send_prompt"]);
const CREATE_TOOLS = new Set(["fleet_create_agent"]);
// Tools whose own schema has notifyOnFinish; it is forced off before they run.
const CATALOG_NOTIFY_TOOLS = new Set(["fleet_create_agent"]);
const WAIT_TOOL_MAX_SECONDS = 1800;

const NOTIFY_TARGETS_SCHEMA = z
  .array(z.union([z.string().min(1), z.object({ agent: z.string().min(1) }).strict()]))
  .max(10);

const NOTIFY_TARGETS_DESCRIPTION =
  "Who gets callbacks for this turn: names of configured webhooks (daemon.mcp.notifyTargets, e.g. " +
  '"grok-bot") and/or agents as {agent: "<agent id>"} (an agent gets each event as a prompt that joins ' +
  "its running turn; pass your own id to be woken). Omitted or empty → no callback. Applies to this turn " +
  "only: a later prompt calls back only the targets it names, and two callers steering into one running " +
  "turn both hear its end. Unknown names are rejected; URLs are not accepted.";

const NOTIFY_INPUT_SHAPE = {
  notifyTargets: NOTIFY_TARGETS_SCHEMA.optional().describe(
    `${NOTIFY_TARGETS_DESCRIPTION} Events: paseo.agent.finished when the turn ends (also on error, ` +
      "cancel or archive), paseo.agent.needs_permission when it blocks on a permission, and " +
      "paseo.agent.interrupted (final: false) when its host restarts mid-run; a target configured with " +
      "intermediateMessages also gets paseo.agent.message for each message the agent writes mid-turn. " +
      "The watch survives a daemon restart. Returns immediately.",
  ),
  notifyContext: z
    .string()
    .max(MAX_NOTIFY_CONTEXT_LENGTH)
    .optional()
    .describe("Free-form tag echoed back verbatim as `context` in every callback."),
  // COMPAT(notify-targets): added in v0.17.5, remove after 2026-12-10. Callers from before notifyTargets.
  notifyOnFinish: z
    .boolean()
    .optional()
    .describe(
      'Deprecated: use notifyTargets. true → the target named like your client ("grok-bot").',
    ),
  // COMPAT(notify-targets): added in v0.17.5, remove after 2026-12-10.
  notifyTarget: z.string().min(1).optional().describe("Deprecated: use notifyTargets: [name]."),
};

// Parsed off the tool arguments before the catalog tool runs.
const NotifyArgsSchema = z.object(NOTIFY_INPUT_SHAPE);

function withNotifyInput(schema: PaseoToolConfig["inputSchema"]): PaseoToolConfig["inputSchema"] {
  if (schema instanceof z.ZodObject) return schema.extend(NOTIFY_INPUT_SHAPE);
  if (schema === undefined || schema instanceof z.ZodType) return schema;
  return { ...schema, ...NOTIFY_INPUT_SHAPE };
}

/**
 * A tool's input as one object schema; null when it is not an object (unions,
 * effects). Upstream's connected-host selector (serverId "from list_hosts") is
 * left out: list_hosts is not on this surface and fleet_* tools reach the
 * other hosts, so a tool that kept the selector acts on this host only.
 */
function inputObjectSchema(tool: PaseoToolDefinition): z.ZodObject | null {
  const schema = tool.inputSchema;
  let object: z.ZodObject;
  if (schema === undefined) object = z.object({});
  else if (schema instanceof z.ZodObject) object = schema;
  else if (schema instanceof z.ZodType) return null;
  else object = z.object(schema);
  return Object.hasOwn(object.shape, "serverId") ? object.omit({ serverId: true }) : object;
}

// fleet_agent_status notify:true calls back the targets in notifyTargets.
const STATUS_NOTIFY_SHAPE = {
  notifyTargets: NOTIFY_TARGETS_SCHEMA.optional().describe(
    `With notify: true, who gets paseo.agent.status_reported. ${NOTIFY_TARGETS_DESCRIPTION}`,
  ),
};

/** The arguments /mcp/fleet adds to a catalog tool's own. */
function addedInputShape(toolName: string): Record<string, z.ZodType> {
  if (NOTIFY_TOOLS.has(toolName)) return NOTIFY_INPUT_SHAPE;
  if (toolName === "fleet_agent_status") return STATUS_NOTIFY_SHAPE;
  return {};
}

function mcpInputObject(tool: PaseoToolDefinition): PaseoToolConfig["inputSchema"] {
  const object = inputObjectSchema(tool);
  if (!object) {
    return NOTIFY_TOOLS.has(tool.name) ? withNotifyInput(tool.inputSchema) : tool.inputSchema;
  }
  return object.extend(addedInputShape(tool.name)).loose();
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

// Arguments a tool took before upstream retired them, keyed "tool.arg". The
// error says what replaced them, since a fixed-shape caller (an n8n node)
// cannot guess.
const RETIRED_ARGS: Record<string, string> = {
  // COMPAT(retired-background-arg): upstream #5039 dropped it (merged 2026-10-29); remove after 2027-01-31.
  "fleet_create_agent.background":
    "removed: fleet_create_agent never waits for the run, so drop it",
};

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
    const retired = RETIRED_ARGS[`${toolName}.${key}`];
    if (retired) return `"${key}" (${retired})`;
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
    ...new Set([...Object.keys(object.shape), ...Object.keys(addedInputShape(tool.name))]),
  ];
  return describeUnknownArgKeys(tool.name, known, args);
}

const ACTIVE_TURN_STATUS_SCHEMA = z.object({
  running: z.object({ activeTurnId: z.string().nullable() }).nullable(),
});

const NOTIFY_AGENT_ID_SCHEMA = z
  .string()
  .min(1)
  .describe("Agent UUID from fleet_list_agents/memory_search data — fleet-wide, no host needed.");

const NOTIFY_ON_FINISH_INPUT = z.object({
  agents: z
    .array(
      z.object({
        agentId: NOTIFY_AGENT_ID_SCHEMA,
        host: z.string().min(1).optional().describe(FLEET_HOST_HINT_DESCRIPTION),
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
  notifyTargets: NOTIFY_TARGETS_SCHEMA.min(1).describe(NOTIFY_TARGETS_DESCRIPTION),
  notifyContext: z
    .string()
    .max(MAX_NOTIFY_CONTEXT_LENGTH)
    .optional()
    .describe("Free-form tag echoed back verbatim as `context` in every callback."),
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

/** What a start/prompt call tells the client about its callbacks. */
function notifyNotice(
  targets: readonly McpNotifyTargetRef[],
  outcome: FleetMcpNotifyArmResult,
): Record<string, unknown> {
  if ("error" in outcome) {
    return {
      notify: { armed: false, error: outcome.error },
      guidance: `The prompt was delivered, but no callback is armed: ${outcome.error} Use fleet_wait_agent instead.`,
    };
  }
  const names = targets.map(describeTargetRef).join(", ");
  return {
    notify: { armed: true, targets: targets.map(describeTargetRef), armedOn: outcome.armedOn },
    guidance: `Paseo calls back ${names} when this turn ends. Do not poll for it.`,
  };
}

/** Validates fleet_notify_on_finish arguments into the agents to watch and how to notify. */
function parseNotifyOnFinishRequest(args: Record<string, unknown>):
  | {
      agents: Array<{ agentId: string; host?: string; turnId?: string }>;
      perAgent: boolean;
      group: boolean;
      notifyTargets: Array<string | { agent: string }>;
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
  return {
    agents,
    perAgent,
    group,
    notifyTargets: input.notifyTargets,
    notifyContext: input.notifyContext ?? null,
  };
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
   * The targets a call named, checked against this host's config. Webhook
   * names must be configured; an agent target is any agent id.
   */
  const resolveTargetRefs = (
    notify: z.infer<typeof NotifyArgsSchema>,
  ): McpNotifyTargetRef[] | { error: string } => {
    let entries = notify.notifyTargets ?? [];
    // COMPAT(notify-targets): added in v0.17.5, remove after 2026-12-10.
    if (!notify.notifyTargets && notify.notifyOnFinish !== false) {
      if (notify.notifyTarget) entries = [notify.notifyTarget];
      else if (notify.notifyOnFinish === true && options.clientName) entries = [options.clientName];
    }
    const refs: McpNotifyTargetRef[] = [];
    for (const entry of entries) {
      const ref: McpNotifyTargetRef = typeof entry === "string" ? { name: entry } : entry;
      if ("agent" in ref && ref.agent === "self") {
        return {
          error:
            '{agent: "self"} needs a calling agent, and this endpoint does not know which agent is calling. ' +
            "Pass your own agent id (env PASEO_AGENT_ID) instead.",
        };
      }
      if ("name" in ref && !options.namedNotifyTargets?.has(ref.name)) {
        const known = [...(options.namedNotifyTargets?.keys() ?? [])];
        return {
          error:
            `Unknown notify target "${ref.name}". ` +
            (known.length > 0
              ? `Configured targets: ${known.join(", ")}.`
              : "No notify targets are configured (daemon.mcp.notifyTargets)."),
        };
      }
      if (!refs.some((existing) => describeTargetRef(existing) === describeTargetRef(ref))) {
        refs.push(ref);
      }
    }
    return refs;
  };

  /** Where a target ref delivers when a watch runs on this host. */
  const bindTarget = (ref: McpNotifyTargetRef): McpNotifyTarget =>
    "name" in ref
      ? options.namedNotifyTargets!.get(ref.name)!
      : { kind: "agent", agentId: ref.agent };

  const parseNotifyArgs = (
    args: Record<string, unknown>,
  ): { refs: McpNotifyTargetRef[]; context: string | null } | { error: string } => {
    const notify = NotifyArgsSchema.safeParse(args);
    if (!notify.success) {
      return {
        error: `Invalid notify arguments: ${notify.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }
    const refs = resolveTargetRefs(notify.data);
    if ("error" in refs) return refs;
    if (refs.length > 0 && (!options.armNotify || !options.clientName)) {
      return {
        error: "Callbacks are not available on this endpoint. Use fleet_wait_agent instead.",
      };
    }
    return { refs, context: notify.data.notifyContext ?? null };
  };

  function extractStatusNotifyFields(
    structured: Record<string, unknown>,
    args: Record<string, unknown>,
  ) {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    // The tool's own result names the agent's host canonically ("local", this
    // host's alias or the peer name); the argument is only a hint.
    let targetHost = "local";
    if (typeof structured.host === "string") {
      targetHost = structured.host;
    } else if (typeof args.host === "string") {
      targetHost = args.host;
    }
    const title = typeof structured.title === "string" ? structured.title : null;
    const running = structured.running as { activeTurnId?: string | null } | null | undefined;
    const turnId = running?.activeTurnId ?? null;
    const context = typeof args.notifyContext === "string" ? args.notifyContext : null;
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
    const { notifyTargets: rawTargets, ...statusArgs } = args;
    const targets = NOTIFY_TARGETS_SCHEMA.safeParse(rawTargets ?? []);
    const refs = targets.success ? resolveTargetRefs({ notifyTargets: targets.data }) : [];
    if ("error" in refs) return errorResult(refs.error);
    const { finishNotifier, clientName } = options;
    if (refs.length === 0) {
      return errorResult(
        'notify: true needs notifyTargets: the webhooks (e.g. ["grok-bot"]) or {agent: id} to call back.',
      );
    }
    if (!finishNotifier || !clientName) {
      return errorResult(
        "Callbacks are not available on this endpoint. Call again without notify.",
      );
    }
    const requestId =
      typeof statusArgs.requestId === "string" ? statusArgs.requestId : `req_${randomUUID()}`;
    const result = await catalog.executeTool(name, { ...statusArgs, requestId }, { signal });
    if (result.isError) return result;

    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const { agentId, targetHost, title, turnId, context } = extractStatusNotifyFields(
      structured,
      statusArgs,
    );
    const target = createCatalogFleetHostResolver(options.hostDependencies).resolve(targetHost);
    const peerClient =
      target.ok && target.kind === "peer"
        ? (options.hostDependencies.peerManager?.getPeerClient(target.peerName) ?? null)
        : null;

    for (const ref of refs) {
      finishNotifier.armStatusReport({
        client: clientName,
        target: bindTarget(ref),
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
    }

    return result;
  };

  // Runs fleet_create_agent / fleet_send_prompt for this MCP client: takes the
  // notify arguments off, runs the tool, then arms a watch on the agent's own
  // host for the targets the call named.
  const handleNotifyTargets = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PaseoToolResult> => {
    const {
      notifyOnFinish: _notify,
      notifyContext: _context,
      notifyTarget: _target,
      notifyTargets: _targets,
      ...toolArgs
    } = args;
    const notify = parseNotifyArgs(args);
    if ("error" in notify) return errorResult(notify.error);
    if (CATALOG_NOTIFY_TOOLS.has(name)) toolArgs.notifyOnFinish = false;
    const result = await catalog.executeTool(name, toolArgs, { signal });
    if (notify.refs.length === 0 || result.isError) return result;

    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const agentId = CREATE_TOOLS.has(name) ? structured.agentId : toolArgs.agentId;
    if (typeof agentId !== "string" || !agentId) {
      return {
        ...result,
        structuredContent: {
          ...structured,
          notify: { armed: false },
          guidance: "No callback is armed: no agent was started.",
        },
      };
    }
    const outcome = await options.armNotify!({
      client: options.clientName!,
      tool: name,
      agentId,
      ...(typeof toolArgs.host === "string" ? { host: toolArgs.host } : {}),
      turnId: typeof structured.turnId === "string" ? structured.turnId : null,
      nextTurnAfter:
        typeof structured.waitsForTurnId === "string" ? structured.waitsForTurnId : null,
      context: notify.context,
      targets: notify.refs,
    }).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      ...result,
      structuredContent: { ...structured, ...notifyNotice(notify.refs, outcome) },
    };
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
    if (!NOTIFY_TOOLS.has(name)) {
      return catalog.executeTool(name, args, {
        signal,
        ...(options.clientName ? { callerClient: options.clientName } : {}),
      });
    }
    return handleNotifyTargets(name, args, signal);
  };

  // Tools without the fleet_/memory_ prefix act on this daemon only; say so
  // in their descriptions, because MCP gateways show clients descriptions,
  // not the server instructions.
  const selfEntry = listFleetHosts(
    createCatalogFleetHostResolver(options.hostDependencies).directory(),
  )[0];
  const selfName = selfEntry?.names.find((name) => name !== "local") ?? "this host";
  const hostLocalNote = ` Acts only on ${selfName}, the host serving this MCP endpoint; fleet_* tools act on any host.`;
  for (const tool of catalog.tools.values()) {
    if (Object.hasOwn(FLEET_MCP_REPLACED_TOOLS, tool.name)) continue;
    const fleetWide = tool.name.startsWith("fleet_") || tool.name.startsWith("memory_");
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: fleetWide ? tool.description : `${tool.description}${hostLocalNote}`,
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
      title: "Callbacks when agents finish",
      description:
        "Arm callbacks for one or more agents without holding a call open; notifyTargets names who gets " +
        "them. perAgent (default true) sends paseo.agent.finished as each agent's turn ends; group sends " +
        "one paseo.agents.group_finished once every agent's turn has ended. needs_permission always goes " +
        "per agent and does not complete the group. Each agent binds to the turnId given, else to its run " +
        "in progress; an idle agent with no run fires at once with turnId null. Watches survive a daemon " +
        'restart: each agent reports the run the restarted daemon resumes, or reason "interrupted" when ' +
        "it never resumes. An agent whose host restarts mid-run first sends a non-final " +
        "paseo.agent.interrupted. Returns immediately.",
      inputSchema: NOTIFY_ON_FINISH_INPUT.loose(),
    },
    async (args: Record<string, unknown>) => {
      const request = parseNotifyOnFinishRequest(args);
      if ("error" in request) return toMcpToolResult(errorResult(request.error));
      const refs = resolveTargetRefs({ notifyTargets: request.notifyTargets });
      if ("error" in refs) return toMcpToolResult(errorResult(refs.error));
      const { finishNotifier, armNotify, clientName } = options;
      if (!finishNotifier || !armNotify || !clientName) {
        return toMcpToolResult(
          errorResult(
            "Callbacks are not available on this endpoint. Use fleet_wait_agents instead.",
          ),
        );
      }
      const agents = await Promise.all(
        request.agents.map(async ({ agentId, host, turnId }): Promise<McpNotifyAgent> => {
          const bound = turnId ?? (await readActiveTurn(agentId, host));
          return host ? { agentId, host, turnId: bound } : { agentId, turnId: bound };
        }),
      );
      const tool = "fleet_notify_on_finish";
      // Per-agent watches run on each agent's own host.
      const perAgentErrors: string[] = [];
      if (request.perAgent) {
        const outcomes = await Promise.all(
          agents.map((agent) =>
            armNotify({
              client: clientName,
              tool,
              agentId: agent.agentId,
              ...(agent.host ? { host: agent.host } : {}),
              turnId: agent.turnId ?? null,
              nextTurnAfter: null,
              context: request.notifyContext,
              targets: refs,
            }).catch((error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
            })),
          ),
        );
        outcomes.forEach((outcome, index) => {
          if ("error" in outcome)
            perAgentErrors.push(`${agents[index]!.agentId}: ${outcome.error}`);
        });
      }
      // A group spans hosts, so this host watches it.
      const groupId = request.group ? `grp_${randomUUID()}` : undefined;
      if (groupId) {
        for (const ref of refs) {
          void finishNotifier.armGroup({
            client: clientName,
            target: bindTarget(ref),
            targetRef: ref,
            tool,
            context: request.notifyContext,
            waitForAgent,
            groupId: refs.length > 1 ? `${groupId}:${describeTargetRef(ref)}` : groupId,
            agents,
            perAgent: request.perAgent,
          });
        }
      }
      const structuredContent = {
        armed: agents.map(({ agentId, turnId }) => ({ agentId, turnId: turnId ?? null })),
        targets: refs.map(describeTargetRef),
        ...(groupId ? { groupId } : {}),
        ...(perAgentErrors.length > 0 ? { errors: perAgentErrors } : {}),
        guidance: "Paseo calls back your targets when these turns end. Do not poll for them.",
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
      title: "Callback delivery history",
      description:
        "List the callbacks this host delivered for your calls (finish, needs_permission, interrupted, " +
        "message, group and status-report events), newest first: one row per attempt with the event, agent, " +
        "turn, notifyContext, HTTP status, response snippet, attempt number and outcome. An agent's own host " +
        "delivers its callbacks, so this lists the agents this host runs, plus groups and status reports " +
        "armed here. All attempts of one event share deliveryId (also sent as the body's deliveryId and the " +
        "X-Paseo-Delivery-Id header, so you can drop duplicates). " +
        '"retrying" rows carry nextAttemptAt: Paseo retries network errors, 408, 425, 429, 5xx and ' +
        "rate-limited 4xx with backoff, by default 6 attempts over about 15 minutes. " +
        '"failed" means the event was given up on: failure "exhausted" (every retry failed) or ' +
        '"not_retryable" (another 4xx). "suppressed" rows were never sent on purpose: suppressedReason ' +
        '"filtered" (the target is not configured to take that event). totals counts every match, not ' +
        "just the returned page. Use failedOnly to find events you never received.",
      inputSchema: WEBHOOK_DELIVERIES_INPUT.shape,
    },
    async (args: z.infer<typeof WEBHOOK_DELIVERIES_INPUT>) => {
      if (!options.finishNotifier || !options.clientName) {
        return toMcpToolResult(errorResult("Callbacks are not available on this endpoint."));
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
