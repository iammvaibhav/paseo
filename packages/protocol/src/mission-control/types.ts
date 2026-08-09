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
  // v3.1: a run superseded by a USER prompt (interrupt-and-send) — distinct
  // from "failed" so the feed renders the user's interruption with a
  // non-error tone while genuine failures keep the failure card.
  "interrupted",
  // M4: Commander interaction cards. "clarification" is a structured question
  // with options (+ optional free text) the Commander cannot resolve alone
  // (which of two ambiguous targets, a user-private fact); "answer" is a
  // structured fleet answer (agent status, generic) rendered with feed-card
  // components instead of prose. Both are cards TO the user, never side
  // effects on the fleet — they are not approval-gated.
  "clarification",
  "answer",
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
  description: z.string().optional(), // living 2-3 sentence description, ~400 chars (same rule)
  proofs: z.array(MissionControlProofSchema).optional(),
});
export type MissionControlReportStatusInput = z.infer<typeof MissionControlReportStatusInputSchema>;

/**
 * How a machinery dispatch reaches a busy agent. "steer" injects into the
 * live turn without cancelling (native OMP live-steer; a busy non-OMP agent
 * is interrupted so the message lands promptly); "queue" waits for idle
 * before streaming; "interrupt" cancels the running turn and replaces it.
 * Widened to include "queue" when verifierToWorkerMode/commanderToWorkerMode
 * gained the full union.
 */
export const MissionControlDeliveryModeSchema = z.enum(["steer", "interrupt", "queue"]);
export type MissionControlDeliveryMode = z.infer<typeof MissionControlDeliveryModeSchema>;

/**
 * Approval-gate proposal: an outbound send from mission-control machinery
 * (verifier contact, stall nudge, commander digest-initiated steer) awaiting
 * user approval in Ask mode, or logged as sent in Auto mode. Cards ride the
 * feed as kind:"proposal" events (supersede-chain per proposal id).
 */
/**
 * What a spawn-kind proposal would create, shown on the card so approving is
 * informed (host, provider/model, brief). The reconstruction fields are the
 * serialized create input the daemon executes when the proposal resolves —
 * they ride the wire so a pending spawn proposal survives a daemon restart.
 */
export const MissionControlProposalSpawnPlanSchema = z.object({
  // Fleet host for fleet_create_agent; absent or "local" = this daemon.
  host: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  title: z.string().optional(),
  // One-line plain-language summary of what would be spawned (card copy).
  summary: z.string(),
  // Reconstruction payload (server-internal; not rendered by the app).
  initialPrompt: z.string().optional(),
  cwd: z.string().optional(),
  workspaceId: z.string().optional(),
  thinking: z.string().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  mode: z.string().optional(),
  background: z.boolean().optional(),
  detached: z.boolean().optional(),
  worktree: z
    .object({
      worktreeName: z.string().optional(),
      branchName: z.string().optional(),
      baseBranch: z.string().optional(),
      refName: z.string().optional(),
      action: z.enum(["branch-off", "checkout"]).optional(),
      githubPrNumber: z.number().optional(),
    })
    .optional(),
});
export type MissionControlProposalSpawnPlan = z.infer<typeof MissionControlProposalSpawnPlanSchema>;

/**
 * What a meta-kind proposal would change (M4/M5): a fleet meta action —
 * rename/archive a project, workspace, or agent; create a project; move an
 * agent to another workspace; promote an experiment workspace to its own
 * project. All target fields optional strings so the payload carries exactly
 * the identifying fields each action needs; the daemon validates the plan
 * against live fleet state when the proposal resolves (fleet_meta tool) or
 * when it is applied (metaFromProposal hook). `serverId` names the host the
 * action applies to ("local" or a peer name, same convention as the fleet
 * tools); `destination` is the target workspace id for move_agent /
 * promote_workspace and the parent project id for create_project.
 */
export const MissionControlProposalMetaPlanActionSchema = z.enum([
  "rename_project",
  "rename_workspace",
  "rename_agent_title",
  "archive_project",
  "archive_workspace",
  "archive_agent",
  "create_project",
  "move_agent",
  "promote_workspace",
]);
export type MissionControlProposalMetaPlanAction = z.infer<
  typeof MissionControlProposalMetaPlanActionSchema
>;

export const MissionControlMetaPlanSchema = z.object({
  action: MissionControlProposalMetaPlanActionSchema,
  serverId: z.string().optional(),
  targetId: z.string().optional(),
  targetLabel: z.string().optional(),
  newValue: z.string().optional(),
  destination: z.string().optional(),
});
export type MissionControlMetaPlan = z.infer<typeof MissionControlMetaPlanSchema>;

export const MissionControlProposalSchema = z.object({
  id: z.string(), // "mcp_" + ulid
  createdAt: z.string(), // ISO
  origin: z.enum(["verifier", "commander", "stall"]),
  serverId: z.string(), // host the target agent runs on
  targetAgentId: z.string(),
  message: z.string(),
  deliveryMode: MissionControlDeliveryModeSchema,
  reason: z.string(),
  classification: z.enum(["normal", "destructive"]),
  status: z.enum(["pending", "approved", "denied", "sent", "expired", "undelivered"]),
  // "send" (default, absent = send): deliver `message` to the target agent.
  // "spawn": create a NEW agent described by spawnPlan instead of sending.
  // "meta": apply a fleet meta action (rename/archive/move/create/promote)
  // described by metaPlan instead of sending.
  kind: z.enum(["send", "spawn", "meta"]).optional(),
  // Present when kind === "spawn": what would be created (card copy + the
  // reconstruction payload). Approving (or auto mode) executes the spawn.
  spawnPlan: MissionControlProposalSpawnPlanSchema.optional(),
  // Present when kind === "meta": the fleet meta action the proposal would
  // apply (rename/archive project·workspace·agent, create project, move
  // agent, promote workspace). Approving (or auto mode) executes the action
  // through the metaFromProposal hook. Card copy derives from action +
  // targetId/targetLabel + newValue/destination; the app renders it as a
  // meta card, never as a message send.
  metaPlan: MissionControlMetaPlanSchema.optional(),
  // Set on a meta-kind proposal once the action APPLIED: the resolved host
  // the action ran on ("local" or the peer name), stamped by the gate after
  // applyMetaFromProposal routes it (cross-host meta applies hop to the peer;
  // the card must record where the change actually happened). Additive —
  // absent on older records and on failures.
  metaAppliedOnHost: z.string().optional(),
  // Set on a spawn proposal once the spawn executed (approve or auto mode).
  spawnedAgentId: z.string().optional(),
  // Verifier-origin attribution: the ephemeral verifier agent driving this
  // proposal/exchange, so the app can drill from the card into its thread.
  verifierAgentId: z.string().optional(),
  allowPair: z.boolean().optional(),
  // Machinery-only audit trail (stall status-ask nudges): the card renders in
  // verbose mode only; the auto-sent proposal record + log stay. Additive —
  // absent on every normal-mode card (escalation, verifier, commander).
  verboseOnly: z.boolean().optional(),
  // How the delivered prompt classifies on the target agent's own timeline
  // row: "machinery" (status asks — stall nudges) vs "instruction" (Commander
  // direction changes, Verifier proof demands, recovery). Absent = instruction
  // (visible). Additive; the feed's verboseOnly gating is independent.
  timelineClassification: z.enum(["machinery", "instruction"]).optional(),
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
  // Living short description snapshot frozen at emit time (immutable card copy).
  // Optional for wire/record back-compat: legacy rows without it fall back to headline.
  shortDescription: z.string().optional(),
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
  // Run-scoped coalescing: the agent's run epoch at emit time (absent on
  // pre-upgrade rows). A `started` event — or a daemon restart — bumps the
  // agent's epoch; (agentId, kind) chains coalesce only within one epoch, so
  // a finish never inherits detail/proofs from a previous run's completion.
  runEpoch: z.number().optional(),
  // Full proposal payload when kind === "proposal". Status changes append a
  // new proposal event superseding the previous one for the same proposal id.
  proposal: MissionControlProposalSchema.optional(),
  // M4: structured question card (kind "clarification"). The Commander cannot
  // resolve which agent/workspace/project you mean, or the missing fact is
  // one only you know. The app renders the question with the options as
  // buttons plus a free-text input when allowFreeText is true; the user's
  // choice is sent back as a normal user message to the Commander thread —
  // there is NO separate response RPC. Additive; absent on every other card.
  clarification: z
    .object({
      question: z.string(),
      options: z.array(z.string()),
      allowFreeText: z.boolean(),
    })
    .optional(),
  // M4: structured fleet answer card (kind "answer"). Fleet questions the
  // Commander answered — an agent-status answer renders name, host chip,
  // state, last report, proofs (the same components as feed cards, so answers
  // feel native); "generic" answers are free text plus optional labeled
  // fields. Additive; absent on every other card.
  answer: z
    .object({
      kind: z.enum(["agent_status", "generic"]),
      agentId: z.string().optional(),
      headline: z.string(),
      body: z.string().optional(),
      fields: z
        .array(
          z.object({
            label: z.string(),
            value: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Verifier-origin attribution (verdict cards + verification-failed cards):
  // the ephemeral verifier agent whose audit produced this card. Clicking the
  // card drills into that agent's thread in the Mission Control inspector
  // (verifiers stay hidden from board buckets but are reachable from their
  // card). Additive; absent on cards without a verifier.
  verifierAgentId: z.string().optional(),
  // Machinery-only card: rendered ONLY in verbose mode (stall status-ask
  // nudges). Absent on normal-mode cards — the app must not render this card
  // in the default feed. Mirrors proposal.verboseOnly; additive.
  verboseOnly: z.boolean().optional(),
  // Original report_status kind (finding/fix/milestone/decision/progress) on
  // source:"self" events, preserved for distinct card icons even though the
  // feed collapses progress|milestone → kind "milestone" and finding|fix|
  // decision → kind "finding". Additive; absent when not a self-report.
  reportKind: MissionControlReportKindSchema.optional(),
  // Stop origin snapshotted at emit time: who cancelled the agent's last run
  // when this event was recorded ("user" = the user stopped it, "machinery" =
  // a steer/replace superseded it, "system" = provider crash/watchdog). The
  // board's Done/Ready/Dormant rows render this snapshot, never the live
  // directory stoppedBy. Additive; absent when no stop was in effect at emit
  // time (a fresh run clears the origin before its `started` event).
  stoppedBy: z.enum(["user", "machinery", "system"]).optional(),
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
    // Additive: mirrors MissionControlConfigPatchResponseSchema — set when a
    // non-owner host forwarded the mode change to the designated commander
    // host and it was unreachable (the change was NOT applied anywhere).
    unreachableCommanderHost: z.string().optional(),
  }),
});
export type MissionControlModeSetResponse = z.infer<typeof MissionControlModeSetResponseSchema>;

// ============================================================================
// v3 central config: fleet policy stored on the commander host, edited from
// anywhere via mission_control.config.get/patch. All keys optional so a patch
// is a partial and old payloads parse; the daemon resolves defaults server-side.
// ============================================================================

export const MissionControlCentralConfigSchema = z.object({
  // Designated commander host (daemon hostname, host alias, or "local"); ONLY
  // the designated host boot-ensures the Commander. Null = NO host is
  // designated — no daemon may self-designate (live incident: every host
  // spawned its own Commander because null read as "local is designated").
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
  // Dormant-turn detector: seconds a running agent may sit with NO timeline
  // output AND no tool call in flight before the turn is treated as wedged
  // (omp loop-advance failure) and recovered via the interrupt path. Default
  // 300 (5 min). The floor is set by the slowest legitimate MODEL call
  // (178.6s max of 8242 samples; one 727k-token call took 48s TTFT + 54s) —
  // Paseo cannot observe a model request in flight (it lives inside omp and
  // produces no timeline rows), so values under ~4 min risk false positives.
  dormantTurnSeconds: z.number().optional(),
  // Default delivery mode for commander-origin sends (fleet_send_prompt when
  // the Commander omits `mode`). "interrupt" = timely direction change; an
  // explicit `mode` argument from the Commander always wins. Stall nudges are
  // NOT affected — they stay native steer regardless.
  commanderToWorkerMode: MissionControlDeliveryModeSchema.optional(),
  // Default delivery mode for verifier-origin contacts (contact_worker /
  // proof demands). Same union; stall nudges unaffected.
  verifierToWorkerMode: MissionControlDeliveryModeSchema.optional(),
  // M6 context architecture: the Hindsight fleet memory bank. hindsightUrl
  // unset (null) = disabled — run records stay local only; the fleet_recall
  // tool degrades to "memory unavailable". hindsightBank names the bank run
  // records are written to and recalled over (default "paseo-fleet").
  hindsightUrl: z.string().nullable().optional(),
  hindsightBank: z.string().optional(),
  // Read-only secondary recall source: the omp hindsight bank (transcript
  // memories, default "omp"). fleet_recall consults it additively behind the
  // primary bank; it is NEVER written to — the write path stays pointed at
  // hindsightBank only. Null disables the secondary source.
  hindsightSecondaryBank: z.string().nullable().optional(),
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
    // Additive: set when the receiving daemon is NOT the designated commander
    // host, forwarded the patch to it, and the commander host was unreachable.
    // The patch is never applied locally in that case (the daemon must not
    // fork central config); the app surfaces this as a distinct
    // "commander host unreachable" error instead of a generic failure.
    unreachableCommanderHost: z.string().optional(),
  }),
});
export type MissionControlConfigPatchResponse = z.infer<
  typeof MissionControlConfigPatchResponseSchema
>;

// ============================================================================
// Central-config replication (commander host -> peers). One-way sync message,
// NOT a request/response pair: the commander host pushes a full snapshot after
// every patch (and on peer connect, sync-on-connect); the receiving daemon
// replaces its local central-config.json + in-memory store (last-writer-wins)
// so every host's consumers (stall detector, hindsight writer, verifier) read
// the same fleet policy. Additive wire message; older daemons that never send
// it are unaffected, and a daemon that cannot handle it would simply not
// parse it (the session dispatcher must exist on the receiving side).
// ============================================================================

export const MissionControlConfigReplicaSchema = z.object({
  type: z.literal("mission_control.config.replica"),
  // Sender host identity for logging; additive.
  from: z.string().optional(),
  // FULL central-config snapshot (all keys optional on the wire; the sender
  // sends its resolved config). Receivers replace, never merge.
  config: MissionControlCentralConfigSchema,
});
export type MissionControlConfigReplica = z.infer<typeof MissionControlConfigReplicaSchema>;

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

// ============================================================================
// v5 cross-host meta apply: the Commander-host daemon routes an approved
// meta-kind proposal (fleet_meta) whose metaPlan.serverId names a PEER to
// that peer over this RPC instead of applying on the commander host. The
// receiving daemon re-validates the plan against ITS OWN registries and
// applies it there; only the APPLY hops — the proposal/card lives on the
// commander host (gate unchanged). Mirrors the fleet_create_agent peer path
// (peer-manager getPeerClient → correlated session request).
// ============================================================================

export const MissionControlMetaApplyRequestSchema = z.object({
  type: z.literal("mission_control.meta.apply.request"),
  requestId: z.string(),
  // The validated-shape meta plan as the Commander sent it (schema-validated
  // at the tool boundary). The receiving daemon validates it against its own
  // registries before applying — never trusts it blindly.
  metaPlan: MissionControlMetaPlanSchema,
});
export type MissionControlMetaApplyRequest = z.infer<typeof MissionControlMetaApplyRequestSchema>;

export const MissionControlMetaApplyResponseSchema = z.object({
  type: z.literal("mission_control.meta.apply.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    summary: z.string().optional(),
    // The applying daemon's own identity, so the commander's audit trail can
    // record WHERE the action actually ran (peer name → server id / host
    // name). Additive; absent on failure.
    serverId: z.string().optional(),
    hostName: z.string().optional(),
  }),
});
export type MissionControlMetaApplyResponse = z.infer<typeof MissionControlMetaApplyResponseSchema>;
