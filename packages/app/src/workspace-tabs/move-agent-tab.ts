export interface MoveAgentTabClient {
  moveAgentToWorkspace(
    agentId: string,
    workspaceId: string,
  ): Promise<{ agentId: string; workspaceId: string }>;
  createWorkspace(input: {
    source: { kind: "directory"; path: string; projectId?: string };
    title?: string;
  }): Promise<{ error?: string | null; workspace?: { id: string; name?: string | null } | null }>;
}

export interface MoveAgentTabAgent {
  status: string;
}

export interface MoveAgentTabWorkspace {
  id: string;
  name: string;
  projectId?: string | null;
  workspaceDirectory?: string | null;
}

export interface MoveAgentTabSession {
  client: MoveAgentTabClient | null;
  agents: Map<string, MoveAgentTabAgent>;
  agentDetails?: Map<string, MoveAgentTabAgent>;
  workspaces: Map<string, MoveAgentTabWorkspace>;
}

interface SessionStoreClient {
  moveAgentToWorkspace?: MoveAgentTabClient["moveAgentToWorkspace"];
  createWorkspace?: MoveAgentTabClient["createWorkspace"];
}

interface SessionStoreSnapshot {
  client: SessionStoreClient | null;
  agents: Map<string, MoveAgentTabAgent>;
  agentDetails?: Map<string, MoveAgentTabAgent>;
  workspaces: Map<string, MoveAgentTabWorkspace>;
}

export interface MoveAgentTabLayout {
  closeTab(workspaceKey: string, tabId: string): void;
  openTab(input: {
    workspaceKey: string;
    target: { kind: "agent"; agentId: string };
    intent: "reveal";
  }): unknown;
}

export interface MoveAgentTabNavigation {
  navigateToWorkspace(input: {
    serverId: string;
    workspaceId: string;
    target: { kind: "agent"; agentId: string };
  }): unknown;
}

export interface MoveAgentTabMessages {
  daemonClientUnavailable: string;
  agentRunningCannotMove: string;
  workspacePathUnavailable: string;
  createFailed: string;
  moveFailed: string;
}

export type MoveAgentTabFailureReason =
  | "no-client"
  | "agent-running"
  | "no-source-directory"
  | "create-failed"
  | "move-failed";

export type MoveAgentTabResult =
  | { ok: true; targetWorkspaceId: string; created: boolean }
  | { ok: false; reason: MoveAgentTabFailureReason; message: string };

function resolveAgent(
  session: MoveAgentTabSession,
  agentId: string,
): MoveAgentTabAgent | undefined {
  return session.agents.get(agentId) ?? session.agentDetails?.get(agentId);
}

function requireClient(
  session: MoveAgentTabSession,
  messages: MoveAgentTabMessages,
): { ok: true; client: MoveAgentTabClient } | { ok: false; result: MoveAgentTabResult } {
  if (!session.client) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "no-client",
        message: messages.daemonClientUnavailable,
      },
    };
  }
  return { ok: true, client: session.client };
}

function refuseIfRunning(
  session: MoveAgentTabSession,
  agentId: string,
  messages: MoveAgentTabMessages,
): MoveAgentTabResult | null {
  const agent = resolveAgent(session, agentId);
  if (agent?.status === "running") {
    return {
      ok: false,
      reason: "agent-running",
      message: messages.agentRunningCannotMove,
    };
  }
  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function applyMove(input: {
  client: MoveAgentTabClient;
  serverId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  agentId: string;
  tabId: string;
  layout: MoveAgentTabLayout;
  navigation: MoveAgentTabNavigation;
  messages: MoveAgentTabMessages;
  created: boolean;
  openTargetTab: boolean;
}): Promise<MoveAgentTabResult> {
  try {
    await input.client.moveAgentToWorkspace(input.agentId, input.targetWorkspaceId);
  } catch (error) {
    return {
      ok: false,
      reason: "move-failed",
      message: errorMessage(error, input.messages.moveFailed),
    };
  }

  input.layout.closeTab(`${input.serverId}:${input.sourceWorkspaceId}`, input.tabId);
  if (input.openTargetTab) {
    input.layout.openTab({
      workspaceKey: `${input.serverId}:${input.targetWorkspaceId}`,
      target: { kind: "agent", agentId: input.agentId },
      intent: "reveal",
    });
  }
  input.navigation.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.targetWorkspaceId,
    target: { kind: "agent", agentId: input.agentId },
  });
  return {
    ok: true,
    targetWorkspaceId: input.targetWorkspaceId,
    created: input.created,
  };
}

export async function moveAgentTabToExistingWorkspace(input: {
  session: MoveAgentTabSession;
  layout: MoveAgentTabLayout;
  navigation: MoveAgentTabNavigation;
  messages: MoveAgentTabMessages;
  serverId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  agentId: string;
  tabId: string;
}): Promise<MoveAgentTabResult> {
  const clientResult = requireClient(input.session, input.messages);
  if (!clientResult.ok) return clientResult.result;
  const running = refuseIfRunning(input.session, input.agentId, input.messages);
  if (running) return running;

  return applyMove({
    client: clientResult.client,
    serverId: input.serverId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    targetWorkspaceId: input.targetWorkspaceId,
    agentId: input.agentId,
    tabId: input.tabId,
    layout: input.layout,
    navigation: input.navigation,
    messages: input.messages,
    created: false,
    openTargetTab: true,
  });
}

export async function moveAgentTabToNewWorkspace(input: {
  session: MoveAgentTabSession;
  layout: MoveAgentTabLayout;
  navigation: MoveAgentTabNavigation;
  messages: MoveAgentTabMessages;
  serverId: string;
  sourceWorkspaceId: string;
  agentId: string;
  tabId: string;
}): Promise<MoveAgentTabResult> {
  const clientResult = requireClient(input.session, input.messages);
  if (!clientResult.ok) return clientResult.result;
  const running = refuseIfRunning(input.session, input.agentId, input.messages);
  if (running) return running;

  const sourceWorkspace = input.session.workspaces.get(input.sourceWorkspaceId);
  const sourceDirectory = sourceWorkspace?.workspaceDirectory;
  if (!sourceDirectory) {
    return {
      ok: false,
      reason: "no-source-directory",
      message: input.messages.workspacePathUnavailable,
    };
  }

  let createdWorkspace: { id: string; name?: string | null };
  try {
    const createResult = await clientResult.client.createWorkspace({
      source: {
        kind: "directory",
        path: sourceDirectory,
        ...(sourceWorkspace.projectId ? { projectId: sourceWorkspace.projectId } : {}),
      },
      title: sourceWorkspace.name ? `${sourceWorkspace.name} (2)` : undefined,
    });
    if (createResult.error || !createResult.workspace) {
      return {
        ok: false,
        reason: "create-failed",
        message: createResult.error ?? input.messages.createFailed,
      };
    }
    createdWorkspace = createResult.workspace;
  } catch (error) {
    return {
      ok: false,
      reason: "create-failed",
      message: errorMessage(error, input.messages.createFailed),
    };
  }

  return applyMove({
    client: clientResult.client,
    serverId: input.serverId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    targetWorkspaceId: createdWorkspace.id,
    agentId: input.agentId,
    tabId: input.tabId,
    layout: input.layout,
    navigation: input.navigation,
    messages: input.messages,
    created: true,
    openTargetTab: false,
  });
}

export function sessionFromStore(
  session: SessionStoreSnapshot | null | undefined,
): MoveAgentTabSession {
  const client = session?.client ?? null;
  const adapted =
    client &&
    typeof client.moveAgentToWorkspace === "function" &&
    typeof client.createWorkspace === "function"
      ? {
          moveAgentToWorkspace: client.moveAgentToWorkspace.bind(client),
          createWorkspace: client.createWorkspace.bind(client),
        }
      : null;
  return {
    client: adapted,
    agents: session?.agents ?? new Map(),
    agentDetails: session?.agentDetails,
    workspaces: session?.workspaces ?? new Map(),
  };
}

export function describeMoveAgentTabResult(
  result: MoveAgentTabResult,
  success: { existing: string; created: string },
): { kind: "error"; message: string } | { kind: "success"; message: string } {
  if (!result.ok) {
    return { kind: "error", message: result.message };
  }
  return {
    kind: "success",
    message: result.created ? success.created : success.existing,
  };
}

export function buildMoveAgentTabMessages(t: (key: string) => string): MoveAgentTabMessages {
  return {
    daemonClientUnavailable: t("common.errors.daemonClientUnavailable"),
    agentRunningCannotMove: t("workspace.tabs.toasts.agentRunningCannotMove"),
    workspacePathUnavailable: t("workspace.tabs.toasts.workspacePathUnavailable"),
    createFailed: t("workspace.tabs.toasts.failedToCreateWorkspace"),
    moveFailed: t("workspace.tabs.toasts.failedToMoveAgent"),
  };
}
