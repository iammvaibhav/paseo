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

/**
 * Dual-channel digest for fleet_list_agents catalog rows (each row carries
 * host, status, and optionally requiresAttention). Buckets follow the
 * server-computed `bucket` field when the roster carries it (spec 01);
 * until BucketCore lands the old predicate stands in:
 * - needs_you: requiresAttention === true OR status "error" (attention
 *   outranks the lifecycle, matching the board's Needs-you bucket).
 * - running: status "running".
 * - idle: everything else. Idle is explicitly NOT needs-you.
 * Groups by host, leads with fleet-wide counts, then names per host so the
 * model can answer follow-ups ("which ones need me?").
 * Returns { spoken, data }: the model speaks `spoken` and takes every id
 * from `data` — ids are never spoken, and a row without a title/name is
 * "an untitled agent", never its raw id.
 */
const FLEET_BUCKETS = new Set(["needs_you", "running", "ready", "done", "idle"]);

const FLEET_BUCKET_LABELS = {
  needs_you: "needs you",
  running: "running",
  ready: "ready",
  done: "done",
  idle: "idle",
};

/** The pre-bucket needs-you predicate (attention outranks lifecycle). */
function fallbackFleetBucket(agent) {
  // COMPAT(bucket): remove after the roster carries server-computed buckets
  // (BucketCore slice); this predicate is the pre-bucket needs-you
  // definition and cannot see ready/done.
  if (agent.requiresAttention === true || agent.status === "error") {
    return "needs_you";
  }
  return agent.status === "running" ? "running" : "idle";
}

/** The agent's bucket: the server's verbatim value when present, else the
 * pre-bucket predicate. */
function fleetBucketOf(agent) {
  const bucket = agent.bucket;
  return FLEET_BUCKETS.has(bucket) ? bucket : fallbackFleetBucket(agent);
}

/** Project a roster row into the typed data row (ids verbatim; nullable
 * fields are null when the roster does not carry them yet). */
function projectFleetRosterRow(agent) {
  return {
    id: agent.id,
    shortId: agent.shortId,
    name: agent.name ?? null,
    title: agent.title ?? null,
    description: agent.description ?? null,
    host: agent.host ?? null,
    workspaceId: agent.workspaceId ?? null,
    projectId: agent.projectId ?? null,
    bucket: fleetBucketOf(agent),
    lastReport:
      Array.isArray(agent.reportStatus) && agent.reportStatus.length > 0
        ? agent.reportStatus[agent.reportStatus.length - 1]
        : null,
  };
}

export function buildFleetRosterDigest(agents) {
  const rows = Array.isArray(agents) ? agents : [];
  if (rows.length === 0) {
    return { spoken: "No agents in the fleet.", data: { agents: [] } };
  }
  const byHost = new Map();
  for (const agent of rows) {
    const host = agent.host || "unknown";
    if (!byHost.has(host)) {
      byHost.set(host, []);
    }
    byHost.get(host).push(agent);
  }
  const total = { needs_you: 0, running: 0, ready: 0, done: 0, idle: 0 };
  const hostParts = [];
  for (const [host, list] of byHost) {
    for (const a of list) {
      total[fleetBucketOf(a)] += 1;
    }
    const label = (a) => {
      const name = a.title || a.name || "an untitled agent";
      return `${name} (${FLEET_BUCKET_LABELS[fleetBucketOf(a)]})`;
    };
    hostParts.push(`On ${host}: ${list.map(label).join(", ")}.`);
  }
  const hosts = byHost.size;
  const lead =
    `Across ${hosts} ${hosts === 1 ? "host" : "hosts"}: ${total.needs_you} ` +
    `${total.needs_you === 1 ? "needs" : "need"} you, ${total.running} running, ` +
    `${total.ready} ready, ${total.done} done, ${total.idle} idle. Idle is not needs-you.`;
  return {
    spoken: `${lead} ${hostParts.join(" ")}`,
    data: { agents: rows.map(projectFleetRosterRow) },
  };
}

/**
 * Dual-channel digest for fleet_list_inventory catalog hosts (each host
 * carries host, reachable, and projects with workspaces). Title-first, never
 * raw ids: with no query it leads with fleet-wide counts then names projects
 * per host; with a query it leads with the matches (project title + host +
 * its workspaces) so the model can act on the resolved name; no match says so
 * and lists host names so the model can retry without guessing.
 * Returns { spoken, data }: `data.hosts` carries the prj_/wks_ ids verbatim
 * (never a path as an id); `spoken` names titles only.
 */
/** Project an inventory host into the typed data row (ids verbatim). */
function projectFleetInventoryHost(host) {
  return {
    host: host.host,
    reachable: host.reachable,
    projects: (host.projects ?? []).map((project) => ({
      id: project.id,
      title: project.title,
      workspaces: (project.workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        kind: workspace.kind,
        cwd: workspace.cwd,
      })),
    })),
  };
}

export function buildFleetInventoryDigest(hosts, query) {
  const rows = Array.isArray(hosts) ? hosts : [];
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const hostsWithProjects = rows.filter((host) => (host.projects ?? []).length > 0);
  const totalProjects = rows.reduce((count, host) => count + (host.projects ?? []).length, 0);
  const totalWorkspaces = rows.reduce(
    (count, host) =>
      count +
      (host.projects ?? []).reduce((n, project) => n + (project.workspaces ?? []).length, 0),
    0,
  );

  let spoken;
  if (normalizedQuery) {
    const lines = [];
    for (const host of hostsWithProjects) {
      for (const project of host.projects) {
        const workspaces = project.workspaces ?? [];
        const workspaceText =
          workspaces.length > 0 ? ` Workspaces: ${workspaces.map((w) => w.title).join(", ")}.` : "";
        lines.push(
          `Closest to "${normalizedQuery}": project ${project.title} on ${host.host}.${workspaceText}`,
        );
      }
    }
    if (lines.length > 0) {
      spoken = lines.join(" ");
    } else {
      const hostNames = rows.map((host) => host.host).filter(Boolean);
      spoken =
        hostNames.length > 0
          ? `No match for "${normalizedQuery}". Hosts: ${hostNames.join(", ")}.`
          : `No match for "${normalizedQuery}".`;
    }
  } else if (totalProjects === 0) {
    const hostCount = rows.length;
    spoken = `Across ${hostCount} ${hostCount === 1 ? "host" : "hosts"}: no projects or workspaces.`;
  } else {
    const hostParts = hostsWithProjects.map((host) => {
      const projectParts = host.projects.map((project) => {
        const workspaces = project.workspaces ?? [];
        if (workspaces.length === 0) {
          return `project ${project.title}`;
        }
        return `project ${project.title} (${workspaces.length} ${
          workspaces.length === 1 ? "workspace" : "workspaces"
        }: ${workspaces.map((w) => w.title).join(", ")})`;
      });
      return `On ${host.host}: ${projectParts.join(", ")}.`;
    });
    const hostCount = rows.length;
    spoken =
      `Across ${hostCount} ${hostCount === 1 ? "host" : "hosts"}: ${totalProjects} project${
        totalProjects === 1 ? "" : "s"
      }, ${totalWorkspaces} workspace${totalWorkspaces === 1 ? "" : "s"}. ` + hostParts.join(" ");
  }

  return {
    spoken,
    data: { hosts: rows.map(projectFleetInventoryHost) },
  };
}

/**
 * One-line rendering of the still-open instruction rows for the model's next
 * turn and the pending_updates digest (spec 05): each row is its short id +
 * one-line text; rows join with " — ". Empty string when nothing is open —
 * callers attach nothing.
 */
export function formatOpenInstructionsLine(instructions) {
  const rows = Array.isArray(instructions) ? instructions : [];
  const parts = [];
  for (const instruction of rows) {
    const text = String(instruction?.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!instruction?.id || !text) {
      continue;
    }
    parts.push(`${instruction.id} ${text}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return `Open: ${parts.join(" — ")}`;
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
    // fleet_monitor scope for THIS session (spec 03): agent-scope watches
    // (agent ids) plus an optional fleet-wide watch. Reconciled from the
    // daemon's authoritative per-session registry on every fleet_monitor
    // call; terminal events for this scope announce (speak when live, buffer
    // while the user is mid-turn).
    this.monitoredAgents = new Set();
    this.fleetMonitored = false;
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
   * Reconcile this session's monitored scope with the daemon's authoritative
   * per-session registry (returned by every fleet_monitor call): agent-scope
   * watches become monitoredAgents, a fleet-scope watch sets fleetMonitored.
   * Idempotent — status/start/stop all pass the full list.
   */
  syncMonitorSubscriptions(subscriptions) {
    const nextAgents = new Set();
    let fleet = false;
    for (const sub of Array.isArray(subscriptions) ? subscriptions : []) {
      if (sub?.scope === "fleet") {
        fleet = true;
      } else if (sub?.scope === "agent" && sub.agentId) {
        nextAgents.add(sub.agentId);
      }
    }
    this.monitoredAgents = nextAgents;
    this.fleetMonitored = fleet;
  }

  /**
   * Spec 03 announce policy for monitored scope: blocked/error/finished
   * announce only when this session watches the event's agent (or the whole
   * fleet). Proposals/clarifications are handled by classifyEvent (always);
   * started/milestones never announce regardless of scope.
   */
  isMonitoredEvent(event) {
    const kind = event?.kind;
    if (kind !== "blocked" && kind !== "failed" && kind !== "finished") {
      return false;
    }
    const monitoredAgents = this.monitoredAgents ?? new Set();
    return this.fleetMonitored === true || monitoredAgents.has(event?.agentId);
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
      // The buffer is id-carrying: proposalId/agentId ride the entry (and
      // the pending_updates data) so the model can act without ever hearing
      // a raw id.
      ...(event.proposal?.id ? { proposalId: event.proposal.id } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.agentTitle ? { agentTitle: event.agentTitle } : {}),
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

    // Monitored-scope terminal events (blocked/error/finished) announce one
    // line per the spec 03 policy — the same inject discipline: speak when a
    // session is live, buffer while the user is mid-turn (id-carrying).
    if (this.isMonitoredEvent(event)) {
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

  // --- Catalog tool execution (the single fleet code path) -------------------

  /**
   * Execute a Commander fleet tool through the daemon's tool catalog over the
   * mission_control.tools.execute session RPC. The daemon runs the SAME
   * createPaseoToolCatalog().executeTool(name, args) the Commander uses, so
   * voice and Commander share every roster, timeline, search, recall, and
   * gated-action implementation — the voice node never reimplements a fleet
   * tool. Returns the catalog result ({ ok, structuredContent, content,
   * error }), or { ok: false, error } when the RPC itself failed.
   */
  async executeCatalogTool(name, args = {}) {
    let payload;
    try {
      payload = await this.client.missionControlToolsExecute({ name, args });
    } catch (err) {
      return { ok: false, error: `Catalog tool ${name} failed: ${err.message}` };
    }
    return {
      ok: payload?.ok === true,
      structuredContent: payload?.structuredContent ?? {},
      content: typeof payload?.content === "string" ? payload.content : "",
      error: payload?.error,
    };
  }

  // --- Shared read tools (both modes) ---------------------------------------

  /**
   * fleet_list_agents: the Commander roster tool, executed in the daemon's
   * catalog (cross-host roster, per-agent status + report headlines). Voice
   * only shapes the spoken digest — the roster itself is the catalog's.
   */
  async fleetListAgents(args = {}) {
    const result = await this.executeCatalogTool("fleet_list_agents", args);
    if (!result.ok) {
      return { error: result.error ?? "fleet_list_agents failed" };
    }
    return buildFleetRosterDigest(result.structuredContent.agents);
  }

  /**
   * fleet_list_inventory: the Commander catalog tool for hosts, projects, and
   * workspaces (optional fuzzy query / host filter), executed in the daemon's
   * catalog. Voice shapes the spoken digest — titles first, ids only when the
   * query matched and the id is needed to act.
   */
  async fleetListInventory(args = {}) {
    const result = await this.executeCatalogTool("fleet_list_inventory", args);
    if (!result.ok) {
      return { error: result.error ?? "fleet_list_inventory failed" };
    }
    return buildFleetInventoryDigest(result.structuredContent.hosts, args.query);
  }

  /**
   * fleet_get_agent_activity: the Commander activity tool, executed in the
   * catalog (curated timeline summary for one agent, local or peer host).
   * The catalog returns the curated summary in structuredContent.content.
   */
  async fleetGetAgentActivity(args = {}) {
    const result = await this.executeCatalogTool("fleet_get_agent_activity", args);
    if (!result.ok) {
      return { error: result.error ?? "fleet_get_agent_activity failed" };
    }
    const sc = result.structuredContent ?? {};
    const content = sc.content;
    const data = { agentId: sc.agentId ?? null };
    if (typeof content === "string" && content.trim()) {
      return { spoken: content, data };
    }
    return { spoken: "No activity to display.", data };
  }
  /** fleet_search: the Commander search tool, executed in the catalog. */
  async fleetSearch(args = {}) {
    const result = await this.executeCatalogTool("fleet_search", args);
    if (!result.ok) {
      return { error: result.error ?? "fleet_search failed" };
    }
    const matches = result.structuredContent?.matches ?? [];
    const query = args.query ?? "";
    const shown = matches.slice(0, args.limit ?? 20);
    if (shown.length === 0) {
      return { spoken: `No matches for "${query}".`, data: { matches: [] } };
    }
    const lines = shown.map((m) => {
      const name = m.name || m.title || "an untitled agent";
      const host = m.host && m.host !== "local" ? ` on ${m.host}` : "";
      const when = m.ts ? ` (${String(m.ts).slice(0, 10)})` : "";
      return `${name}${host}${when}`;
    });
    return {
      spoken: `${shown.length} ${shown.length === 1 ? "match" : "matches"} for "${query}": ${lines.join(", ")}.`,
      data: {
        matches: shown.map((m) => ({
          agentId: m.agentId ?? null,
          host: m.host ?? null,
          name: m.name ?? null,
          title: m.title ?? null,
          snippet: m.snippet ?? "",
        })),
      },
    };
  }
  /**
   * fleet_recall: the Commander recall tool, executed in the catalog (same
   * MissionControlService.hindsightRecall). When the bank is unconfigured the
   * catalog answers ok:false reason "memory unavailable" and the caller
   * should route the question through commander_dispatch.
   */
  async fleetRecall(args = {}) {
    const result = await this.executeCatalogTool("fleet_recall", args);
    if (!result.ok) {
      return {
        error:
          result.error ??
          `fleet_recall is unavailable (${result.structuredContent?.reason ?? "unknown reason"}); use commander_dispatch to have the Commander recall it.`,
      };
    }
    const matches = result.structuredContent?.matches ?? [];
    const query = args.query ?? "";
    const shown = matches.slice(0, args.limit ?? 5);
    if (shown.length === 0) {
      return { spoken: `No memories match "${query}".`, data: { matches: [] } };
    }
    const lines = shown.map((match) => {
      const attribution = match.attribution;
      const name = attribution
        ? attribution.agentTitle || attribution.agentName || "an unknown agent"
        : null;
      const source = match.bank === "paseo-fleet" ? "run record" : "transcript memory";
      const when = match.occurredStart ? ` (${String(match.occurredStart).slice(0, 10)})` : "";
      const prefix = name ? `${name}: ` : "";
      const text = String(match.text || "")
        .replace(/\s+/g, " ")
        .trim();
      return `${prefix}${text || source}${when}`;
    });
    return {
      spoken: `${shown.length} ${shown.length === 1 ? "memory" : "memories"}: ${lines.join(", ")}.`,
      data: {
        matches: shown.map((match) => ({
          text: String(match.text ?? ""),
          agentId: match.attribution?.agentId ?? null,
          workspaceId: match.attribution?.workspaceId ?? null,
          sessionId: match.sessionId ?? null,
        })),
      },
    };
  }

  /**
   * fleet_context: the Commander context tool, executed in the catalog (run
   * records / workspace-project rollups from the mission-control store).
   */
  async fleetContext(args = {}) {
    const result = await this.executeCatalogTool("fleet_context", args);
    if (!result.ok) {
      return {
        error:
          result.error ??
          `fleet_context is unavailable (${result.structuredContent?.error ?? "unknown reason"}); use commander_dispatch to have the Commander fetch it.`,
      };
    }
    const sc = result.structuredContent ?? {};
    const records = sc.runRecords ?? [];
    const workspaceRollup = sc.workspaceRollup ?? null;
    const projectRollup = sc.projectRollup ?? null;
    const lines = [];
    const rollup = workspaceRollup ?? projectRollup;
    if (rollup) {
      const label =
        rollup.kind === "workspace"
          ? (rollup.workspaceTitle ?? "workspace")
          : (rollup.projectName ?? "project");
      const openCount = (rollup.runs ?? []).reduce(
        (count, run) => count + (run.open.length > 0 ? 1 : 0),
        0,
      );
      lines.push(
        `${rollup.kind} "${label}": ${rollup.runs.length} run${rollup.runs.length === 1 ? "" : "s"}${openCount > 0 ? `, ${openCount} with open items` : ""}`,
      );
    }
    const recordLines = records.slice(0, 5).map((record) => {
      const name = record.agentTitle || record.agentName || "an unknown agent";
      const brief = record.brief
        ? ` — ${String(record.brief).replace(/\s+/g, " ").trim().slice(0, 120)}`
        : "";
      return `${name} (${record.outcome})${brief}`;
    });
    if (recordLines.length > 0) {
      lines.push(recordLines.join(". "));
    }
    if (lines.length === 0) {
      return {
        spoken: "No run records in the mission-control store yet.",
        data: { runRecords: [], workspaceRollup, projectRollup },
      };
    }
    return {
      spoken: lines.join(". ") + ".",
      data: { runRecords: records, workspaceRollup, projectRollup },
    };
  }

  /**
   * tag_message: the Commander tag tool, executed in the catalog (the daemon
   * tags the latest voice-mirrored user message on the Commander thread; the
   * Verifier reads these tags).
   */
  async tagMessage(args = {}) {
    if (!Array.isArray(args.agentIds) || args.agentIds.length === 0) {
      return { error: "tag_message requires agentIds" };
    }
    const result = await this.executeCatalogTool("tag_message", args);
    if (result.ok && result.structuredContent?.recorded === true) {
      return {
        spoken: `Tagged the current user turn to ${args.agentIds.length} agent${args.agentIds.length === 1 ? "" : "s"}.`,
        data: { agentIds: args.agentIds },
      };
    }
    return { error: result.error ?? "tag_message failed" };
  }

  // --- Instruction ledger (voice P0, spec 05) --------------------------------

  /**
   * Open one ledger row per final user utterance: the daemon records the
   * transcript verbatim (source "voice") and returns the opened ids. The
   * session injects those ids into the next model turn ("Open: #12 …") so
   * the model cites them via respondsTo; emit-time close closes the rows.
   */
  async openInstruction(text) {
    const payload = await this.client.missionControlInstructionsOpen({
      text,
      source: "voice",
    });
    return { instructions: payload?.instructions ?? [] };
  }

  /**
   * Every retained ledger row (open + closed, newest first). The session
   * filters this to its own ids so closed rows stop resurfacing — unclosed
   * rows keep riding the next-turn injection ("nothing silently drops").
   */
  async listInstructions() {
    const payload = await this.client.missionControlInstructionsList();
    return { instructions: payload?.instructions ?? [] };
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
   * Direct-mode mutating tools route through the daemon's catalog
   * (executeCatalogTool), whose Commander-gated implementations own the
   * proposal gate — the voice node has no second gated-action path.
   */

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

  /** pending_updates: drain the update buffer into a dual-channel digest.
   * The buffer is id-carrying (proposalId/agentId/kind ride every entry), so
   * `data.entries` lets the model act on what happened without the ids ever
   * being spoken. */
  drainUpdates() {
    const drained = this.buffer.splice(0, this.buffer.length);
    if (drained.length === 0) {
      return { spoken: "No updates since you last asked.", data: { entries: [] } };
    }
    const lines = drained.map(
      (entry) => `${entry.headline}${entry.detail ? ` — ${entry.detail}` : ""}`,
    );
    return {
      spoken: `Here's what happened while you weren't asking. ${lines.join(". ")}.`,
      data: { entries: drained },
    };
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
