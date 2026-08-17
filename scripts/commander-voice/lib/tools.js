// Commander Voice — mode-aware tool surfaces and their server-side executors.
// Gemini function declarations (Live API schema) + plain async executors that
// hit the daemon.
//
// relay:  shared read tools + commander_dispatch + proposal_respond +
//         pending_updates (no mutating tools declared — the model cannot call
//         what it cannot see; every fleet change goes through Commander).
// direct: the full Commander allowlist + proposal_respond + pending_updates.
//         Mutating executors ride the daemon's tool catalog, whose
//         Commander-gated implementations own the proposal gate — the same
//         approval flow as the Commander, so every side effect is still
//         approval-gated and lands as a card.
//
// Every fleet_* executor executes through the daemon catalog
// (mission_control.tools.execute -> createPaseoToolCatalog().executeTool), the
// SAME code path the Commander uses — voice never reimplements a fleet tool,
// only shapes the catalog result for speech. commander_dispatch /
// proposal_respond / pending_updates are the only local executors.
//
// Tool names/descriptions mirror the Commander contract (packages/server ...
// paseo-tools.ts); keep the two in sync when the allowlist changes.

const OBJECT = { type: "OBJECT" };

/** Shared read tools — same list in both modes. */
const READ_TOOL_DECLARATIONS = [
  {
    name: "fleet_list_inventory",
    description:
      "List hosts, projects, and workspaces across the fleet, optionally filtered by a spoken " +
      "name. THE resolve-first tool: when the user names a project, workspace, or host, call it " +
      "with that name as query and match by title — a name is never assumed to be a host. " +
      "Empty query returns the full inventory. Read-only; instant.",
    parameters: {
      ...OBJECT,
      properties: {
        query: {
          type: "STRING",
          description:
            "Fuzzy filter: case-insensitive match against project title/id, workspace " +
            "title/id/cwd, host name/alias. Omit for the full inventory.",
        },
        host: {
          type: "STRING",
          description:
            "Restrict to one host: a peer name from the daemon peers config, or 'local'. " +
            "Omitted → all hosts.",
        },
      },
      required: [],
    },
  },
  {
    name: "fleet_list_agents",
    description:
      "List agents across hosts: status, title, and host for each, newest first. Roster only — " +
      "for what an agent is doing use fleet_get_agent_activity; to find who worked on something " +
      "use fleet_search. Unreachable peers are listed with their host state. Read-only; instant.",
    parameters: {
      ...OBJECT,
      properties: {
        includeArchived: {
          type: "BOOLEAN",
          description: "Include archived agents (default false).",
        },
        sinceHours: {
          type: "NUMBER",
          description: "Only agents updated in the last N hours (default 48).",
        },
        statuses: {
          type: "ARRAY",
          items: { type: "STRING" },
          description:
            "Filter to these agent lifecycle statuses: initializing, idle, running, error, closed.",
        },
        bucket: {
          type: "STRING",
          description:
            "Filter to this lifecycle bucket (closed enum): needs_you, running, ready, done, idle.",
        },
        query: {
          type: "STRING",
          description:
            "Fuzzy agent-name resolution: case-insensitive match against agent name, title, or id. Use it to resolve a spoken agent name.",
        },
        limit: {
          type: "NUMBER",
          description: "Maximum roster rows to return (default 50).",
        },
      },
      required: [],
    },
  },
  {
    name: "fleet_list_models",
    description:
      "List invocable provider/model strings and the default worker model for ONE host " +
      "(default 'local'). Call it before spawning: fleet_create_agent's provider is always a " +
      "'provider/model' string, and the default worker model is what a spawn without a " +
      "user-named model uses. Never ask the user for a provider or model.",
    parameters: {
      ...OBJECT,
      properties: {
        host: {
          type: "STRING",
          description: "Target host: a peer name from the daemon peers config, or 'local'.",
        },
      },
      required: [],
    },
  },
  {
    name: "fleet_get_agent_activity",
    description:
      "Return a curated timeline summary for ONE agent on a host: recent user prompts, replies, " +
      "tool calls, and errors — from stored activity. Read-only: it does NOT poke the live agent " +
      "and is not a nudge. Pass the host from fleet_list_agents ('local' for this daemon) and the " +
      "agent id. For a fresh status from a live agent, use the send path (commander_dispatch in " +
      "relay, fleet_send_prompt in direct).",
    parameters: {
      ...OBJECT,
      properties: {
        host: {
          type: "STRING",
          description: "Target host: a peer name from the daemon peers config, or 'local'.",
        },
        agentId: { type: "STRING", description: "The agent id from fleet_list_agents." },
        limit: {
          type: "NUMBER",
          description: "Optional cap on activities (most recent first).",
        },
      },
      required: ["host", "agentId"],
    },
  },
  {
    name: "fleet_search",
    description:
      "Find which agents worked on something, across this daemon and reachable peer hosts. " +
      "Use for 'who worked on X'. fleet_list_agents is for rosters, never for searching. " +
      "deep:true spawns a history-ask agent when shallow search finds nothing — ask only then.",
    parameters: {
      ...OBJECT,
      properties: {
        query: {
          type: "STRING",
          description: "Search text: a name, title, PR URL, or phrase an agent's work mentions.",
        },
        limit: {
          type: "NUMBER",
          description: "Maximum matches to return (default 20).",
        },
        deep: {
          type: "BOOLEAN",
          description: "When true, deep-scan transcripts if shallow search finds nothing.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fleet_recall",
    description:
      "Semantic recall over fleet memory: run records, decisions, verdicts. THE lookup for " +
      "'which agent was that'. Read-only. If recall reports memory unavailable, route " +
      "the question through commander_dispatch (relay) — the Commander holds the memory bank.",
    parameters: {
      ...OBJECT,
      properties: {
        query: {
          type: "STRING",
          description: "What to recall: an agent, a decision, a piece of work.",
        },
        limit: {
          type: "NUMBER",
          description: "Maximum memories to return (default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fleet_context",
    description:
      "Fetch run records and workspace/project rollups from the mission-control store: pass " +
      "agentId, workspaceId, or projectId (or nothing for the most recent records). Read-only. " +
      "If the store is empty or unavailable, route through commander_dispatch (relay).",
    parameters: {
      ...OBJECT,
      properties: {
        workspaceId: { type: "STRING", description: "Optional workspace id." },
        projectId: { type: "STRING", description: "Optional project id." },
        agentId: { type: "STRING", description: "Optional agent id." },
      },
      required: [],
    },
  },
  {
    name: "tag_message",
    description:
      "Attribute the current voice user turn to the agents it concerns (audit trail). The " +
      "daemon tags the latest voice-mirrored user message on the Commander thread — the same " +
      "record the Commander's tag_message tool writes, read by the Verifier when auditing. " +
      "Call it once per handled user turn that names specific agents; fleet-wide remarks tag " +
      "all active roster ids. Never tag digest notifications.",
    parameters: {
      ...OBJECT,
      properties: {
        agentIds: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Agent ids this user message relates to.",
        },
      },
      required: ["agentIds"],
    },
  },
  {
    name: "fleet_agent_status",
    description:
      "One-call status for ONE agent: identity (name, title, description), lifecycle bucket, last " +
      "status, running-turn info, the last report_status headline/detail/time, and " +
      "workspace/project/host. fresh:true steers the agent to post a fresh report_status and waits " +
      "up to 60s (returns the last known status with fresh:false on timeout). Use it when the user " +
      "asks how a specific agent is doing. Read-only.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "The agent UUID from fleet_list_agents.",
        },
        fresh: {
          type: "BOOLEAN",
          description:
            "Steer the agent for a fresh report_status and wait up to 60s. Only on explicit request.",
        },
        host: {
          type: "STRING",
          description: "Optional host hint: a peer name from the daemon peers config, or 'local'.",
        },
      },
      required: ["agentId"],
    },
  },
];

/** Relay-only control tools. */
const RELAY_CONTROL_DECLARATIONS = [
  {
    name: "commander_dispatch",
    description:
      "Send the user's intent to the Commander agent as a user prompt. Returns immediately with " +
      "ok; the Commander does its normal thing (triage, doctrine, proposal cards) and results " +
      "arrive later as daemon pushes. Never await the turn. Use this for ANY work that changes " +
      "the fleet: spawn, steer, rename, archive, move, schedule, or nudge a live agent for a " +
      "fresh status.",
    parameters: {
      ...OBJECT,
      properties: {
        message: {
          type: "STRING",
          description:
            "The user's intent, as a prompt to the Commander, verbatim and self-contained.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "proposal_respond",
    description:
      "Approve or deny a pending mission-control proposal — the same RPC the app's proposal " +
      "cards use. Approve with an optional editedMessage to rewrite the message before it is " +
      "sent. For destructive-classified proposals the user must have said an explicit " +
      "'yes, approve'.",
    parameters: {
      ...OBJECT,
      properties: {
        proposalId: {
          type: "STRING",
          description:
            "The proposal id (mcp_...) — take it verbatim from a tool result's data or from pending_updates entries; never guess it.",
        },
        action: { type: "STRING", description: '"approve" or "deny".' },
        editedMessage: {
          type: "STRING",
          description: "Optional message rewrite before send (approve with edits).",
        },
      },
      required: ["proposalId", "action"],
    },
  },
  {
    name: "pending_updates",
    description:
      "Drain the update buffer: outcomes of work this session asked for, and Commander answers " +
      "that arrived while the user was not asking. Returns a spoken digest. Use ONLY when the " +
      "user asks for generic updates ('any updates?') — for a specific agent, use the read tools.",
    parameters: { ...OBJECT, properties: {}, required: [] },
  },
  {
    name: "fleet_monitor",
    description:
      "Watch agents and get told when they finish, fail, or block. Session-scoped: start/stop/status " +
      "watches over Mission Control events for THIS voice session. scope 'fleet' watches every agent; " +
      "scope 'agent' watches one agentId (start repeatedly for several). Announcements arrive as spoken " +
      "notifications between turns (queued while the user is mid-turn) — never poll. Proposals and " +
      "clarifications are always announced; blocked/error/finished only for watched scope; started and " +
      "mid-run milestones never. status lists active subscriptions. Use it when the user asks to be " +
      "told when something finishes or needs them.",
    parameters: {
      ...OBJECT,
      properties: {
        action: {
          type: "STRING",
          description:
            '"start" adds a watch, "stop" removes it, "status" lists this session\'s watches.',
        },
        scope: {
          type: "STRING",
          description: '"fleet" (every agent) or "agent" (the named agentId).',
        },
        agentId: {
          type: "STRING",
          description: "The agent UUID from fleet_list_agents; required when scope is 'agent'.",
        },
        host: {
          type: "STRING",
          description: "Optional host hint: a peer name from the daemon peers config, or 'local'.",
        },
      },
      required: ["action", "scope"],
    },
  },
];

/** Direct-mode-only control tools (mutating names declared; executors gate). */
const DIRECT_CONTROL_DECLARATIONS = [
  {
    name: "fleet_create_agent",
    description:
      "Create an agent on a specific host in the fleet. Approval-gated: creates a proposal the " +
      "user must approve; it does NOT run yet. host is a peer name or 'local'; cwd or " +
      "workspaceId is required when targeting a peer.",
    parameters: {
      ...OBJECT,
      properties: {
        host: {
          type: "STRING",
          description: "Target host: a peer name from the daemon peers config, or 'local'.",
        },
        provider: {
          type: "STRING",
          description:
            "Provider/model, e.g. omp/provider/model. Call fleet_list_models first for the " +
            "host's default worker model and use it when the user did not name a model. " +
            "Never ask the user for a provider or model.",
        },
        initialPrompt: { type: "STRING", description: "The agent's initial prompt / brief." },
        title: { type: "STRING", description: "Optional agent title." },
        cwd: {
          type: "STRING",
          description: "Working directory on the target host.",
        },
        workspaceId: { type: "STRING", description: "Optional workspace to place the agent in." },
      },
      required: ["host", "provider", "initialPrompt"],
    },
  },
  {
    name: "fleet_send_prompt",
    description:
      "Send a task to an existing agent on a host. Approval-gated: creates a proposal the user " +
      "must approve; it does NOT deliver yet. Also the nudge path: asking a live agent for a " +
      "fresh status ('ask them') goes here, not through fleet_get_agent_activity. mode: " +
      "'steer' (additive), 'interrupt' (cancel and replace), 'queue' (deliver when idle).",
    parameters: {
      ...OBJECT,
      properties: {
        host: {
          type: "STRING",
          description: "Target host: a peer name from the daemon peers config, or 'local'.",
        },
        agentId: { type: "STRING", description: "The agent id from fleet_list_agents." },
        prompt: { type: "STRING", description: "The prompt to deliver to the agent." },
        mode: {
          type: "STRING",
          description: "Delivery to a busy agent: steer, interrupt, or queue.",
        },
      },
      required: ["host", "agentId", "prompt"],
    },
  },
  {
    name: "fleet_rename_project",
    description:
      "Rename a project. projectId is a prj_ id from fleet_list_inventory — fleet-wide, no host " +
      "needed. Approval-gated: creates a proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        projectId: {
          type: "STRING",
          description: "Project id (prj_ + 16 hex) from fleet_list_inventory data.",
        },
        title: { type: "STRING", description: "The new project name." },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "fleet_rename_workspace",
    description:
      "Rename a workspace. workspaceId is a wks_ id from fleet_list_inventory — fleet-wide, no " +
      "host needed. Approval-gated: creates a proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        workspaceId: {
          type: "STRING",
          description: "Workspace id (wks_ + 16 hex) from fleet_list_inventory data.",
        },
        title: { type: "STRING", description: "The new workspace name." },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["workspaceId", "title"],
    },
  },
  {
    name: "fleet_rename_agent_title",
    description:
      "Change an agent's TITLE (agent names are write-once, never touched). agentId is an agent " +
      "UUID from fleet_list_agents — fleet-wide, no host needed. Approval-gated: creates a " +
      "proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "Agent UUID from fleet_list_agents/fleet_search data.",
        },
        title: { type: "STRING", description: "The new agent title." },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["agentId", "title"],
    },
  },
  {
    name: "fleet_archive_project",
    description:
      "Archive a project (its workspaces and their agents archive with it). projectId is a prj_ " +
      "id from fleet_list_inventory — fleet-wide, no host needed. DESTRUCTIVE: always asks the " +
      "user, even in auto mode.",
    parameters: {
      ...OBJECT,
      properties: {
        projectId: {
          type: "STRING",
          description: "Project id (prj_ + 16 hex) from fleet_list_inventory data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "fleet_archive_workspace",
    description:
      "Archive a workspace (its agents archive with it). workspaceId is a wks_ id from " +
      "fleet_list_inventory — fleet-wide, no host needed. DESTRUCTIVE: always asks the user, " +
      "even in auto mode.",
    parameters: {
      ...OBJECT,
      properties: {
        workspaceId: {
          type: "STRING",
          description: "Workspace id (wks_ + 16 hex) from fleet_list_inventory data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "fleet_archive_agent",
    description:
      "Archive an agent. agentId is an agent UUID from fleet_list_agents — fleet-wide, no host " +
      "needed. DESTRUCTIVE: always asks the user, even in auto mode.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "Agent UUID from fleet_list_agents/fleet_search data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "fleet_create_project",
    description:
      "Create a project at an absolute root path. host is REQUIRED — the new project root must " +
      "land somewhere (a peer name or 'local'). Approval-gated: creates a proposal the user must " +
      "approve.",
    parameters: {
      ...OBJECT,
      properties: {
        host: {
          type: "STRING",
          description: "Target host: a peer name from the daemon peers config, or 'local'.",
        },
        path: {
          type: "STRING",
          description: "Absolute filesystem path where the project root will be created.",
        },
        title: {
          type: "STRING",
          description: "Optional project display name (defaults to the root path's basename).",
        },
      },
      required: ["host", "path"],
    },
  },
  {
    name: "fleet_move_agent",
    description:
      "Move an agent to another workspace (same host; cross-host moves are refused). agentId is " +
      "an agent UUID from fleet_list_agents; workspaceId is a wks_ id from fleet_list_inventory — " +
      "both fleet-wide, no host needed. Refuses running agents. Approval-gated: creates a " +
      "proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "Agent UUID from fleet_list_agents/fleet_search data.",
        },
        workspaceId: {
          type: "STRING",
          description: "Workspace id (wks_ + 16 hex) from fleet_list_inventory data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["agentId", "workspaceId"],
    },
  },
  {
    name: "fleet_promote_workspace",
    description:
      "Promote a workspace in the per-host experiments project (~/experiments) to its own " +
      "project. workspaceId is a wks_ id from fleet_list_inventory — fleet-wide, no host needed. " +
      "Approval-gated: creates a proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        workspaceId: {
          type: "STRING",
          description: "Workspace id (wks_ + 16 hex) from fleet_list_inventory data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "fleet_adopt_agent",
    description:
      "Adopt an agent: stamp it as Commander-managed so the verifier audits its work — no " +
      "message is sent. agentId is an agent UUID from fleet_list_agents — fleet-wide, no host " +
      "needed. Approval-gated: creates a proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "Agent UUID from fleet_list_agents/fleet_search data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "fleet_release_agent",
    description:
      "Release an adopted agent: clear the Commander-management stamp so the verifier no longer " +
      "includes it. agentId is an agent UUID from fleet_list_agents — fleet-wide, no host needed. " +
      "Approval-gated: creates a proposal the user must approve.",
    parameters: {
      ...OBJECT,
      properties: {
        agentId: {
          type: "STRING",
          description: "Agent UUID from fleet_list_agents/fleet_search data.",
        },
        host: {
          type: "STRING",
          description:
            "Optional host hint: a peer name or 'local'. Omitted → resolved via the fleet index.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "clarify",
    description:
      "Ask the user a structured question when you cannot resolve which agent, workspace, or " +
      "project they mean, or the missing fact is one only they know. Voice has no card UI: ask " +
      "the question directly in your spoken reply and wait.",
    parameters: {
      ...OBJECT,
      properties: {
        question: { type: "STRING", description: "The single decision that blocks dispatch." },
        options: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Discrete options (1-8).",
        },
        allowFreeText: {
          type: "BOOLEAN",
          description:
            "Allow a free-text answer in addition to the options (true only when no option set can cover the answer space; default false).",
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "post_answer",
    description:
      "Record a fleet answer for the record (agent-status or generic). Voice mirrors every " +
      "spoken reply into the Commander thread already — speak the answer briefly; the mirror is " +
      "the record.",
    parameters: {
      ...OBJECT,
      properties: {
        headline: { type: "STRING", description: "One-line answer headline." },
        kind: {
          type: "STRING",
          description: '"agent_status" (about one agent) or "generic"; default "generic".',
        },
        agentId: {
          type: "STRING",
          description:
            "The agent the answer is about; required when kind is agent_status. The agent id from fleet_list_agents data.",
        },
        body: { type: "STRING", description: "Optional longer answer body." },
        fields: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              label: { type: "STRING", description: "Field label (state, host, last report...)." },
              value: {
                type: "STRING",
                description: "Field value; label the value, never paste raw ids.",
              },
            },
            required: ["label", "value"],
          },
          description: "Optional labeled rows for a structured answer (max 12).",
        },
        respondsTo: {
          type: "STRING",
          description:
            "The open instruction id this answer responds to (e.g. '#12'); the envelope lists open ids.",
        },
      },
      required: ["headline"],
    },
  },
];

/** Shared control tools present in both modes. */
const SHARED_CONTROL_DECLARATIONS = RELAY_CONTROL_DECLARATIONS.filter(
  (d) => d.name !== "commander_dispatch",
);

export function getToolDeclarations(voiceMode) {
  if (voiceMode === "direct") {
    return [
      ...READ_TOOL_DECLARATIONS,
      ...DIRECT_CONTROL_DECLARATIONS,
      ...SHARED_CONTROL_DECLARATIONS,
    ];
  }
  return [...READ_TOOL_DECLARATIONS, ...RELAY_CONTROL_DECLARATIONS];
}

/** Backward-compatible alias: the default relay surface. */
export const TOOL_DECLARATIONS = getToolDeclarations("relay");

// --- Per-tool executors -----------------------------------------------------
// Every fleet_* executor runs through the daemon catalog
// (mission_control.tools.execute -> createPaseoToolCatalog().executeTool), the
// SAME code path the Commander uses. Voice never reimplements a fleet tool;
// it only shapes the catalog's result for speech. Only commander_dispatch,
// proposal_respond, and pending_updates stay local (voice-specific protocol).

function executeFleetListInventory(daemon, argsObj) {
  return daemon.fleetListInventory(argsObj);
}

function executeFleetListAgents(daemon, argsObj) {
  return daemon.fleetListAgents(argsObj);
}

function executeFleetGetAgentActivity(daemon, argsObj) {
  return daemon.fleetGetAgentActivity(argsObj);
}

function executeFleetSearch(daemon, argsObj) {
  return daemon.fleetSearch(argsObj);
}

function executeFleetRecall(daemon, argsObj) {
  return daemon.fleetRecall(argsObj);
}

function executeFleetContext(daemon, argsObj) {
  return daemon.fleetContext(argsObj);
}

function executeTagMessage(daemon, argsObj) {
  return daemon.tagMessage(argsObj);
}

const BUCKET_LABELS = {
  needs_you: "needs you",
  running: "running",
  ready: "ready for review",
  done: "done",
  idle: "idle",
};

/** The spoken status line for a fleet_agent_status payload (ids never spoken). */
function buildAgentStatusSpoken(sc) {
  const name = sc.title || sc.name || (sc.agentId ? sc.agentId.slice(0, 7) : "the agent");
  const bucket = BUCKET_LABELS[sc.bucket] ?? sc.bucket ?? "unknown";
  const host = sc.host && sc.host !== "local" ? ` on ${sc.host}` : "";
  const report = sc.lastReport ? ` Last report: ${sc.lastReport.headline}.` : "";
  let freshNote = "";
  if (sc.fresh === true) {
    freshNote = " Fresh report received.";
  } else if (sc.note) {
    freshNote = ` ${sc.note}`;
  }
  return `${name} is ${bucket}${host}.${report}${freshNote}`;
}

/** The typed data payload for a fleet_agent_status result (ids verbatim). */
function buildAgentStatusData(sc, agentId) {
  return {
    agentId: sc.agentId ?? agentId,
    name: sc.name ?? null,
    title: sc.title ?? null,
    bucket: sc.bucket ?? null,
    lastStatus: sc.lastStatus ?? null,
    lastReport: sc.lastReport ?? null,
    host: sc.host ?? null,
    workspaceId: sc.workspaceId ?? null,
    projectId: sc.projectId ?? null,
    fresh: sc.fresh === true,
  };
}

/** fleet_agent_status: read-only, executed in the daemon catalog. */
async function executeFleetAgentStatus(daemon, argsObj) {
  const agentId = typeof argsObj.agentId === "string" ? argsObj.agentId : "";
  if (!agentId) {
    return { error: "fleet_agent_status requires agentId" };
  }
  const result = await daemon.executeCatalogTool("fleet_agent_status", {
    agentId,
    ...(argsObj.fresh === true ? { fresh: true } : {}),
    ...(typeof argsObj.host === "string" && argsObj.host ? { host: argsObj.host } : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_agent_status failed" };
  }
  const sc = result.structuredContent ?? {};
  return {
    spoken: buildAgentStatusSpoken(sc),
    data: buildAgentStatusData(sc, agentId),
  };
}

/**
 * fleet_monitor: session-scoped watches, executed in the daemon catalog. The
 * catalog's registry is authoritative per session; the returned subscription
 * list reconciles this connection's announce engine (monitored agents / fleet
 * scope) so the broadcast listener announces exactly the watched scope.
 */
async function executeFleetMonitor(daemon, argsObj) {
  const action = typeof argsObj.action === "string" ? argsObj.action : "";
  const scope = typeof argsObj.scope === "string" ? argsObj.scope : "";
  if (!action || !scope) {
    return { error: "fleet_monitor requires action and scope" };
  }
  const result = await daemon.executeCatalogTool("fleet_monitor", {
    action,
    scope,
    ...(typeof argsObj.agentId === "string" && argsObj.agentId ? { agentId: argsObj.agentId } : {}),
    ...(typeof argsObj.host === "string" && argsObj.host ? { host: argsObj.host } : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_monitor failed" };
  }
  const sc = result.structuredContent ?? {};
  const subscriptions = Array.isArray(sc.subscriptions) ? sc.subscriptions : [];
  // Reconcile the local announce engine with the daemon's authoritative
  // registry so the broadcast listener announces exactly the watched scope.
  daemon.syncMonitorSubscriptions(subscriptions);
  const describe = (sub) =>
    sub.scope === "fleet" ? "the whole fleet" : `agent ${String(sub.agentId).slice(0, 7)}`;
  if (action === "status") {
    return {
      spoken:
        subscriptions.length === 0
          ? "You are not monitoring anything right now."
          : `Monitoring ${subscriptions.map(describe).join(", ")}. Terminal events for watched agents will be announced.`,
      data: { subscriptions },
    };
  }
  if (action === "start") {
    const added = subscriptions.filter((sub) =>
      scope === "fleet" ? sub.scope === "fleet" : sub.agentId === argsObj.agentId,
    );
    return {
      spoken:
        added.length === 0
          ? `Already monitoring ${scope === "fleet" ? "the whole fleet" : `agent ${String(argsObj.agentId).slice(0, 7)}`}.`
          : `Now monitoring ${added.map(describe).join(", ")}. I'll tell you when they finish, fail, or need you.`,
      data: { subscriptions },
    };
  }
  const stoppedLabel =
    scope === "fleet" ? "the whole fleet" : `agent ${String(argsObj.agentId).slice(0, 7)}`;
  return {
    spoken:
      subscriptions.length > 0
        ? `Stopped monitoring ${stoppedLabel}. Still monitoring ${subscriptions.map(describe).join(", ")}.`
        : "Stopped. You are not monitoring anything now.",
    data: { subscriptions },
  };
}

async function executeFleetListModels(daemon, argsObj) {
  const result = await daemon.executeCatalogTool("fleet_list_models", argsObj);
  if (!result.ok) {
    return { error: result.error ?? "fleet_list_models failed" };
  }
  const sc = result.structuredContent ?? {};
  const host = sc.host || "local";
  const defaultWorkerModel = sc.defaultWorkerModel ?? null;
  const modelLines = [];
  for (const [provider, models] of Object.entries(sc.models ?? {})) {
    if (provider === "omp.modelRoles") {
      // Role -> model mappings are the omp internal notation, never a
      // spawnable provider string; the default worker model already resolved
      // them. Skip so the model never echoes a bare role as a provider.
      continue;
    }
    modelLines.push(`${provider}: ${Array.isArray(models) ? models.join(", ") : String(models)}`);
  }
  const head = defaultWorkerModel
    ? `Default worker model on ${host}: ${defaultWorkerModel}.`
    : `No default worker model on ${host}.`;
  const body = modelLines.length > 0 ? ` Models: ${modelLines.join("; ")}.` : "";
  return {
    spoken: `${head}${body}`,
    data: { host, defaultWorkerModel },
  };
}

async function executeCommanderDispatch(daemon, argsObj, mode) {
  if (mode === "direct") {
    return { error: "commander_dispatch is not declared in direct mode" };
  }
  const message = typeof argsObj.message === "string" ? argsObj.message : "";
  if (!message) {
    return { error: "commander_dispatch requires a non-empty message" };
  }
  const outcome = await daemon.dispatch(message);
  if (outcome.ok) {
    return {
      spoken: "Dispatched to the Commander — on it.",
      data: { agentId: outcome.agentId ?? null },
    };
  }
  return { error: outcome.error };
}

async function executeProposalRespond(daemon, argsObj) {
  const proposalId = typeof argsObj.proposalId === "string" ? argsObj.proposalId : "";
  const action = typeof argsObj.action === "string" ? argsObj.action : "";
  const editedMessage =
    typeof argsObj.editedMessage === "string" ? argsObj.editedMessage : undefined;
  if (!proposalId || !action) {
    return { error: "proposal_respond requires proposalId and action" };
  }
  const outcome = await daemon.respondProposal({ proposalId, action, editedMessage });
  if (outcome.ok) {
    return {
      spoken: `Proposal ${action === "approve" ? "approved" : "denied"}.`,
      data: { proposalId, action },
    };
  }
  return { error: outcome.error };
}

async function executePendingUpdates(daemon, argsObj, mode, ctx) {
  const digest = daemon.drainUpdates();
  // Voice P0 ledger (spec 05): still-open instruction rows ride the digest
  // so nothing silently drops ("Open: #12 spawn worker in paseo — #13 …").
  const openLine =
    typeof ctx?.getOpenInstructionsLine === "function"
      ? ((await ctx.getOpenInstructionsLine()) ?? "")
      : "";
  if (!openLine) {
    return digest;
  }
  const spoken = digest.spoken ? `${digest.spoken} ${openLine}.` : `${openLine}.`;
  return { spoken, data: { ...digest.data, openInstructions: openLine } };
}

/** The proposal id embedded in a spawn outcome's structured fields or its
 * guidance copy ("(proposal mcp_…)"), null when the spawn was not gated. */
function extractSpawnProposalId(sc) {
  if (typeof sc.proposalId === "string" && sc.proposalId) {
    return sc.proposalId;
  }
  if (typeof sc.guidance === "string") {
    return (sc.guidance.match(/\(proposal (mcp_[A-Za-z0-9]+)\)/) ?? [])[1] ?? null;
  }
  return null;
}

/** The spoken line for a gated spawn outcome: the cleaned guidance when the
 * catalog supplied one, else the pending/plain status line. */
function buildSpawnProposalSpoken(sc) {
  if (typeof sc.guidance === "string" && sc.guidance) {
    return (
      sc.guidance.replace(/\(proposal (mcp_[A-Za-z0-9]+)\)\s*/, "").trim() ||
      "Spawn request sent for approval."
    );
  }
  if (sc.status === "pending-approval") {
    return "Spawn request sent for approval.";
  }
  return "Spawn request sent.";
}

async function executeFleetCreateAgent(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "fleet_create_agent is not declared in relay mode" };
  }
  const { host, provider, initialPrompt, title, cwd, workspaceId, respondsTo } = argsObj;
  if (!host || !provider || !initialPrompt) {
    return { error: "fleet_create_agent requires host, provider, and initialPrompt" };
  }
  // The catalog's Commander-gated spawn: creates the approval proposal
  // (ask mode) or the agent (auto mode). Voice just relays the outcome.
  const result = await daemon.executeCatalogTool("fleet_create_agent", {
    host,
    provider,
    initialPrompt,
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    // M8 ledger: citing the open instruction id closes the row (spec 05).
    ...(typeof respondsTo === "string" && respondsTo ? { respondsTo } : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_create_agent failed" };
  }
  const sc = result.structuredContent ?? {};
  // The catalog embeds the proposal id in its guidance copy ("(proposal
  // mcp_…)") and does not carry it as a structured field yet — extract it so
  // data carries the id while the spoken guidance keeps no raw id.
  const proposalId = extractSpawnProposalId(sc);
  if (proposalId) {
    return { spoken: buildSpawnProposalSpoken(sc), data: { proposalId } };
  }
  if (sc.agentId) {
    return {
      spoken: `Agent created on ${host}.`,
      data: {
        agentId: sc.agentId,
        ...(sc.workspaceId ? { workspaceId: sc.workspaceId } : {}),
      },
    };
  }
  return { spoken: "Spawn request created.", data: {} };
}
async function executeFleetSendPrompt(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "fleet_send_prompt is not declared in relay mode" };
  }
  const { host, agentId, prompt, mode: deliveryMode, respondsTo } = argsObj;
  if (!host || !agentId || !prompt) {
    return { error: "fleet_send_prompt requires host, agentId, and prompt" };
  }
  const result = await daemon.executeCatalogTool("fleet_send_prompt", {
    host,
    agentId,
    prompt,
    ...(deliveryMode ? { mode: deliveryMode } : {}),
    // M8 ledger: citing the open instruction id closes the row (spec 05).
    ...(typeof respondsTo === "string" && respondsTo ? { respondsTo } : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_send_prompt failed" };
  }
  const sc = result.structuredContent ?? {};
  if (typeof sc.guidance === "string" && sc.guidance) {
    return { spoken: sc.guidance, data: { agentId: agentId ?? null } };
  }
  if (sc.success === true) {
    return {
      spoken: `Delivered to the agent${sc.deliveryMode ? ` (${sc.deliveryMode})` : ""}.`,
      data: { agentId: agentId ?? null, deliveryMode: sc.deliveryMode ?? null },
    };
  }
  return { spoken: "Send request created.", data: { agentId: agentId ?? null } };
}

/** The 11 split meta tools (04): one shared executor — each rides the daemon's
 * catalog (same Commander-gated approval flow, same proposal gate), shaped for
 * speech with the dual-channel {spoken, data} contract (ids never spoken). */
const META_SPLIT_TOOL_NAMES = [
  "fleet_rename_project",
  "fleet_rename_workspace",
  "fleet_rename_agent_title",
  "fleet_archive_project",
  "fleet_archive_workspace",
  "fleet_archive_agent",
  "fleet_create_project",
  "fleet_move_agent",
  "fleet_promote_workspace",
  "fleet_adopt_agent",
  "fleet_release_agent",
];

async function executeFleetMetaSplit(daemon, argsObj, mode, toolName) {
  if (mode !== "direct") {
    return { error: `${toolName} is not declared in relay mode` };
  }
  const result = await daemon.executeCatalogTool(toolName, {
    ...argsObj,
    // M8 ledger: citing the open instruction id closes the row (spec 05).
    ...(typeof argsObj.respondsTo === "string" && argsObj.respondsTo
      ? { respondsTo: argsObj.respondsTo }
      : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? `${toolName} failed` };
  }
  const sc = result.structuredContent ?? {};
  if (sc.ok === true && sc.proposalId) {
    return sc.status === "sent"
      ? { spoken: "Meta action applied.", data: { proposalId: sc.proposalId } }
      : { spoken: "Meta proposal created for approval.", data: { proposalId: sc.proposalId } };
  }
  if (sc.ok === true) {
    return { spoken: "Meta request created.", data: {} };
  }
  return { spoken: "Meta request created.", data: {} };
}

async function executeClarify(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "clarify is not declared in relay mode" };
  }
  const question = typeof argsObj.question === "string" ? argsObj.question : "";
  if (!question) {
    return { error: "clarify requires a question" };
  }
  const result = await daemon.executeCatalogTool("clarify", {
    question,
    ...(Array.isArray(argsObj.options) && argsObj.options.length > 0
      ? { options: argsObj.options }
      : {}),
    ...(typeof argsObj.allowFreeText === "boolean" ? { allowFreeText: argsObj.allowFreeText } : {}),
    // M8 ledger: citing the open instruction id closes the row (spec 05).
    ...(typeof argsObj.respondsTo === "string" && argsObj.respondsTo
      ? { respondsTo: argsObj.respondsTo }
      : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "clarify failed" };
  }
  // The catalog recorded the clarification card for the record; voice has no
  // card UI, so the model asks in speech.
  const sc = result.structuredContent ?? {};
  return {
    spoken: "Ask the user the question directly in your spoken reply and wait for their answer.",
    data: { eventId: sc.eventId ?? null },
  };
}
async function executePostAnswer(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "post_answer is not declared in relay mode" };
  }
  const headline = typeof argsObj.headline === "string" ? argsObj.headline : "";
  if (!headline) {
    return { error: "post_answer requires a headline" };
  }
  const result = await daemon.executeCatalogTool("post_answer", {
    headline,
    kind: typeof argsObj.kind === "string" ? argsObj.kind : "generic",
    ...(typeof argsObj.agentId === "string" ? { agentId: argsObj.agentId } : {}),
    ...(typeof argsObj.body === "string" ? { body: argsObj.body } : {}),
    ...(Array.isArray(argsObj.fields) && argsObj.fields.length > 0
      ? { fields: argsObj.fields }
      : {}),
    // M8 ledger: citing the open instruction id closes the row (spec 05).
    ...(typeof argsObj.respondsTo === "string" && argsObj.respondsTo
      ? { respondsTo: argsObj.respondsTo }
      : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "post_answer failed" };
  }
  // The mirror already records every spoken reply on the Commander thread.
  const sc = result.structuredContent ?? {};
  return {
    spoken: "Speak the answer briefly; the voice mirror records it for the record.",
    data: { eventId: sc.eventId ?? null },
  };
}
/** Tool name -> executor, matching the declared tool surface above. */
const TOOL_HANDLERS = {
  fleet_list_inventory: executeFleetListInventory,
  fleet_list_agents: executeFleetListAgents,
  fleet_list_models: executeFleetListModels,
  fleet_get_agent_activity: executeFleetGetAgentActivity,
  fleet_search: executeFleetSearch,
  fleet_recall: executeFleetRecall,
  fleet_context: executeFleetContext,
  fleet_agent_status: executeFleetAgentStatus,
  tag_message: executeTagMessage,
  commander_dispatch: executeCommanderDispatch,
  proposal_respond: executeProposalRespond,
  pending_updates: executePendingUpdates,
  fleet_monitor: executeFleetMonitor,
  fleet_create_agent: executeFleetCreateAgent,
  fleet_send_prompt: executeFleetSendPrompt,
  ...Object.fromEntries(
    META_SPLIT_TOOL_NAMES.map((name) => [
      name,
      (daemon, argsObj, mode) => executeFleetMetaSplit(daemon, argsObj, mode, name),
    ]),
  ),
  // Legacy alias: the daemon keeps fleet_meta registered for older callers
  // (see paseo-tools); route it through the same split executor.
  fleet_meta: (daemon, argsObj, mode) => executeFleetMetaSplit(daemon, argsObj, mode, "fleet_meta"),
  clarify: executeClarify,
  post_answer: executePostAnswer,
};

/** Execute one tool. `ctx` carries the daemon connection and the voice mode
 * (mode changes how unavailable tools advise the model). */
export async function executeTool(name, args, ctx) {
  const daemon = ctx.daemon;
  const mode = ctx.voiceMode === "direct" ? "direct" : "relay";
  const argsObj = args && typeof args === "object" ? args : {};
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  return handler(daemon, argsObj, mode, ctx);
}
