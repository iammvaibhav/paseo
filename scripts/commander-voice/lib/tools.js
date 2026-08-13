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
          description: "Filter to these agent statuses (running, idle, error, closed, ...).",
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
          description: "The proposal id, e.g. mcp_... from the announcement.",
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
    name: "fleet_meta",
    description:
      "Apply a fleet meta action (rename/archive a project, workspace, or agent; create a " +
      "project; move an agent; promote an experiment workspace). Approval-gated; archives always " +
      "ask. metaPlan: { action, targetId?, targetLabel?, newValue?, destination? }.",
    parameters: {
      ...OBJECT,
      properties: {
        metaPlan: {
          type: "OBJECT",
          description: "The meta action plan: action, targetId/targetLabel, newValue, destination.",
        },
      },
      required: ["metaPlan"],
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
          description: '"generic" or "agent_status" (about one agent; default "generic").',
        },
        body: { type: "STRING", description: "Optional longer answer body." },
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
  return { result: `${head}${body}` };
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
    return { result: "Dispatched to the Commander — on it." };
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
      result: `Proposal ${proposalId} ${action === "approve" ? "approved" : "denied"}.`,
    };
  }
  return { error: outcome.error };
}

function executePendingUpdates(daemon) {
  return { result: daemon.drainUpdates() };
}

async function executeFleetCreateAgent(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "fleet_create_agent is not declared in relay mode" };
  }
  const { host, provider, initialPrompt, title, cwd, workspaceId } = argsObj;
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
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_create_agent failed" };
  }
  const sc = result.structuredContent ?? {};
  if (typeof sc.guidance === "string" && sc.guidance) {
    return { result: sc.guidance };
  }
  if (sc.agentId) {
    return { result: `Agent ${sc.agentId} created on ${host}.` };
  }
  return { result: "Spawn request created." };
}

async function executeFleetSendPrompt(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "fleet_send_prompt is not declared in relay mode" };
  }
  const { host, agentId, prompt, mode: deliveryMode } = argsObj;
  if (!host || !agentId || !prompt) {
    return { error: "fleet_send_prompt requires host, agentId, and prompt" };
  }
  const result = await daemon.executeCatalogTool("fleet_send_prompt", {
    host,
    agentId,
    prompt,
    ...(deliveryMode ? { mode: deliveryMode } : {}),
  });
  if (!result.ok) {
    return { error: result.error ?? "fleet_send_prompt failed" };
  }
  const sc = result.structuredContent ?? {};
  if (typeof sc.guidance === "string" && sc.guidance) {
    return { result: sc.guidance };
  }
  if (sc.success === true) {
    return {
      result: `Delivered to the agent${sc.deliveryMode ? ` (${sc.deliveryMode})` : ""}.`,
    };
  }
  return { result: "Send request created." };
}

async function executeFleetMeta(daemon, argsObj, mode) {
  if (mode !== "direct") {
    return { error: "fleet_meta is not declared in relay mode" };
  }
  const plan = argsObj.metaPlan;
  if (!plan || !plan.action) {
    return { error: "fleet_meta requires metaPlan.action" };
  }
  const result = await daemon.executeCatalogTool("fleet_meta", { metaPlan: plan });
  if (!result.ok) {
    return { error: result.error ?? "fleet_meta failed" };
  }
  const sc = result.structuredContent ?? {};
  if (sc.ok === true && sc.proposalId) {
    return sc.status === "sent"
      ? { result: `Meta action ${plan.action} sent (proposal ${sc.proposalId}).` }
      : { result: `Meta proposal ${sc.proposalId} created for approval.` };
  }
  if (sc.ok === true) {
    return { result: `Meta action ${plan.action} done.` };
  }
  return { result: "Meta request created." };
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
  });
  if (!result.ok) {
    return { error: result.error ?? "clarify failed" };
  }
  // The catalog recorded the clarification card for the record; voice has no
  // card UI, so the model asks in speech.
  return {
    result: "Ask the user the question directly in your spoken reply and wait for their answer.",
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
  });
  if (!result.ok) {
    return { error: result.error ?? "post_answer failed" };
  }
  // The mirror already records every spoken reply on the Commander thread.
  return { result: "Speak the answer briefly; the voice mirror records it for the record." };
}

/** Tool name -> executor, matching the declared tool surface above. */
const TOOL_HANDLERS = {
  fleet_list_agents: executeFleetListAgents,
  fleet_list_models: executeFleetListModels,
  fleet_get_agent_activity: executeFleetGetAgentActivity,
  fleet_search: executeFleetSearch,
  fleet_recall: executeFleetRecall,
  fleet_context: executeFleetContext,
  tag_message: executeTagMessage,
  commander_dispatch: executeCommanderDispatch,
  proposal_respond: executeProposalRespond,
  pending_updates: executePendingUpdates,
  fleet_create_agent: executeFleetCreateAgent,
  fleet_send_prompt: executeFleetSendPrompt,
  fleet_meta: executeFleetMeta,
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
  return handler(daemon, argsObj, mode);
}
