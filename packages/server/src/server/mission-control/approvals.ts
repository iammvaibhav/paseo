import type { Logger } from "pino";
import type {
  MissionControlProposal,
  MissionControlProposal as Proposal,
  MissionControlProposalSpawnPlan,
} from "@getpaseo/protocol/mission-control/types";
import type { MissionControlPresenceSource } from "./presence.js";
import { generateProposalId, type MissionControlStore } from "./store.js";

/**
 * Proposals live 24h; after that a pending proposal expires and its card dims.
 */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Reply-marker envelope for verifier<->worker exchange. The daemon relays the
 * worker's next report_status/final-turn text back into the verifier session;
 * this marker is what the relay matches on.
 */
export const VERIFIER_CONTACT_MARKER = "paseo-verifier-contact";

export function formatVerifierContactMessage(verifierAgentId: string, message: string): string {
  return `<paseo-system>\n${VERIFIER_CONTACT_MARKER}:${verifierAgentId}\n\n${message}\n</paseo-system>`;
}

/** Extracts the verifier id from a reply-marked message, or null. */
export function parseVerifierContactMessage(message: string): { verifierAgentId: string } | null {
  const match = message.match(new RegExp(`${VERIFIER_CONTACT_MARKER}:(\\S+)`));
  return match ? { verifierAgentId: match[1] } : null;
}

export interface ProposalCreateInput {
  origin: "verifier" | "commander" | "stall";
  serverId: string;
  targetAgentId: string;
  message: string;
  // "queue" rides along for verifier/commander delivery settings; stall nudges
  // always create "steer".
  deliveryMode: "steer" | "interrupt" | "queue";
  reason: string;
  classification: "normal" | "destructive";
  allowPair?: boolean;
  /** Bypass the gate entirely: record as auto-sent ("sent") and deliver, never
   *  a pending card. Mode, presence, and user-stop do not apply. Used by the
   *  stall status-ask nudge (a steer that only asks for a status). */
  forceSend?: boolean;
  /** Machinery-only: the emitted card renders in verbose mode only. Carried
   *  onto the proposal record (audit trail) and the emitted event so the app
   *  can hide it in the normal feed. Absent → normal-mode card. */
  verboseOnly?: boolean;
  /**
   * How the delivered prompt classifies on the target agent's OWN timeline
   * row: "machinery" (status asks — stall nudges) vs "instruction"
   * (Commander direction changes, Verifier proof demands, recovery).
   * Absent = instruction (visible). Additive; the feed's verboseOnly gating
   * is independent.
   */
  timelineClassification?: "machinery" | "instruction";
  /**
   * "send" (default) delivers `message` to the target agent; "spawn" creates a
   * NEW agent from `spawnPlan` instead (Commander agent spawns, verifier
   * spawns). Both kinds flow through the same gate.
   */
  kind?: "send" | "spawn";
  /** What a spawn-kind proposal would create; required when kind === "spawn". */
  spawnPlan?: MissionControlProposalSpawnPlan;
  /** Verifier-origin attribution for card drill-in (verifier's agent id). */
  verifierAgentId?: string;
  /**
   * Allow-pair scope override. Defaults to the standard pair key
   * (serverId:targetAgentId). The verifier dispatcher sets it to the WORKER
   * pair key for worker→verifier reply proposals so a granted contact pair
   * covers the whole exchange in both directions.
   */
  allowPairKey?: string;
}

/**
 * Thrown by the deliver hook to abort a dispatch that must never happen.
 * Approvals treats it as a hard stop: the proposal is recorded "expired"
 * (never redelivered, never pending) instead of bouncing back to pending.
 */
export class ProposalDeliveryAborted extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: "user_stopped",
  ) {
    super(`Proposal delivery aborted: ${reason} for agent ${agentId}`);
    this.name = "ProposalDeliveryAborted";
  }
}

export interface ResolveProposalInput {
  proposalId: string;
  action: "approve" | "deny";
  /** Message rewrite before send (approve with edits). */
  editedMessage?: string;
  /** Grant allow-pair: the rest of this verifier<->worker exchange auto-approves. */
  allowPair?: boolean;
}

export interface MissionControlApprovalsOptions {
  store: MissionControlStore;
  presence: MissionControlPresenceSource;
  logger: Logger;
  getMode: () => "ask" | "auto";
  /**
   * Deliver an approved proposal to the target agent. Steer delivers without
   * interrupting a running turn (native OMP live-steer; a busy non-OMP agent
   * is interrupted so the message lands promptly); queue waits for idle;
   * interrupt replaces the running turn.
   */
  deliver: (input: {
    agentId: string;
    message: string;
    deliveryMode: "steer" | "interrupt" | "queue";
    /**
     * How the delivered prompt classifies on the target agent's own timeline
     * row: "machinery" (status asks — stall nudges) vs "instruction"
     * (Commander direction changes, Verifier proof demands, recovery).
     * Absent = instruction (visible). Carried from the proposal's
     * timelineClassification (verboseOnly stall nudges fall back to
     * machinery for legacy records).
     */
    classification?: "machinery" | "instruction";
    /**
     * The proposal being delivered (additive). Lets the wiring route a
     * verifier-origin proposal targeting the verifier itself (the worker→
     * verifier reply relay) to the verifier dispatcher, which must run the
     * turn to keep its turn-end tracking.
     */
    proposal?: Proposal;
  }) => Promise<void>;
  /**
   * Execute a spawn-kind proposal (kind === "spawn"): create the NEW agent the
   * proposal describes. Runs on approve (user-approved pending card) and on
   * auto-send in auto mode — the single execution path for both. Returns the
   * spawned agent id so the proposal can record it (spawnedAgentId).
   */
  spawn?: (
    proposal: Proposal,
  ) => Promise<{ ok: true; agentId?: string } | { ok: false; error: string }>;
  /**
   * Push a proposal-card event (kind "proposal"). Status changes append a new
   * event superseding the previous one for the same proposal. Returns the
   * emitted event so the caller can track supersede chains.
   */
  publishProposalEvent: (proposal: MissionControlProposal) => Promise<{ id: string }>;
}

export type ProposalChangeListener = (proposal: MissionControlProposal) => void;

/**
 * The ask-mode auto-send exemptions, evaluated as two separate named checks
 * at the call site (no shared predicate across the two rules — production
 * rule "no shared predicates").
 *
 * User decision, verbatim: "apart from nudge, everything should require my
 * approval in ask mode. Spinning up a new agent as well, everything."
 *
 * In ask mode a proposal sends WITHOUT user approval only when it is
 *   - the status-ask nudge (`forceSend`: the stall steer that merely asks for
 *     a report_status — auto-sent, in either mode), or
 *   - a message in a verifier<->worker exchange the user EXPLICITLY
 *     allow-paired (the first approved contact of the pair grants it).
 *
 * Everything else — Commander agent spawns, verifier spawns, verifier→worker
 * contacts, worker→verifier replies, Commander→worker sends, escalation and
 * recovery interrupts — waits for Approve/Edit/Deny in ask mode. In auto mode
 * they send immediately (see MissionControlApprovals.autoApproved); only
 * destructive classification, presence, and user-stop still force ask.
 */

/**
 * The stall status-ask nudge exemption (`forceSend`): a steer that merely
 * asks for a report_status is auto-sent in either mode and never sits
 * pending for approval.
 */
export function isForceSendNudge(input: Pick<ProposalCreateInput, "forceSend">): boolean {
  return input.forceSend === true;
}

/**
 * The verifier allow-pair exemption: a message in a verifier<->worker
 * exchange the user EXPLICITLY allow-paired auto-sends, even in ask mode.
 */
export function isAllowPairExempt(allowPairActive: boolean): boolean {
  return allowPairActive;
}

/**
 * The approval gate. Every outbound send from mission-control machinery
 * (verifier contacts, stall nudges, commander machinery steers) flows through
 * createProposal:
 *
 * - Ask mode (default): the proposal sits pending as a feed card until the
 *   user approves (optionally edited), denies, or it expires after 24h.
 * - Auto mode: proposals send immediately — EXCEPT destructive
 *   classification, a user viewing the target agent, or a user-stop on the
 *   target's last run: those always ask.
 * - forceSend: bypasses the gate entirely, recorded as "sent" and delivered —
 *   the stall status-ask nudge (a harmless steer asking for a report_status)
 *   never sits pending, in either mode.
 * - Allow-pair: the first approved verifier<->worker exchange can grant a pair
 *   that auto-approves the rest of that exchange, even in ask mode.
 *
 * Structured logs under module "mission-control", component "approvals".
 */
export class MissionControlApprovals {
  private readonly store: MissionControlStore;
  private readonly presence: MissionControlPresenceSource;
  private readonly logger: Logger;
  private readonly getMode: () => "ask" | "auto";
  private readonly deliver: MissionControlApprovalsOptions["deliver"];
  private readonly spawn: MissionControlApprovalsOptions["spawn"];
  private readonly publishProposalEvent: MissionControlApprovalsOptions["publishProposalEvent"];
  private readonly allowPairs = new Set<string>();
  private readonly listeners = new Set<ProposalChangeListener>();

  constructor(options: MissionControlApprovalsOptions) {
    this.store = options.store;
    this.presence = options.presence;
    this.logger = options.logger;
    this.getMode = options.getMode;
    this.deliver = options.deliver;
    this.spawn = options.spawn;
    this.publishProposalEvent = options.publishProposalEvent;
  }

  /**
   * True when a proposal sends immediately instead of asking. Destructive
   * actions, a user viewing the target, and user-stop conflicts always ask —
   * even in auto mode. In ask mode, ONLY the two explicit exemptions apply
   * (status-ask nudge via isForceSendNudge / user-granted allow-pair via
   * isAllowPairExempt): everything else waits.
   */
  private autoApproved(input: ProposalCreateInput): boolean {
    if (input.classification === "destructive") {
      return false;
    }
    if (this.presence.isAgentFocused(input.targetAgentId)) {
      return false;
    }
    if (this.presence.getStoppedBy(input.targetAgentId) === "user") {
      return false;
    }
    if (this.getMode() === "auto") {
      return true;
    }
    // Ask mode: only the explicit exemptions auto-send, evaluated as two
    // separate named checks (isForceSendNudge / isAllowPairExempt). A granted
    // allow-pair covers the whole exchange; the pair scope defaults to
    // serverId:targetAgentId and may be overridden (worker pair for
    // worker→verifier reply proposals).
    const pairKey = input.allowPairKey ?? this.pairKey(input.serverId, input.targetAgentId);
    const allowPairActive = this.allowPairs.has(pairKey);
    return isForceSendNudge(input) || isAllowPairExempt(allowPairActive);
  }

  private pairKey(serverId: string, targetAgentId: string): string {
    return `${serverId}:${targetAgentId}`;
  }

  /**
   * Create a proposal. Returns the proposal with status "pending" (asked) or
   * "sent" (auto-approved / force-sent). Expiry is swept lazily on every
   * create.
   */
  async createProposal(input: ProposalCreateInput): Promise<MissionControlProposal> {
    await this.expireStale();
    const { allowPairKey: _allowPairKey, ...record } = input;
    const proposal: MissionControlProposal = {
      id: generateProposalId(),
      createdAt: new Date().toISOString(),
      ...record,
      status: "pending",
    };
    if (input.forceSend || this.autoApproved(input)) {
      proposal.status = "sent";
      await this.send(proposal);
      return proposal;
    }
    await this.store.putProposal(proposal);
    await this.publish(proposal);
    this.logger.info(
      {
        component: "approvals",
        proposalId: proposal.id,
        origin: proposal.origin,
        targetAgentId: proposal.targetAgentId,
        classification: proposal.classification,
        mode: this.getMode(),
        status: "pending",
      },
      "mission_control.approvals.proposal_created",
    );
    return proposal;
  }

  /** Approve (optionally edited) or deny a pending proposal. */
  async resolveProposal(
    input: ResolveProposalInput,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const proposal = this.store.getProposal(input.proposalId);
    if (!proposal) {
      return { ok: false, error: "Proposal not found" };
    }
    if (proposal.status === "expired") {
      return { ok: false, error: "Proposal expired" };
    }
    if (proposal.status !== "pending") {
      return { ok: false, error: `Proposal already ${proposal.status}` };
    }
    if (input.action === "approve") {
      const message = input.editedMessage ?? proposal.message;
      const updated: MissionControlProposal = {
        ...proposal,
        message,
        status: "sent",
        ...(input.allowPair ? { allowPair: true } : {}),
      };
      if (input.allowPair) {
        this.allowPairs.add(this.pairKey(proposal.serverId, proposal.targetAgentId));
        this.logger.info(
          {
            component: "approvals",
            proposalId: proposal.id,
            targetAgentId: proposal.targetAgentId,
            serverId: proposal.serverId,
          },
          "mission_control.approvals.allow_pair_granted",
        );
      }
      await this.send(updated);
      return { ok: true };
    }
    const updated: MissionControlProposal = { ...proposal, status: "denied" };
    await this.store.putProposal(updated);
    await this.publish(updated);
    this.logger.info(
      {
        component: "approvals",
        proposalId: proposal.id,
        origin: proposal.origin,
        targetAgentId: proposal.targetAgentId,
        status: "denied",
      },
      "mission_control.approvals.proposal_denied",
    );
    return { ok: true };
  }

  /**
   * Expire pending proposals past the 24h TTL. Runs lazily on create and from
   * the service's sweep timer.
   */
  async expireStale(now = Date.now()): Promise<number> {
    const expired = await this.store.expireProposals(now, PROPOSAL_TTL_MS);
    for (const proposal of expired) {
      await this.publish(proposal);
      this.logger.info(
        {
          component: "approvals",
          proposalId: proposal.id,
          targetAgentId: proposal.targetAgentId,
          status: "expired",
        },
        "mission_control.approvals.proposal_expired",
      );
    }
    return expired.length;
  }

  getProposal(proposalId: string): MissionControlProposal | null {
    return this.store.getProposal(proposalId);
  }

  listProposals(): MissionControlProposal[] {
    return this.store.listProposals();
  }

  onProposalChange(listener: ProposalChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async send(proposal: Proposal): Promise<void> {
    if (proposal.kind === "spawn") {
      // Spawn-kind proposal: create the NEW agent described by spawnPlan
      // (Commander/verifier spawns) instead of delivering a message. Single
      // execution path for approve and auto mode; failures log loudly and
      // never bounce a resolved proposal back to pending.
      if (!this.spawn) {
        this.logger.error(
          { proposalId: proposal.id, origin: proposal.origin },
          "mission_control.approvals.spawn_unavailable",
        );
        return;
      }
      const result = await this.spawn(proposal);
      if (!result.ok) {
        this.logger.error(
          { proposalId: proposal.id, origin: proposal.origin, error: result.error },
          "mission_control.approvals.spawn_failed",
        );
        return;
      }
      if (result.agentId) {
        const updated: Proposal = { ...proposal, spawnedAgentId: result.agentId };
        await this.store.putProposal(updated);
        await this.publish(updated);
        this.logger.info(
          { proposalId: proposal.id, agentId: result.agentId, origin: proposal.origin },
          "mission_control.approvals.spawned",
        );
      }
      return;
    }
    try {
      await this.deliver({
        agentId: proposal.targetAgentId,
        message: proposal.message,
        deliveryMode: proposal.deliveryMode,
        proposal,
        // Classify at the source: stall status-ask nudges are machinery
        // (verboseOnly audit trail); everything else is an instruction
        // (visible). Legacy verboseOnly records fall back to machinery.
        classification:
          proposal.timelineClassification ?? (proposal.verboseOnly ? "machinery" : "instruction"),
      });
    } catch (error) {
      if (error instanceof ProposalDeliveryAborted) {
        // The dispatch was refused (user outranks machinery): never redeliver,
        // never leave it pending — record it expired and log.
        proposal.status = "expired";
        await this.store.putProposal(proposal);
        await this.publish(proposal);
        this.logger.info(
          {
            component: "approvals",
            proposalId: proposal.id,
            origin: proposal.origin,
            targetAgentId: proposal.targetAgentId,
            reason: error.reason,
          },
          "mission_control.approvals.delivery_aborted",
        );
        return;
      }
      // Delivery failed: the proposal returns to pending so the card keeps its
      // Approve affordance and the user can retry — never record "sent" for a
      // message that did not reach the agent.
      proposal.status = "pending";
      await this.store.putProposal(proposal);
      await this.publish(proposal);
      this.logger.error(
        {
          err: error,
          component: "approvals",
          proposalId: proposal.id,
          targetAgentId: proposal.targetAgentId,
        },
        "mission_control.approvals.delivery_failed",
      );
      return;
    }
    await this.store.putProposal(proposal);
    await this.publish(proposal);
    this.logger.info(
      {
        component: "approvals",
        proposalId: proposal.id,
        origin: proposal.origin,
        targetAgentId: proposal.targetAgentId,
        deliveryMode: proposal.deliveryMode,
        status: "sent",
      },
      "mission_control.approvals.proposal_sent",
    );
  }

  /**
   * Honest steer delivery: an out-of-band steer was reported "handled" but
   * the agent produced no activity within the verification window — the
   * message never actually landed (wedged-omp incident). A proposal must
   * never stay recorded "sent" for a message that did not reach the agent:
   * flip it to "undelivered" (terminal, auditable, never redelivered), push
   * the updated card, and notify listeners.
   */
  async markUndelivered(proposalId: string): Promise<MissionControlProposal | null> {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal || proposal.status !== "sent") {
      return proposal ?? null;
    }
    const updated: Proposal = { ...proposal, status: "undelivered" };
    await this.store.putProposal(updated);
    await this.publish(updated);
    this.logger.error(
      {
        component: "approvals",
        proposalId: proposal.id,
        origin: proposal.origin,
        targetAgentId: proposal.targetAgentId,
        deliveryMode: proposal.deliveryMode,
      },
      "mission_control.approvals.proposal_undelivered",
    );
    return updated;
  }

  /**
   * A user stop outranks machinery: every pending proposal targeting the agent
   * is dead (approving it later would restart a run the user explicitly
   * stopped). Marks them expired and publishes the cards.
   */
  async expirePendingForAgent(agentId: string): Promise<void> {
    const pending = this.store
      .listProposals()
      .filter((proposal) => proposal.targetAgentId === agentId && proposal.status === "pending");
    for (const proposal of pending) {
      const expired: Proposal = { ...proposal, status: "expired" };
      await this.store.putProposal(expired);
      await this.publish(expired);
    }
    if (pending.length > 0) {
      this.logger.info(
        { component: "approvals", agentId, count: pending.length },
        "mission_control.approvals.pending_expired_on_user_stop",
      );
    }
  }

  private async publish(proposal: MissionControlProposal): Promise<void> {
    // The service emits the proposal card (kind "proposal"); the store chains
    // supersedes per proposal id so cards update in place across restarts.
    await this.publishProposalEvent(proposal);
    for (const listener of this.listeners) {
      try {
        listener(proposal);
      } catch (error) {
        this.logger.warn(
          { err: error, component: "approvals", proposalId: proposal.id },
          "mission_control.approvals.listener_failed",
        );
      }
    }
  }
}
