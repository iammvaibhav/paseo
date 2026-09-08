export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const SELECTION_ASK_LABEL = "paseo.selection-ask";
export const SELECTION_ASK_SOURCE_LABEL = "paseo.selection-ask.source-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";
export const ITSAPLAN_ISSUE_LABEL_KEY = "itsaplan.issue";

/**
 * DUPLICATED in `packages/server/src/server/itsaplan/bridge.ts` (verbatim,
 * same candidate keys and parsing rules). The server copy exists because
 * `packages/server`'s shared checkout `node_modules/@getpaseo/protocol`
 * symlink can resolve to a different (built) checkout than this worktree's
 * source, so server code importing this file risks running a stale
 * `dist/agent-labels.js`. Keep both copies in lockstep: any new candidate
 * key or parsing rule added here MUST be mirrored in bridge.ts, and vice
 * versa (PASEO-38).
 */
export const ITSAPLAN_ISSUE_LABEL_CANDIDATE_KEYS = [
  ITSAPLAN_ISSUE_LABEL_KEY,
  "itsaplanIssue",
  "itsaplan_issue",
  "itsaplan-issue",
  "itsaplan.issueId",
  "itsaplan.issue_id",
  "itsaplanIssueId",
  "itsaplan_issue_id",
  "itsaplan.ticket",
  "itsaplanTicket",
  "itsaplan_ticket",
  "issueId",
  "issue_id",
  "issue",
  "ticketId",
  "ticket_id",
  "ticket",
] as const;

export function parseItsaplanIssueId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
      return String(Number(trimmed));
    }
    const match = /^(?:[A-Za-z][A-Za-z0-9_]*[-_])?#?(\d+)$/.exec(trimmed);
    if (match && match[1] && Number(match[1]) > 0) {
      return String(Number(match[1]));
    }
  }
  return null;
}

export function getItsaplanIssueIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  if (!labels || typeof labels !== "object") {
    return null;
  }
  for (const key of ITSAPLAN_ISSUE_LABEL_CANDIDATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(labels, key)) {
      const parsed = parseItsaplanIssueId(labels[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function isSelectionAskAgent(agent: AgentLabelSource): boolean {
  return agent.labels?.[SELECTION_ASK_LABEL] === "1";
}

export function getSelectionAskSourceAgentId(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const sourceId = labels?.[SELECTION_ASK_SOURCE_LABEL];
  return typeof sourceId === "string" && sourceId.trim().length > 0 ? sourceId.trim() : null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
