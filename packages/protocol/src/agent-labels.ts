export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const SELECTION_ASK_LABEL = "paseo.selection-ask";
export const SELECTION_ASK_SOURCE_LABEL = "paseo.selection-ask.source-agent-id";

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
