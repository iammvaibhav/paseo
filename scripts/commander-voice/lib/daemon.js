// Commander Voice — the Paseo daemon connection. Owns the mission_control_event
// subscription, the announce-policy event filter, and the capped update buffer.
// All fleet effects go through @getpaseo/client against the built workspace
// dist (same pattern as scripts/mc-backfill.mjs).
import { DaemonClient } from "@getpaseo/client";
import { WebSocket } from "ws";

const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * The announce-policy filter (docs/commander-voice.md):
 * - "inject"   → proposal events and needs-you lifecycle events (spoken).
 * - "waiting"  → Commander answers: spoken only while a dispatch is pending,
 *                otherwise buffered (routed like proposals when waiting).
 * - "buffer"   → everything else (started, finished, milestones, verdicts).
 */
export function classifyEvent(event) {
  const kind = event?.kind;
  const severity = event?.severity;
  if (kind === "proposal") {
    const status = event.proposal?.status;
    return status === undefined || status === "pending" ? "inject" : "buffer";
  }
  if (kind === "clarification") {
    return "inject";
  }
  if (severity === "blocker") {
    return "inject";
  }
  if (kind === "answer") {
    return "waiting";
  }
  return "buffer";
}

export class DaemonConnection {
  constructor(options) {
    this.url = options.url;
    this.password = options.password;
    this.appVersion = options.appVersion;
    this.clientId = options.clientId;
    this.updateBufferCap = options.updateBufferCap ?? 64;
    this.buffer = []; // newest-first, capped
    this.onAnnounce = options.onAnnounce ?? (() => {});
    this.dispatchPending = false;
    this.client = new DaemonClient({
      url: this.url,
      clientId: this.clientId,
      clientType: "cli",
      appVersion: this.appVersion,
      password: this.password,
      connectTimeoutMs: 15_000,
      webSocketFactory: (targetUrl, opts) =>
        new WebSocket(targetUrl, opts?.protocols, { headers: opts?.headers }),
      reconnect: { enabled: true },
    });
    this.client.on("mission_control_event", (msg) => {
      this.handleEvent(msg.event);
    });
  }

  async connect() {
    await this.client.connect();
    return this;
  }

  async close() {
    await this.client.close();
  }

  handleEvent(event) {
    const route = classifyEvent(event);
    const entry = {
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      severity: event.severity,
      headline: event.headline,
      detail: event.detail,
    };
    if (route === "inject" || (route === "waiting" && this.dispatchPending)) {
      const accepted = this.onAnnounce(event);
      if (route === "waiting" && accepted) {
        this.dispatchPending = false;
      }
      if (!accepted) {
        this.pushBuffer(entry);
      }
      return;
    }
    this.pushBuffer(entry);
  }

  pushBuffer(entry) {
    this.buffer.unshift(entry);
    if (this.buffer.length > this.updateBufferCap) {
      this.buffer.length = this.updateBufferCap;
    }
  }

  /** The Commander is the agent labeled paseo.mission-control=commander. */
  async findCommanderAgent() {
    const res = await this.client.fetchAgents({
      filter: { labels: { [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE } },
    });
    const candidates = res.entries.map((e) => e.agent).filter((a) => !a.archivedAt);
    if (candidates.length === 0) {
      return null;
    }
    const live = candidates.filter((a) => a.status !== "closed");
    const pool = live.length > 0 ? live : candidates;
    pool.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return pool[0];
  }

  /** fleet_status: deterministic board summary. No Commander involved. */
  async fetchFleetStatus() {
    const sinceTs = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [agentsRes, eventsRes, commander] = await Promise.all([
      this.client.fetchAgents({}),
      this.client.missionControlEventsFetch({ sinceTs }),
      this.findCommanderAgent(),
    ]);
    const agents = agentsRes.entries.map((e) => e.agent).filter((a) => !a.archivedAt);
    const buckets = { running: 0, idle: 0, error: 0, closed: 0, initializing: 0 };
    const needsYou = [];
    for (const agent of agents) {
      buckets[agent.status] = (buckets[agent.status] ?? 0) + 1;
      if (agent.requiresAttention) {
        needsYou.push(agent.title || agent.name || agent.id);
      }
    }
    const pending = eventsRes.events.filter(
      (e) => e.kind === "proposal" && (e.proposal?.status ?? "pending") === "pending",
    );
    const lines = [
      `${buckets.running} agents running, ${buckets.idle} idle, ${buckets.error} errored, ${buckets.closed} closed`,
    ];
    if (needsYou.length > 0) {
      lines.push(`${needsYou.length} need your attention: ${needsYou.join(", ")}`);
    }
    if (pending.length > 0) {
      lines.push(`${pending.length} proposals await your approval`);
    }
    if (commander) {
      lines.push(`The Commander is ${commander.status}`);
    } else {
      lines.push("The Commander is not available");
    }
    return lines.join(". ") + ".";
  }

  /** commander_dispatch: send a user prompt to the Commander, ack immediately. */
  async dispatch(message) {
    const commander = await this.findCommanderAgent();
    if (!commander) {
      return { ok: false, error: "Commander agent not found on this daemon" };
    }
    // M8 mailbox: the daemon owns delivery semantics (idle → run, busy →
    // steer envelope) and records the ledger row with source "voice". The
    // client dispatchMode is ignored for Commander targets.
    await this.client.sendAgentMessage(commander.id, message, { source: "voice" });
    this.dispatchPending = true;
    return { ok: true, agentId: commander.id };
  }

  /** proposal_respond: the same RPC the app's proposal cards use. */
  async respondProposal({ proposalId, action, editedMessage }) {
    if (action !== "approve" && action !== "deny") {
      return { ok: false, error: `action must be "approve" or "deny", got "${action}"` };
    }
    const payload = await this.client.missionControlProposalsRespond({
      proposalId,
      action,
      ...(editedMessage !== undefined ? { editedMessage } : {}),
    });
    return { ok: payload.ok === true, error: payload.error };
  }

  /** pending_updates: drain the update buffer into a spoken digest. */
  drainUpdates() {
    const drained = this.buffer.splice(0, this.buffer.length);
    if (drained.length === 0) {
      return "No updates since you last asked.";
    }
    const lines = drained.map(
      (entry) => `${entry.headline}${entry.detail ? ` — ${entry.detail}` : ""}`,
    );
    return `Here's what happened while you weren't asking. ${lines.join(". ")}.`;
  }
}
