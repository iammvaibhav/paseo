import type { Logger } from "pino";
import type {
  MissionControlProposal,
  MissionControlProposal as Proposal,
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
  deliveryMode: "steer" | "interrupt";
  reason: string;
  classification: "normal" | "destructive";
  allowPair?: boolean;
  /** Bypass the gate entirely: record as auto-sent ("sent") and deliver, never
   *  a pending card. Mode, presence, and user-stop do not apply. Used by the
   *  stall status-ask nudge (a steer that only asks for a status). */
  forceSend?: boolean;
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
   * interrupting a running turn; interrupt replaces it.
   */
  deliver: (input: {
    agentId: string;
    message: string;
    deliveryMode: "steer" | "interrupt";
  }) => Promise<void>;
  /**
   * Push a proposal-card event (kind "proposal"). Status changes append a new
   * event superseding the previous one for the same proposal. Returns the
   * emitted event so the caller can track supersede chains.
   */
  publishProposalEvent: (proposal: MissionControlProposal) => Promise<{ id: string }>;
}

export type ProposalChangeListener = (proposal: MissionControlProposal) => void;

/**
 * The approval gate. Every outbound send from mission-control machinery
 * (verifier contacts, stall nudges, commander digest steers) flows through
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
  private readonly publishProposalEvent: MissionControlApprovalsOptions["publishProposalEvent"];
  private readonly allowPairs = new Set<string>();
  private readonly listeners = new Set<ProposalChangeListener>();

  constructor(options: MissionControlApprovalsOptions) {
    this.store = options.store;
    this.presence = options.presence;
    this.logger = options.logger;
    this.getMode = options.getMode;
    this.deliver = options.deliver;
    this.publishProposalEvent = options.publishProposalEvent;
  }

  /**
   * True when a proposal sends immediately instead of asking. Destructive
   * actions, a user viewing the target, and user-stop conflicts always ask —
   * even in auto mode.
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
    // Ask mode: a previously granted allow-pair auto-approves the rest of the
    // verifier<->worker exchange.
    return (
      input.origin === "verifier" &&
      this.allowPairs.has(this.pairKey(input.serverId, input.targetAgentId))
    );
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
    const proposal: MissionControlProposal = {
      id: generateProposalId(),
      createdAt: new Date().toISOString(),
      ...input,
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
    try {
      await this.deliver({
        agentId: proposal.targetAgentId,
        message: proposal.message,
        deliveryMode: proposal.deliveryMode,
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
