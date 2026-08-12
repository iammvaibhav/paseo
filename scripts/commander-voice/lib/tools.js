// Commander Voice — the four-tool surface and their server-side executors.
// Gemini function declarations (Live API schema) + plain async executors that
// hit the daemon. Voice never gets a mutating fleet tool.

export const TOOL_DECLARATIONS = [
  {
    name: "fleet_status",
    description:
      "Get a spoken summary of agents on the connected host: how many are running or starting, idle, errored or closed, which need your attention, how many proposals await approval, and the Commander's state. Counts are local to this host. For fleet-wide or per-agent status, use commander_dispatch. No Commander involved; instant.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: [],
    },
  },
  {
    name: "commander_dispatch",
    description:
      "Send the user's intent to the Commander agent as a user prompt. Returns immediately with ok; the Commander does its normal thing (triage, doctrine, proposal cards) and results arrive later as daemon pushes. Never await the turn. Use this for any work the user wants placed on the fleet.",
    parameters: {
      type: "OBJECT",
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
      "Approve or deny a pending mission-control proposal — the same RPC the app's proposal cards use. Approve with an optional editedMessage to rewrite the message before it is sent. For destructive-classified proposals the user must have said an explicit 'yes, approve'.",
    parameters: {
      type: "OBJECT",
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
      "Drain the update buffer: completions, verdicts, blocked items, Commander answers that arrived while the user was not asking. Returns a spoken digest. Use when the user asks 'any updates?' or similar.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: [],
    },
  },
];

/**
 * Execute one tool. `ctx` carries the daemon connection (and marks a pending
 * dispatch so Commander answers are spoken rather than buffered).
 */
export async function executeTool(name, args, ctx) {
  const daemon = ctx.daemon;
  switch (name) {
    case "fleet_status":
      return { result: await daemon.fetchFleetStatus() };
    case "commander_dispatch": {
      const message = args && typeof args.message === "string" ? args.message : "";
      if (!message) {
        return { error: "commander_dispatch requires a non-empty message" };
      }
      const outcome = await daemon.dispatch(message);
      if (outcome.ok) {
        return { result: "Dispatched to the Commander — on it." };
      }
      return { error: outcome.error };
    }
    case "proposal_respond": {
      const proposalId = args && typeof args.proposalId === "string" ? args.proposalId : "";
      const action = args && typeof args.action === "string" ? args.action : "";
      const editedMessage =
        args && typeof args.editedMessage === "string" ? args.editedMessage : undefined;
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
    case "pending_updates":
      return { result: daemon.drainUpdates() };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
