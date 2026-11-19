import { isCommanderOrMachineryLabels } from "@getpaseo/protocol/mission-control/system-owned";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { memoizeOnSessionMaps } from "./memoize-on-session-maps";
import { deriveSidebarLifecycleBucket } from "./sidebar-agent-state";

export type FaviconStatus = "none" | "running" | "attention";

interface FaviconAgentSession {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, Pick<WorkspaceDescriptor, "background">>;
}

interface FaviconAgentSource {
  sessions: Record<string, FaviconAgentSession | undefined>;
}

/**
 * The favicon is the only always-mounted consumer of the whole agent directory, so derive its
 * three states here instead of building the aggregated agent list: the list allocates a
 * projection per agent, deep-compares it and sorts every agent on the host on each update.
 */
export interface FaviconStatusOptions {
  /** Count agents in background workspaces too, as the sidebar shows them while Show background is on. */
  showBackground?: boolean;
  /** Mission Control verbose is off: the Commander and machinery agents stay hidden, so they never light it. */
  hideMachinery?: boolean;
}

export function deriveFaviconStatus(
  state: FaviconAgentSource,
  options: FaviconStatusOptions = {},
): FaviconStatus {
  let needsYou = false;
  for (const session of Object.values(state.sessions)) {
    if (!session) continue;
    for (const agent of session.agents.values()) {
      if (agent.background || agent.archivedAt) continue;
      if (!options.showBackground && isInBackgroundWorkspace(agent, session)) continue;
      if (options.hideMachinery && isCommanderOrMachineryLabels(agent.labels)) continue;
      // The same lifecycle bucket the sidebar shows: a finished agent waiting for review is not
      // asking for anything, so only "needs you" lights the attention favicon.
      const bucket = deriveSidebarLifecycleBucket({
        bucket: agent.bucket,
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        attentionReason: agent.attentionReason,
        stoppedBy: agent.stoppedBy,
      });
      if (bucket === "running") return "running";
      if (bucket === "needs_you") needsYou = true;
    }
  }
  return needsYou ? "attention" : "none";
}

function isInBackgroundWorkspace(agent: Agent, session: FaviconAgentSession): boolean {
  return agent.workspaceId ? session.workspaces.get(agent.workspaceId)?.background === true : false;
}

/** A session-store selector for the favicon status that rescans only when an agent or workspace map changes. */
export function createFaviconStatusSelector(
  options: FaviconStatusOptions = {},
): (state: FaviconAgentSource) => FaviconStatus {
  return memoizeOnSessionMaps<FaviconAgentSession, FaviconAgentSource, FaviconStatus>(
    (session) => [session.agents, session.workspaces],
    (state) => deriveFaviconStatus(state, options),
  );
}
