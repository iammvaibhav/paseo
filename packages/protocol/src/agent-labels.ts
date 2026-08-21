export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const SELECTION_ASK_LABEL = "paseo.selection-ask";
export const SELECTION_ASK_SOURCE_LABEL = "paseo.selection-ask.source-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

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
