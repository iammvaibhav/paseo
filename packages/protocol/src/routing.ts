import { z } from "zod";

/**
 * Placement routing: given a prompt, pick where a new agent runs (existing
 * project, a new project, or the host's scratch project), its isolation, and
 * its agent mode. Served by any daemon over routing.suggest.*; the same
 * function backs the `suggest_placement` MCP tool.
 *
 * Hosts are always named by serverId on the wire and in config; `hostLabel`
 * is display only (the host's missionControl.hostAlias).
 */

export const ChatEndpointSchema = z.object({ baseUrl: z.string(), model: z.string() });
export type ChatEndpoint = z.infer<typeof ChatEndpointSchema>;

export const RoutingConfigSchema = z.object({
  // serverId of the host new projects and scratch work land on when the
  // prompt names no host.
  defaultHost: z.string().nullable().optional(),
  // serverId → parent directory for new projects.
  projectRootByHost: z.record(z.string(), z.string()).optional(),
  // serverId → the scratch project's root.
  scratchRootByHost: z.record(z.string(), z.string()).optional(),
  // serverIds in the work profile; every other host is personal.
  workHosts: z.array(z.string()).optional(),
  // Agent mode id → model as "provider:model" (the ticked-models form, e.g.
  // "omp:anthropic/claude-opus-5-5"). "default" covers unlisted modes.
  modelByMode: z.record(z.string(), z.string()).optional(),
  // Work-profile overrides of modelByMode, same keys.
  workModelByMode: z.record(z.string(), z.string()).optional(),
  // Optional free-text routing rules, given to every routing question.
  rules: z.string().optional(),
  // OpenAI-compatible chat endpoints. nameModel: called once at Enter to
  // name a new project (the only name that cannot change later).
  // metadataModel: every other generated text (workspace/agent titles,
  // branch names, descriptions, commit and PR drafts) and the nameModel
  // fallback. Both run with reasoning off.
  nameModel: ChatEndpointSchema.nullable().optional(),
  metadataModel: ChatEndpointSchema.nullable().optional(),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

// Secrets live beside `routing` in central config. They are replicated to
// peers (each daemon calls the APIs itself) but never sent to clients:
// config.get/patch responses carry only which keys are set.
export const RoutingSecretsSchema = z.object({
  typesafeApiKey: z.string().optional(),
  nameModelApiKey: z.string().optional(),
  metadataModelApiKey: z.string().optional(),
});
export type RoutingSecrets = z.infer<typeof RoutingSecretsSchema>;

export const ROUTING_SECRET_KEYS = [
  "typesafeApiKey",
  "nameModelApiKey",
  "metadataModelApiKey",
] as const;
export type RoutingSecretKey = (typeof ROUTING_SECRET_KEYS)[number];

export const RoutingPlacementSchema = z.object({
  kind: z.enum(["project", "new_project", "scratch"]),
  serverId: z.string(),
  hostLabel: z.string(),
  // Existing project id for kind "project", and for "scratch" once the
  // host's scratch project exists. Null otherwise.
  projectId: z.string().nullable(),
  projectTitle: z.string().nullable(),
  // Directory the workspace will use: the project root, the scratch root, or
  // the parent directory a new project is created under.
  rootPath: z.string().nullable(),
  probability: z.number(),
});
export type RoutingPlacement = z.infer<typeof RoutingPlacementSchema>;

export const RoutingSuggestionSchema = z.object({
  placement: RoutingPlacementSchema,
  // Next most likely placements, best first.
  alternatives: z.array(RoutingPlacementSchema),
  isolation: z.enum(["local", "worktree"]),
  agentMode: z.string(),
  // omp model for the chosen mode and profile ("provider/model"), or null
  // when routing config names none.
  model: z.string().nullable(),
  profile: z.enum(["personal", "work"]),
  latencyMs: z.number(),
});
export type RoutingSuggestion = z.infer<typeof RoutingSuggestionSchema>;

export const RoutingSuggestRequestSchema = z.object({
  type: z.literal("routing.suggest.request"),
  prompt: z.string(),
  requestId: z.string(),
});
export type RoutingSuggestRequest = z.infer<typeof RoutingSuggestRequestSchema>;

export const RoutingSuggestResponseSchema = z.object({
  type: z.literal("routing.suggest.response"),
  payload: z.object({
    requestId: z.string(),
    suggestion: RoutingSuggestionSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type RoutingSuggestResponse = z.infer<typeof RoutingSuggestResponseSchema>;

// Create a project for a prompt on the receiving host: name it (nameModel,
// metadataModel on failure), mkdir -p under the host's project root,
// git init with a first commit, register it, and set its description.
export const RoutingProjectCreateRequestSchema = z.object({
  type: z.literal("routing.project.create.request"),
  prompt: z.string(),
  // Parent directory override; absent = this host's configured project root.
  parentPath: z.string().optional(),
  // Ensure this host's scratch project instead (mkdir -p the scratch root,
  // register it as a plain directory). The prompt is ignored.
  scratch: z.boolean().optional(),
  requestId: z.string(),
});
export type RoutingProjectCreateRequest = z.infer<typeof RoutingProjectCreateRequestSchema>;

export const RoutingProjectCreateResponseSchema = z.object({
  type: z.literal("routing.project.create.response"),
  payload: z.object({
    requestId: z.string(),
    project: z
      .object({
        projectId: z.string(),
        rootPath: z.string(),
        title: z.string(),
        description: z.string().nullable(),
      })
      .nullable(),
    error: z.string().nullable(),
  }),
});
export type RoutingProjectCreateResponse = z.infer<typeof RoutingProjectCreateResponseSchema>;

// Change an agent's mode. Nothing is sent to the agent: the mode's block
// rides the user's next message.
export const AgentModeSetRequestSchema = z.object({
  type: z.literal("agent.agent_mode.set.request"),
  agentId: z.string(),
  agentMode: z.string(),
  requestId: z.string(),
});
export type AgentModeSetRequest = z.infer<typeof AgentModeSetRequestSchema>;

export const AgentModeSetResponseSchema = z.object({
  type: z.literal("agent.agent_mode.set.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});
export type AgentModeSetResponse = z.infer<typeof AgentModeSetResponseSchema>;
