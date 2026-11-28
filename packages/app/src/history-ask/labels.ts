export const HISTORY_ASK_LABEL_KEY = "paseo.history-ask";
export const HISTORY_ASK_LABEL_VALUE = "1";
export const HISTORY_ASK_SCOPE_LABEL_KEY = "paseo.history-ask.scope";
export const HISTORY_ASK_PROJECT_ID_LABEL_KEY = "paseo.history-ask.project-id";
export const HISTORY_ASK_WORKSPACE_ID_LABEL_KEY = "paseo.history-ask.workspace-id";

export type HistoryAskScopeKind = "workspace" | "project" | "host";

export function isHistoryAskAgent(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[HISTORY_ASK_LABEL_KEY] === HISTORY_ASK_LABEL_VALUE;
}

export function historyAskLabels(input: {
  scope: HistoryAskScopeKind;
  projectId?: string | null;
  workspaceId?: string | null;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [HISTORY_ASK_LABEL_KEY]: HISTORY_ASK_LABEL_VALUE,
    [HISTORY_ASK_SCOPE_LABEL_KEY]: input.scope,
  };

  const projectId = input.projectId?.trim();
  if (projectId) {
    labels[HISTORY_ASK_PROJECT_ID_LABEL_KEY] = projectId;
  }

  const workspaceId = input.workspaceId?.trim();
  if (workspaceId) {
    labels[HISTORY_ASK_WORKSPACE_ID_LABEL_KEY] = workspaceId;
  }

  return labels;
}
