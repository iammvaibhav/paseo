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
  // v3: proposal cards (approval gate) and verdict cards (verifier/user review).
  "proposal",
  "verdict",
]);
export type MissionControlEventKind = z.infer<typeof MissionControlEventKindSchema>;

/**
 * Original `report_status` kind, kept on the emitted event so the app can
 * icon progress vs milestone vs finding vs fix vs decision distinctly even
 * though the feed collapses them onto the milestone/finding card kinds.
 * Additive; absent on events that are not report_status self-reports.
 */
export const MissionControlReportKindSchema = z.enum([
  "finding",
  "fix",
  "milestone",
  "decision",
  "progress",
]);
export type MissionControlReportKind = z.infer<typeof MissionControlReportKindSchema>;

/**
 * Proof attached to a report_status self-report or a summarizer card. Spec
 * kinds are image|video|api|code|pr|url; the legacy diff/command kinds and
 * additions/deletions/exitCode fields stay accepted so old persisted events
 * and old daemons keep parsing (protocol additive only).
 */
export const MissionControlProofSchema = z.object({
  kind: z.enum(["url", "image", "diff", "command", "video", "api", "code", "pr"]),
  url: z.string().optional(),
  path: z.string().optional(),
  label: z.string().optional(),
  // Inline content for api/code proofs (spec).
  excerpt: z.string().optional(),
  // Legacy diff/command fields; retained for old payloads.
  additions: z.number().optional(),
  deletions: z.number().optional(),
  exitCode: z.number().optional(),
});
export type MissionControlProof = z.infer<typeof MissionControlProofSchema>;

/**
 * ReportStatusInput: the `report_status` MCP tool schema every worker agent
 * gets. Replaces report_milestone (clean cutover; the old tool name is deleted
 * daemon-side). Pure wire shape; headline length (<=120) is enforced by the
 * tool implementation, not the schema.
 */
export const MissionControlReportStatusInputSchema = z.object({
  status: z.enum(["working", "completed", "inconclusive", "blocked"]),
  headline: z.string(), // <= 120 chars, plain language
  detail: z.string().optional(), // 1-2 sentences
  kind: MissionControlReportKindSchema.optional(),
  title: z.string().optional(), // ONLY when the agent decides its title changed
  description: z.string().optional(), // living short description, same rule
  proofs: z.array(MissionControlProofSchema).optional(),
});
export type MissionControlReportStatusInput = z.infer<typeof MissionControlReportStatusInputSchema>;

/**
 * Approval-gate proposal: an outbound send from mission-control machinery
 * (verifier contact, stall nudge, commander digest-initiated steer) awaiting
 * user approval in Ask mode, or logged as sent in Auto mode. Cards ride the
 * feed as kind:"proposal" events (supersede-chain per proposal id).
 */
export const MissionControlProposalSchema = z.object({
  id: z.string(), // "mcp_" + ulid
  createdAt: z.string(), // ISO
  origin: z.enum(["verifier", "commander", "stall"]),
  serverId: z.string(), // host the target agent runs on
  targetAgentId: z.string(),
  message: z.string(),
  deliveryMode: z.enum(["steer", "interrupt"]),
  reason: z.string(),
  classification: z.enum(["normal", "destructive"]),
  status: z.enum(["pending", "approved", "denied", "sent", "expired"]),
  allowPair: z.boolean().optional(),
  // Machinery-only audit trail (stall status-ask nudges): the card renders in
  // verbose mode only; the auto-sent proposal record + log stay. Additive —
  // absent on every normal-mode card (escalation, verifier, commander).
  verboseOnly: z.boolean().optional(),
});
export type MissionControlProposal = z.infer<typeof MissionControlProposalSchema>;

export const MissionControlEventSchema = z.object({
  id: z.string(), // "mce_" + ulid
  ts: z.string(), // ISO
  // Monotonic sequence for cursor paging (mission_control.events.fetch
  // beforeSeq). Older persisted events predate the field and sort as seq -1.
  seq: z.number().optional(),
  agentId: z.string(),
  agentTitle: z.string(),
  kind: MissionControlEventKindSchema,
  // self: reported by the agent itself via report_status. autopilot:
  // verdicts from the autopilot evaluator. verifier: verdict cards from the
  // ephemeral verifier agents. Additive; older payloads without them still
  // parse (source is required, existing values unchanged).
  source: z.enum(["system", "summarizer", "self", "autopilot", "verifier"]),
  severity: z.enum(["info", "attention", "blocker"]),
  headline: z.string(), // ≤ 120 chars, plain language
  detail: z.string().optional(),
  proof: z.array(MissionControlProofSchema).optional(),
  supersedesId: z.string().optional(), // coalescing chain
  coalescedCount: z.number().optional(),
  // Full proposal payload when kind === "proposal". Status changes append a
  // new proposal event superseding the previous one for the same proposal id.
  proposal: MissionControlProposalSchema.optional(),
  // Machinery-only card: rendered ONLY in verbose mode (stall status-ask
  // nudges). Absent on normal-mode cards — the app must not render this card
  // in the default feed. Mirrors proposal.verboseOnly; additive.
  verboseOnly: z.boolean().optional(),
  // Original report_status kind (finding/fix/milestone/decision/progress) on
  // source:"self" events, preserved for distinct card icons even though the
  // feed collapses progress|milestone → kind "milestone" and finding|fix|
  // decision → kind "finding". Additive; absent when not a self-report.
  reportKind: MissionControlReportKindSchema.optional(),
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
  // Cursor paging (v3): return events strictly older than this sequence.
  beforeSeq: z.number().int().optional(),
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

// ============================================================================
// v3 lifecycle: mark done / clear / reopen. reviewState is persisted in the
// mission-control store; verdict records who closed the item and why.
// ============================================================================

export const MissionControlLifecycleActionSchema = z.enum(["done", "clear", "reopen"]);
export type MissionControlLifecycleAction = z.infer<typeof MissionControlLifecycleActionSchema>;

export const MissionControlLifecycleSetRequestSchema = z.object({
  type: z.literal("mission_control.lifecycle.set.request"),
  requestId: z.string(),
  serverId: z.string(), // host the agent runs on
  agentId: z.string(),
  action: MissionControlLifecycleActionSchema,
});
export type MissionControlLifecycleSetRequest = z.infer<
  typeof MissionControlLifecycleSetRequestSchema
>;

export const MissionControlLifecycleSetResponseSchema = z.object({
  type: z.literal("mission_control.lifecycle.set.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
export type MissionControlLifecycleSetResponse = z.infer<
  typeof MissionControlLifecycleSetResponseSchema
>;

// ============================================================================
// v3 approval gate: respond to a proposal card (approve/deny, optional edit).
// ============================================================================

export const MissionControlProposalsRespondRequestSchema = z.object({
  type: z.literal("mission_control.proposals.respond.request"),
  requestId: z.string(),
  proposalId: z.string(),
  action: z.enum(["approve", "deny"]),
  // Optional message rewrite before send (approve with edits).
  editedMessage: z.string().optional(),
  // Grant allow-pair: the rest of this verifier<->worker exchange auto-approves.
  allowPair: z.boolean().optional(),
});
export type MissionControlProposalsRespondRequest = z.infer<
  typeof MissionControlProposalsRespondRequestSchema
>;

export const MissionControlProposalsRespondResponseSchema = z.object({
  type: z.literal("mission_control.proposals.respond.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
export type MissionControlProposalsRespondResponse = z.infer<
  typeof MissionControlProposalsRespondResponseSchema
>;

// ============================================================================
// v3 proposal cards from the one-time naming backfill: the script emits ONE
// commander-origin, normal-classification card listing workspace rename
// proposals ('old -> new'). Never auto-sends: the card always lands pending
// (approving steers the target, applying renames is a separate manual step).
// ============================================================================

export const MissionControlProposalsCreateRequestSchema = z.object({
  type: z.literal("mission_control.proposals.create.request"),
  requestId: z.string(),
  message: z.string().min(1),
  reason: z.string().optional(),
  // Target agent for the card's chip + approve delivery. Defaults to the
  // Commander when omitted.
  targetAgentId: z.string().nullable().optional(),
});
export type MissionControlProposalsCreateRequest = z.infer<
  typeof MissionControlProposalsCreateRequestSchema
>;

export const MissionControlProposalsCreateResponseSchema = z.object({
  type: z.literal("mission_control.proposals.create.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    proposalId: z.string().optional(),
  }),
});
export type MissionControlProposalsCreateResponse = z.infer<
  typeof MissionControlProposalsCreateResponseSchema
>;

// ============================================================================
// v3 ask/auto mode toggle (Mission Control screen header, RPC-backed).
// ============================================================================

export const MissionControlModeSchema = z.enum(["ask", "auto"]);
export type MissionControlMode = z.infer<typeof MissionControlModeSchema>;

export const MissionControlModeSetRequestSchema = z.object({
  type: z.literal("mission_control.mode.set.request"),
  requestId: z.string(),
  mode: MissionControlModeSchema,
});
export type MissionControlModeSetRequest = z.infer<typeof MissionControlModeSetRequestSchema>;

export const MissionControlModeSetResponseSchema = z.object({
  type: z.literal("mission_control.mode.set.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
export type MissionControlModeSetResponse = z.infer<typeof MissionControlModeSetResponseSchema>;

// ============================================================================
// v3 central config: fleet policy stored on the commander host, edited from
// anywhere via mission_control.config.get/patch. All keys optional so a patch
// is a partial and old payloads parse; the daemon resolves defaults server-side.
// ============================================================================

export const MissionControlCentralConfigSchema = z.object({
  // Designated commander host (host alias); boot ensures the Commander exists
  // there. Null = this host designates itself when no other is set.
  commanderHost: z.string().nullable().optional(),
  // Commander model override; default = host default omp model.
  commanderModel: z.string().nullable().optional(),
  // Commander persona/playbook; default = shipped DEFAULT_COMMANDER_CONTRACT.
  commanderInstructions: z.string().optional(),
  // Verifier model override; resolution: @verifier -> @task -> host default.
  verifierModel: z.string().nullable().optional(),
  // Concurrent verifier spawns per host.
  verifierConcurrency: z.number().optional(),
  // Verify commander-spawned only, or all agents.
  evaluationScope: z.enum(["commander", "all"]).optional(),
  // Approval gate mode: ask (default) or auto.
  mode: MissionControlModeSchema.optional(),
  // Event retention window for pruning.
  retentionDays: z.number().optional(),
  // Fleet naming theme; re-map is broadcast on switch.
  namingTheme: z.string().optional(),
  // Hide agent name chips, leaving titles.
  hideAgentNames: z.boolean().optional(),
  // Preferred host when the Commander routes work.
  defaultDispatchHost: z.string().nullable().optional(),
  // Stall detection thresholds (seconds). Two nudge triggers share one
  // action: silenceNudgeSeconds (no timeline output at all) and
  // statusNudgeSeconds (no report_status even with timeline flowing).
  // nudgeSeconds is the deprecated pre-rename alias for statusNudgeSeconds.
  silenceNudgeSeconds: z.number().optional(),
  statusNudgeSeconds: z.number().optional(),
  nudgeSeconds: z.number().optional(),
  escalateSeconds: z.number().optional(),
});
export type MissionControlCentralConfig = z.infer<typeof MissionControlCentralConfigSchema>;

export const MissionControlConfigGetRequestSchema = z.object({
  type: z.literal("mission_control.config.get.request"),
  requestId: z.string(),
});
export type MissionControlConfigGetRequest = z.infer<typeof MissionControlConfigGetRequestSchema>;

export const MissionControlConfigGetResponseSchema = z.object({
  type: z.literal("mission_control.config.get.response"),
  payload: z.object({
    requestId: z.string(),
    config: MissionControlCentralConfigSchema,
  }),
});
export type MissionControlConfigGetResponse = z.infer<typeof MissionControlConfigGetResponseSchema>;

export const MissionControlConfigPatchRequestSchema = z.object({
  type: z.literal("mission_control.config.patch.request"),
  requestId: z.string(),
  patch: MissionControlCentralConfigSchema.partial(),
});
export type MissionControlConfigPatchRequest = z.infer<
  typeof MissionControlConfigPatchRequestSchema
>;

export const MissionControlConfigPatchResponseSchema = z.object({
  type: z.literal("mission_control.config.patch.response"),
  payload: z.object({
    requestId: z.string(),
    config: MissionControlCentralConfigSchema,
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
export type MissionControlConfigPatchResponse = z.infer<
  typeof MissionControlConfigPatchResponseSchema
>;

// ============================================================================
// v3 Commander reset: archive the current Commander (old conversation stays in
// History) and spawn fresh with a new context pack. Exposed in the thread
// overflow menu.
// ============================================================================

export const MissionControlCommanderResetRequestSchema = z.object({
  type: z.literal("mission_control.commander.reset.request"),
  requestId: z.string(),
});
export type MissionControlCommanderResetRequest = z.infer<
  typeof MissionControlCommanderResetRequestSchema
>;

export const MissionControlCommanderResetResponseSchema = z.object({
  type: z.literal("mission_control.commander.reset.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
export type MissionControlCommanderResetResponse = z.infer<
  typeof MissionControlCommanderResetResponseSchema
>;

// ============================================================================
// v3 fleet search: tiered search over identity/brief/reports/transcript on a
// peer host, proxied over peering (SearchSlice). The daemon that receives the
// request runs the local search and stamps host; the caller aggregates.
// ============================================================================

export const MissionControlSearchMatchSchema = z.object({
  host: z.string(), // host alias/name the match was found on
  agentId: z.string(),
  name: z.string().optional(),
  title: z.string().nullable(),
  status: z.string().optional(),
  matchedIn: z.enum(["identity", "brief", "reports", "transcript"]),
  snippet: z.string(),
});
export type MissionControlSearchMatch = z.infer<typeof MissionControlSearchMatchSchema>;

export const MissionControlSearchRequestSchema = z.object({
  type: z.literal("mission_control.search.request"),
  requestId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  // Deep search (transcript scanning) is more expensive; default shallow.
  deep: z.boolean().optional(),
});
export type MissionControlSearchRequest = z.infer<typeof MissionControlSearchRequestSchema>;

export const MissionControlSearchResponseSchema = z.object({
  type: z.literal("mission_control.search.response"),
  payload: z.object({
    requestId: z.string(),
    matches: z.array(MissionControlSearchMatchSchema),
    error: z.string().optional(),
  }),
});
export type MissionControlSearchResponse = z.infer<typeof MissionControlSearchResponseSchema>;

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
  // Roster one-liner fields: the agent's last self-reported headline and the
  // timestamp of its latest activity (age). Optional; old daemons omit them.
  lastReportHeadline: z.string().optional(),
  lastActivityAt: z.string().optional(),
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
    // This host's own missionControl.hostAlias so the Commander assembles the
    // fleet map from per-host declarations. Old daemons omit it → host name.
    hostAlias: z.string().optional(),
  }),
});
export type MissionControlContextFetchResponse = z.infer<
  typeof MissionControlContextFetchResponseSchema
>;

// ============================================================================
// v3 proof media: authenticated file-fetch for cross-host proofs. The app
// resolves proof.path through this RPC (uniform path); the daemon serves
// local files for host "local" and proxies to the named peer otherwise. Size
// cap and mime allowlist are enforced server-side (ProofsSlice).
// ============================================================================

export const MissionControlMediaFetchRequestSchema = z.object({
  type: z.literal("mission_control.media.fetch.request"),
  requestId: z.string(),
  // "local" for this daemon, or a peer name from the daemon peers config.
  host: z.string().min(1),
  path: z.string().min(1),
});
export type MissionControlMediaFetchRequest = z.infer<typeof MissionControlMediaFetchRequestSchema>;

export const MissionControlMediaFetchResponseSchema = z.object({
  type: z.literal("mission_control.media.fetch.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    mimeType: z.string().optional(),
    fileName: z.string().optional(),
    sizeBytes: z.number().int().optional(),
    // Base64 file content when ok. Capped server-side (10MB) so the wire
    // payload stays bounded.
    data: z.string().optional(),
  }),
});
export type MissionControlMediaFetchResponse = z.infer<
  typeof MissionControlMediaFetchResponseSchema
>;
