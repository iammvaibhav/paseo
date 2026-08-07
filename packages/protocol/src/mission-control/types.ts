import { z } from "zod";

// Mission Control fleet events: deterministic transition cards from the daemon
// detectors plus summarizer judgment cards. One shared shape for the feed, the
// event store, and the wire.
export const MissionControlEventKindSchema = z.enum([
  "started",
  "finished",
  "failed",
  "blocked",
  "stalled",
  "milestone",
  "finding",
  "diverged",
]);
export type MissionControlEventKind = z.infer<typeof MissionControlEventKindSchema>;

export const MissionControlProofSchema = z.object({
  kind: z.enum(["url", "image", "diff", "command"]),
  url: z.string().optional(),
  path: z.string().optional(),
  label: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  exitCode: z.number().optional(),
});
export type MissionControlProof = z.infer<typeof MissionControlProofSchema>;

export const MissionControlEventSchema = z.object({
  id: z.string(), // "mce_" + ulid
  ts: z.string(), // ISO
  agentId: z.string(),
  agentTitle: z.string(),
  kind: MissionControlEventKindSchema,
  // self: reported by the agent itself via report_milestone. autopilot:
  // verdicts from the autopilot evaluator. Additive; older payloads without
  // them still parse (source is required, existing values unchanged).
  source: z.enum(["system", "summarizer", "self", "autopilot"]),
  severity: z.enum(["info", "attention", "blocker"]),
  headline: z.string(), // ≤ 120 chars, plain language
  detail: z.string().optional(),
  proof: z.array(MissionControlProofSchema).optional(),
  supersedesId: z.string().optional(), // coalescing chain
  coalescedCount: z.number().optional(),
});
export type MissionControlEvent = z.infer<typeof MissionControlEventSchema>;

export const MissionControlPeerStatusSchema = z.object({
  name: z.string(), // config name, e.g. "macbook"
  url: z.string(),
  state: z.enum(["online", "unreachable"]),
  lastSeenAt: z.string().nullable(), // for "unreachable since 12:03, likely asleep"
});
export type MissionControlPeerStatus = z.infer<typeof MissionControlPeerStatusSchema>;

export const MissionControlEventsFetchRequestSchema = z.object({
  type: z.literal("mission_control.events.fetch.request"),
  requestId: z.string(),
  sinceTs: z.string().optional(),
  limit: z.number().int().optional(),
});
export type MissionControlEventsFetchRequest = z.infer<
  typeof MissionControlEventsFetchRequestSchema
>;

export const MissionControlEventsFetchResponseSchema = z.object({
  type: z.literal("mission_control.events.fetch.response"),
  payload: z.object({
    requestId: z.string(),
    events: z.array(MissionControlEventSchema),
  }),
});
export type MissionControlEventsFetchResponse = z.infer<
  typeof MissionControlEventsFetchResponseSchema
>;

export const MissionControlEventsAckRequestSchema = z.object({
  type: z.literal("mission_control.events.ack.request"),
  requestId: z.string(),
  eventIds: z.array(z.string()),
});
export type MissionControlEventsAckRequest = z.infer<typeof MissionControlEventsAckRequestSchema>;

export const MissionControlEventsAckResponseSchema = z.object({
  type: z.literal("mission_control.events.ack.response"),
  payload: z.object({
    requestId: z.string(),
  }),
});
export type MissionControlEventsAckResponse = z.infer<typeof MissionControlEventsAckResponseSchema>;

export const MissionControlPeersListRequestSchema = z.object({
  type: z.literal("mission_control.peers.list.request"),
  requestId: z.string(),
});
export type MissionControlPeersListRequest = z.infer<typeof MissionControlPeersListRequestSchema>;

export const MissionControlPeersListResponseSchema = z.object({
  type: z.literal("mission_control.peers.list.response"),
  payload: z.object({
    requestId: z.string(),
    peers: z.array(MissionControlPeerStatusSchema),
  }),
});
export type MissionControlPeersListResponse = z.infer<typeof MissionControlPeersListResponseSchema>;

// Server → client push on every new mission control event. Not a request/response pair.
export const MissionControlEventMessageSchema = z.object({
  type: z.literal("mission_control_event"),
  event: MissionControlEventSchema,
});
export type MissionControlEventMessage = z.infer<typeof MissionControlEventMessageSchema>;

// ============================================================================
// Context pack RPC — every daemon serves it; the Commander-host daemon
// aggregates it over peers so the Commander's worldview is one fetch per host.
// ============================================================================

export const MissionControlInventoryProjectWorkspaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  cwd: z.string(),
  kind: z.string(), // worktree | directory | local_checkout
});
export type MissionControlInventoryProjectWorkspace = z.infer<
  typeof MissionControlInventoryProjectWorkspaceSchema
>;

export const MissionControlInventoryProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  hostServerId: z.string(),
  workspaces: z.array(MissionControlInventoryProjectWorkspaceSchema),
});
export type MissionControlInventoryProject = z.infer<typeof MissionControlInventoryProjectSchema>;

export const MissionControlInventorySchema = z.object({
  projects: z.array(MissionControlInventoryProjectSchema),
});
export type MissionControlInventory = z.infer<typeof MissionControlInventorySchema>;

// Models per provider: provider name → available model ids. Pure wire shape;
// enrichment (labels, thinking options, role defaults) stays server-side.
export const MissionControlModelsSchema = z.record(z.string(), z.array(z.string()));
export type MissionControlModels = z.infer<typeof MissionControlModelsSchema>;

// Roster entry: recent and running agents with their identity fields. All
// identity fields optional so older daemons/records degrade gracefully.
export const MissionControlContextAgentSummarySchema = z.object({
  agentId: z.string(),
  hostServerId: z.string(),
  name: z.string().optional(),
  title: z.string().nullable().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
});
export type MissionControlContextAgentSummary = z.infer<
  typeof MissionControlContextAgentSummarySchema
>;

export const MissionControlContextFetchRequestSchema = z.object({
  type: z.literal("mission_control.context.fetch.request"),
  requestId: z.string(),
});
export type MissionControlContextFetchRequest = z.infer<
  typeof MissionControlContextFetchRequestSchema
>;

export const MissionControlContextFetchResponseSchema = z.object({
  type: z.literal("mission_control.context.fetch.response"),
  payload: z.object({
    requestId: z.string(),
    inventory: MissionControlInventorySchema,
    models: MissionControlModelsSchema,
    recentAgents: z.array(MissionControlContextAgentSummarySchema),
  }),
});
export type MissionControlContextFetchResponse = z.infer<
  typeof MissionControlContextFetchResponseSchema
>;
