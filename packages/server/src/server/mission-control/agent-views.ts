/**
 * Which agents a person is looking at right now, from the client heartbeats
 * (app visible and the agent's chat focused). A client counts while its
 * heartbeats are fresh; an agent also counts for a short grace window after a
 * client stops showing it, so switching away just before a turn ends still
 * counts as watching.
 */

/** Heartbeats arrive every 15 s; two missed ones mean the client is gone. */
export const VIEW_STALE_MS = 40_000;
/** How long an agent still counts as watched after the last client left it. */
export const VIEW_GRACE_MS = 30_000;

interface ClientView {
  agentId: string | null;
  reportedAtMs: number;
}

export class AgentViewTracker {
  private readonly clients = new Map<string, ClientView>();
  private readonly lastSeenByAgent = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A heartbeat from `clientKey`: the agent it shows, or null when hidden or showing none. */
  noteHeartbeat(clientKey: string, viewing: { agentId: string | null; appVisible: boolean }): void {
    const agentId = viewing.appVisible ? viewing.agentId : null;
    this.leave(clientKey, agentId);
    this.clients.set(clientKey, { agentId, reportedAtMs: this.now() });
    if (agentId) this.lastSeenByAgent.set(agentId, this.now());
    for (const [agent, seenAt] of this.lastSeenByAgent) {
      if (this.now() - seenAt > VIEW_STALE_MS) this.lastSeenByAgent.delete(agent);
    }
  }

  /** The client disconnected. */
  noteGone(clientKey: string): void {
    this.leave(clientKey, null);
    this.clients.delete(clientKey);
  }

  isViewed(agentId: string): boolean {
    const now = this.now();
    for (const view of this.clients.values()) {
      if (view.agentId === agentId && now - view.reportedAtMs <= VIEW_STALE_MS) return true;
    }
    const lastSeen = this.lastSeenByAgent.get(agentId);
    return lastSeen !== undefined && now - lastSeen <= VIEW_GRACE_MS;
  }

  /** The client stopped showing what it showed; that agent was in view until now. */
  private leave(clientKey: string, next: string | null): void {
    const previous = this.clients.get(clientKey);
    if (!previous?.agentId || previous.agentId === next) return;
    // A stale client's last view ended when it went quiet, not now.
    const endedAt = Math.min(this.now(), previous.reportedAtMs + VIEW_STALE_MS);
    const known = this.lastSeenByAgent.get(previous.agentId) ?? 0;
    this.lastSeenByAgent.set(previous.agentId, Math.max(known, endedAt));
  }
}
