// Commander Voice — the Paseo daemon connection. Owns the mission_control_event
// subscription, the announce-policy event filter (inject / waiting / buffer /
// drop with session correlation), and the capped update buffer.
// All fleet effects go through @getpaseo/client against the built workspace
// dist (same pattern as scripts/mc-backfill.mjs).
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";

const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * The announce-policy kind filter (docs/commander-voice.md):
 * - "inject"   → proposal events, clarifications, and needs-you blockers
 *                (spoken when a session is live, buffered otherwise — they
 *                need a decision).
 * - "waiting"  → Commander answers: spoken only while a dispatch is pending,
 *                otherwise buffered when correlated.
 * - "buffer"   → routine events (started, finished, milestones, verdicts):
 *                buffered only when correlated to this session's work.
 * The session-correlation drop happens in DaemonConnection#handleEvent, which
 * knows which agents/proposals this voice session touched; this pure function
 * only classifies by event shape.
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
    // Session correlation: agent ids this voice session dispatched to or
    // steered (relay: the Commander) and proposal ids it created (direct).
    // Only events touching these ids enter the silent buffer; everything
    // else is dropped.
    this.correlatedAgentIds = new Set();
    this.correlatedProposalIds = new Set();
    // Host alias of the connected daemon, resolved from the context fetch so
    // fleet_get_agent_activity can accept it as "local" spelling.
    this.hostAlias = null;
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

  /** Mark an agent as this session's work (outcomes buffer, not drop). */
  correlateAgent(agentId) {
    if (agentId) {
      this.correlatedAgentIds.add(agentId);
    }
  }

  /** Mark a proposal as this session's work (status changes buffer). */
  correlateProposal(proposalId) {
    if (proposalId) {
      this.correlatedProposalIds.add(proposalId);
    }
  }

  /**
   * Session correlation (docs/commander-voice.md "What enters the silent
   * buffer"): an event belongs to this session when its agent is one we
   * dispatched/steered, its proposal is one we created, or it is a pending
   * proposal / clarification / blocker that still needs a decision.
   */
  isSessionCorrelated(event) {
    return (
      this.isCorrelatedAgent(event?.agentId) ||
      this.isCorrelatedAgent(event?.verifierAgentId) ||
      this.isCorrelatedProposal(event?.proposal) ||
      this.isDecisionPending(event)
    );
  }

  /** True when the agent id is one this session dispatched/steered. */
  isCorrelatedAgent(agentId) {
    return Boolean(agentId && this.correlatedAgentIds.has(agentId));
  }

  /** True when the proposal is one we created or targets/spawns our agents. */
  isCorrelatedProposal(proposal) {
    if (proposal?.id && this.correlatedProposalIds.has(proposal.id)) {
      return true;
    }
    if (proposal?.targetAgentId && this.correlatedAgentIds.has(proposal.targetAgentId)) {
      return true;
    }
    if (proposal?.spawnedAgentId && this.correlatedAgentIds.has(proposal.spawnedAgentId)) {
      return true;
    }
    return false;
  }

  /** Pending proposals / clarifications / blockers need a decision no
   * matter who they came from — they always qualify for the buffer. */
  isDecisionPending(event) {
    if (event?.kind === "proposal" && (event.proposal?.status ?? "pending") === "pending") {
      return true;
    }
    return event?.kind === "clarification";
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

    // Learn correlation from a correlated proposal: a spawn we created
    // buffers its spawned agent's outcomes once it exists.
    const proposal = event.proposal;
    if (proposal?.id && this.isSessionCorrelated(event)) {
      this.correlatedProposalIds.add(proposal.id);
      if (proposal.spawnedAgentId) {
        this.correlateAgent(proposal.spawnedAgentId);
      }
      if (proposal.targetAgentId) {
        this.correlateAgent(proposal.targetAgentId);
      }
    }

    // Needs-you events speak immediately when a session is live; otherwise
    // they buffer (a pending decision cannot be dropped).
    if (route === "inject") {
      if (!this.onAnnounce(event)) {
        this.pushBuffer(entry);
      }
      return;
    }

    // Commander answers: spoken while a dispatch is pending (that is the
    // answer the user is waiting for); otherwise buffered only when this
    // session asked the question.
    if (route === "waiting") {
      if (this.dispatchPending && this.onAnnounce(event)) {
        this.dispatchPending = false;
        return;
      }
      if (this.isSessionCorrelated(event)) {
        this.pushBuffer(entry);
      }
      return;
    }

    // Routine events: only this session's work is buffered; the rest is
    // dropped (docs: "Anything else is dropped, not buffered").
    if (this.isSessionCorrelated(event)) {
      this.pushBuffer(entry);
    }
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

  // --- Shared read tools (both modes) ---------------------------------------

  /**
   * fleet_list_agents: roster across hosts. The voice node connects to ONE
   * daemon (no peerManager), so this is best-effort: live agents from the
   * connected host, peer host status from peers.list, and the cross-host
   * recentAgents from the context fetch when the daemon provides them.
   * Returns a spoken-friendly digest; the model reads it aloud.
   */
  async fleetListAgents({ includeArchived = false, sinceHours = 48, statuses, limit = 50 } = {}) {
    // Best-effort: the daemon context fetch also carries the host alias and
    // a cross-host roster the local fetch cannot see.
    const { hostAlias, recentAgents } = await this.fetchHostContext();

    const filter = { includeArchived: Boolean(includeArchived) };
    if (Array.isArray(statuses) && statuses.length > 0) {
      filter.statuses = statuses;
    }
    const agentsRes = await this.client.fetchAgents({ scope: "active", filter });
    const local = agentsRes.entries
      .map((e) => e.agent)
      .filter((a) => includeArchived || !a.archivedAt);
    const seen = new Set(local.map((a) => a.id));
    const rows = local.slice(0, limit).map((a) => {
      seen.add(a.id);
      return `${a.title || a.name || a.id} (${a.status})`;
    });

    // Cross-host roster from the context fetch, deduped against local rows.
    const remote = this.buildRemoteRows(recentAgents, seen);
    // Peer hosts: state only (we cannot read a peer's agents without a
    // peerManager — that is what commander_dispatch is for).
    const peers = await this.fetchPeerStates();
    const lines = this.buildRosterLines(rows, remote, hostAlias, peers, limit);
    // sinceHours is accepted for Commander parity but the voice node has no
    // history window over the wire; keep the parameter for call compatibility.
    void sinceHours;
    return lines.join(". ") + ".";
  }

  /** Daemon context fetch (host alias + cross-host recentAgents); optional. */
  async fetchHostContext() {
    let hostAlias = this.hostAlias ?? "local";
    let recentAgents = [];
    try {
      const ctx = await this.client.missionControlContextFetch();
      if (ctx.hostAlias) {
        hostAlias = ctx.hostAlias;
        this.hostAlias = hostAlias;
      }
      recentAgents = ctx.recentAgents ?? [];
    } catch {
      // context fetch is optional; fall through to the local roster
    }
    return { hostAlias, recentAgents };
  }

  /** Peer host states from peers.list; optional. */
  async fetchPeerStates() {
    try {
      const peersPayload = await this.client.missionControlPeersList();
      return peersPayload.peers ?? [];
    } catch {
      // peers.list is optional
      return [];
    }
  }

  /** Cross-host roster rows from the context fetch, deduped against local. */
  buildRemoteRows(recentAgents, seen) {
    const remote = new Map(); // host -> rows
    for (const r of recentAgents) {
      if (seen.has(r.agentId) || !r.agentId) {
        continue;
      }
      seen.add(r.agentId);
      const host = r.hostServerId || "remote";
      if (!remote.has(host)) {
        remote.set(host, []);
      }
      remote.get(host).push(`${r.title || r.name || r.agentId} (${r.status || "unknown"})`);
    }
    return remote;
  }

  /** Spoken-friendly digest lines: local host, remote hosts, peer states. */
  buildRosterLines(rows, remote, hostAlias, peers, limit) {
    const lines = [];
    if (rows.length > 0) {
      lines.push(`On ${hostAlias}: ${rows.join(", ")}`);
    } else {
      lines.push(`On ${hostAlias}: no agents`);
    }
    for (const [host, hostRows] of remote) {
      lines.push(`On ${host}: ${hostRows.slice(0, limit).join(", ")}`);
    }
    if (peers.length > 0) {
      const peerLines = peers.map((p) =>
        p.state === "online" ? `${p.name} online` : `${p.name} unreachable`,
      );
      lines.push(`Peers: ${peerLines.join(", ")}`);
    }
    return lines;
  }

  /**
   * fleet_get_agent_activity: curated timeline summary for one agent on the
   * connected host. Read-only; does not poke the live agent (not a nudge).
   * Peer-host reads need Commander (no peerManager here) — say so clearly.
   */
  async fleetGetAgentActivity({ host, agentId, limit }) {
    if (!agentId) {
      return { error: "fleet_get_agent_activity requires agentId" };
    }
    const hostLabel = this.hostAlias ?? "local";
    if (host && host !== "local" && host !== hostLabel) {
      return {
        error: `fleet_get_agent_activity cannot read host "${host}" from the voice node; use commander_dispatch to have the Commander read it.`,
      };
    }
    const payload = await this.client.fetchAgentTimeline(agentId, {
      direction: "tail",
      ...(typeof limit === "number" && limit > 0 ? { limit } : {}),
    });
    if (payload.error) {
      return { error: payload.error };
    }
    const timeline = payload.entries.map((entry) => entry.item);
    const summary = this.curateActivity(timeline, limit);
    return {
      result: `${summary.content}`,
    };
  }

  /** Compact spoken-friendly activity digest (same spirit as the server's
   * curateAgentActivity, kept local to avoid a server-package dependency). */
  curateActivity(timeline, limit) {
    const items = typeof limit === "number" && limit > 0 ? timeline.slice(-limit) : timeline;
    const lines = [];
    for (const item of items) {
      const text = item.text ? String(item.text).trim() : "";
      if (item.type === "user_message" && text) {
        lines.push(`[User] ${text}`);
      } else if (item.type === "assistant_message" && text) {
        lines.push(text);
      } else if (item.type === "error") {
        lines.push(`[Error] ${item.message ?? text}`);
      } else if (item.type === "tool_call") {
        lines.push(`[Tool call] ${item.detail?.name ?? item.name ?? ""}`);
      } else if (item.type === "compaction") {
        lines.push("[Compacted]");
      } else if (item.type === "todo") {
        lines.push("[Tasks]");
      } else if (text) {
        lines.push(text);
      }
    }
    const shown = lines.length;
    const total = timeline.length;
    const header = `Showing ${shown} of ${total} activities`;
    if (lines.length === 0) {
      return { updateCount: total, content: `${header}: no activity to display.` };
    }
    return { updateCount: total, content: `${header}: ${lines.join(" | ")}.` };
  }

  /** fleet_search: find agents by what they worked on (connected host). */
  async fleetSearch({ query, limit = 20, deep = false }) {
    if (!query || !String(query).trim()) {
      return { error: "fleet_search requires a query" };
    }
    const payload = await this.client.missionControlSearch({ query, limit, deep });
    if (payload.error) {
      return { error: payload.error };
    }
    const matches = payload.matches ?? [];
    if (matches.length === 0) {
      return { result: `No matches for "${query}".` };
    }
    const lines = matches.slice(0, limit).map((m) => {
      const name = m.name || m.agentId;
      const host = m.host && m.host !== "local" ? ` on ${m.host}` : "";
      const when = m.ts ? ` (${String(m.ts).slice(0, 10)})` : "";
      return `${name}${host}${when}`;
    });
    return { result: `${matches.length} matches for "${query}": ${lines.join(", ")}.` };
  }

  /**
   * fleet_recall: semantic recall over fleet memory. The voice node has no
   * recall RPC — tell the model the Commander path instead of failing.
   */
  async fleetRecall() {
    return {
      error:
        "fleet_recall is not available from the voice node; use commander_dispatch to have the Commander recall it.",
    };
  }

  /**
   * fleet_context: run records / workspace-project rollups. Same story as
   * fleet_recall: no client RPC from the voice node.
   */
  async fleetContext() {
    return {
      error:
        "fleet_context is not available from the voice node; use commander_dispatch to have the Commander fetch it.",
    };
  }

  /**
   * tag_message: attribute the current user turn to agents. Voice has no
   * agent-scoped session to tag from; the Commander tags on dispatch.
   */
  async tagMessage() {
    return {
      error:
        "tag_message is not available from the voice node; the Commander tags messages it dispatches.",
    };
  }

  // --- Control tools ---------------------------------------------------------

  /**
   * commander_dispatch: send a user prompt to the Commander, ack immediately.
   * The Commander's agent id is correlated so its answers/outcomes buffer.
   */
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
    this.correlateAgent(commander.id);
    return { ok: true, agentId: commander.id };
  }

  /**
   * Direct-mode mutating tools: route through the same proposal gate as the
   * Commander (mission_control.proposals.create) so every fleet side effect
   * is approval-gated and lands as a card. The created proposal id is
   * correlated so its status changes buffer.
   */
  async proposeDirectAction({ toolName, message, reason, targetAgentId }) {
    const created = await this.client.missionControlProposalsCreate({
      message,
      reason: reason ?? `voice direct ${toolName}`,
      ...(targetAgentId ? { targetAgentId } : {}),
    });
    if (!created.ok) {
      return { ok: false, error: created.error || "proposal creation failed" };
    }
    this.correlateProposal(created.proposalId);
    if (targetAgentId) {
      this.correlateAgent(targetAgentId);
    }
    return { ok: true, proposalId: created.proposalId };
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

  // --- Mirror (M9 voice dialogue mirror) -------------------------------------

  /**
   * Mirror a heard user turn or spoken reply into the Commander thread
   * WITHOUT starting a Commander model turn (append-only timeline rows).
   * The RPC is owned by the protocol/server/client workstream; until
   * client.missionControlVoiceMirror exists this no-ops with a one-time log.
   * kind: "qa" (pure Q&A, hidden in the UI feed) | "dispatch" (the turn asked
   * the fleet to do something — visible).
   */
  async mirrorVoiceTurn({ role, text, kind = "qa" }) {
    try {
      const mirror = this.client?.missionControlVoiceMirror;
      if (typeof mirror !== "function") {
        if (!this._mirrorWarned) {
          this._mirrorWarned = true;
          console.log(
            "[voice] client.missionControlVoiceMirror not available yet — voice mirror is a no-op",
          );
        }
        return { ok: false, error: "missionControlVoiceMirror not available" };
      }
      const payload = await mirror.call(this.client, { role, text, kind });
      return { ok: payload?.ok === true, error: payload?.error };
    } catch (err) {
      console.error(`[voice] mirror failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // --- Central config ---------------------------------------------------------

  /**
   * Best-effort read of the Mission Control central config. Returns the
   * server-side voiceMode ("relay" | "direct") when the daemon publishes it,
   * else null so the caller keeps the env/default mode. Never throws.
   */
  async fetchVoiceMode() {
    try {
      const payload = await this.client.missionControlConfigGet();
      const mode = payload?.config?.voiceMode;
      if (mode === "relay" || mode === "direct") {
        return mode;
      }
      return null;
    } catch {
      return null;
    }
  }
}
