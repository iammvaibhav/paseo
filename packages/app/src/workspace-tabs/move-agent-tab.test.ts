import { describe, expect, it, vi } from "vitest";
import {
  buildMoveAgentTabMessages,
  describeMoveAgentTabResult,
  moveAgentTabToExistingWorkspace,
  moveAgentTabToNewWorkspace,
  sessionFromStore,
  type MoveAgentTabClient,
  type MoveAgentTabLayout,
  type MoveAgentTabMessages,
  type MoveAgentTabNavigation,
  type MoveAgentTabSession,
} from "./move-agent-tab";
const messages: MoveAgentTabMessages = {
  daemonClientUnavailable: "Daemon client unavailable",
  agentRunningCannotMove: "Stop the agent before moving to another workspace",
  workspacePathUnavailable: "Workspace path not available",
  createFailed: "Failed to create workspace",
  moveFailed: "Failed to move agent to workspace",
};

function createLayout(): MoveAgentTabLayout {
  return {
    closeTab: vi.fn(),
    openTab: vi.fn(),
  };
}

function createNavigation(): MoveAgentTabNavigation {
  return {
    navigateToWorkspace: vi.fn(),
  };
}

function createClient(overrides: Partial<MoveAgentTabClient> = {}): MoveAgentTabClient {
  return {
    moveAgentToWorkspace: vi.fn(async () => ({
      agentId: "agent-123",
      workspaceId: "wks-target",
    })),
    createWorkspace: vi.fn(async () => ({
      error: null,
      workspace: { id: "wks-created", name: "Source (2)" },
    })),
    ...overrides,
  };
}

function createSession(input: {
  client: MoveAgentTabClient | null;
  agentStatus?: string;
  workspaceDirectory?: string | null;
}): MoveAgentTabSession {
  return {
    client: input.client,
    agents: new Map([["agent-123", { status: input.agentStatus ?? "idle" }]]),
    workspaces: new Map([
      [
        "wks-source",
        {
          id: "wks-source",
          name: "Source",
          projectId: "prj-1",
          workspaceDirectory:
            input.workspaceDirectory === undefined ? "/repo/source" : input.workspaceDirectory,
        },
      ],
      [
        "wks-target",
        {
          id: "wks-target",
          name: "Target",
          projectId: "prj-1",
          workspaceDirectory: "/repo/target",
        },
      ],
    ]),
  };
}

describe("moveAgentTabToExistingWorkspace", () => {
  it("refuses when the daemon client is missing", async () => {
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToExistingWorkspace({
      session: createSession({ client: null }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      targetWorkspaceId: "wks-target",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: false,
      reason: "no-client",
      message: "Daemon client unavailable",
    });
    expect(layout.closeTab).not.toHaveBeenCalled();
    expect(navigation.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("refuses when the agent is running", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToExistingWorkspace({
      session: createSession({ client, agentStatus: "running" }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      targetWorkspaceId: "wks-target",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: false,
      reason: "agent-running",
      message: "Stop the agent before moving to another workspace",
    });
    expect(client.moveAgentToWorkspace).not.toHaveBeenCalled();
  });

  it("moves the agent, closes the source tab, opens the target tab, and navigates", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToExistingWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      targetWorkspaceId: "wks-target",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: true,
      targetWorkspaceId: "wks-target",
      created: false,
    });
    expect(client.moveAgentToWorkspace).toHaveBeenCalledWith("agent-123", "wks-target");
    expect(layout.closeTab).toHaveBeenCalledWith("server-1:wks-source", "tab-123");
    expect(layout.openTab).toHaveBeenCalledWith({
      workspaceKey: "server-1:wks-target",
      target: { kind: "agent", agentId: "agent-123" },
      intent: "reveal",
    });
    expect(navigation.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "server-1",
      workspaceId: "wks-target",
      target: { kind: "agent", agentId: "agent-123" },
    });
  });

  it("returns the RPC error when the move is rejected", async () => {
    const client = createClient({
      moveAgentToWorkspace: vi.fn().mockRejectedValue(new Error("Agent is archived")),
    });
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToExistingWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      targetWorkspaceId: "wks-target",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: false,
      reason: "move-failed",
      message: "Agent is archived",
    });
    expect(layout.closeTab).not.toHaveBeenCalled();
    expect(navigation.navigateToWorkspace).not.toHaveBeenCalled();
  });
});

describe("moveAgentTabToNewWorkspace", () => {
  it("creates a sibling workspace, moves the agent, and navigates without a second openTab", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToNewWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      agentId: "agent-123",
      tabId: "tab-123",
      createWorktreeSlug: () => "worktree-slug-456",
    });

    expect(result).toEqual({
      ok: true,
      targetWorkspaceId: "wks-created",
      created: true,
    });
    expect(client.createWorkspace).toHaveBeenCalledWith({
      source: {
        kind: "worktree",
        cwd: "/repo/source",
        projectId: "prj-1",
        worktreeSlug: "worktree-slug-456",
      },
      title: "Source (2)",
    });
    expect(client.moveAgentToWorkspace).toHaveBeenCalledWith("agent-123", "wks-created");
    expect(layout.closeTab).toHaveBeenCalledWith("server-1:wks-source", "tab-123");
    expect(layout.openTab).not.toHaveBeenCalled();
    expect(navigation.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "server-1",
      workspaceId: "wks-created",
      target: { kind: "agent", agentId: "agent-123" },
    });
  });

  it("refuses when the source workspace has no directory", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToNewWorkspace({
      session: createSession({ client, workspaceDirectory: null }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: false,
      reason: "no-source-directory",
      message: "Workspace path not available",
    });
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });

  it("returns the create error without moving the agent", async () => {
    const client = createClient({
      createWorkspace: vi.fn().mockResolvedValue({
        error: "Path is not a git checkout",
        workspace: null,
      }),
    });
    const layout = createLayout();
    const navigation = createNavigation();
    const result = await moveAgentTabToNewWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    expect(result).toEqual({
      ok: false,
      reason: "create-failed",
      message: "Path is not a git checkout",
    });
    expect(client.moveAgentToWorkspace).not.toHaveBeenCalled();
  });

  it("creates a worktree workspace with slug and without baseBranch, action, or refName", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    await moveAgentTabToNewWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      agentId: "agent-123",
      tabId: "tab-123",
      createWorktreeSlug: () => "worktree-slug-xyz",
    });

    expect(client.createWorkspace).toHaveBeenCalledTimes(1);
    const callInput = vi.mocked(client.createWorkspace).mock.calls[0]?.[0];
    expect(callInput?.source).toEqual({
      kind: "worktree",
      cwd: "/repo/source",
      projectId: "prj-1",
      worktreeSlug: "worktree-slug-xyz",
    });
    expect(callInput?.source).not.toHaveProperty("baseBranch");
    expect(callInput?.source).not.toHaveProperty("action");
    expect(callInput?.source).not.toHaveProperty("refName");
  });

  it("uses default slug generator when createWorktreeSlug is omitted", async () => {
    const client = createClient();
    const layout = createLayout();
    const navigation = createNavigation();
    await moveAgentTabToNewWorkspace({
      session: createSession({ client }),
      layout,
      navigation,
      messages,
      serverId: "server-1",
      sourceWorkspaceId: "wks-source",
      agentId: "agent-123",
      tabId: "tab-123",
    });

    const callInput = vi.mocked(client.createWorkspace).mock.calls[0]?.[0];
    expect(callInput?.source.kind).toBe("worktree");
    if (callInput?.source.kind === "worktree") {
      expect(typeof callInput.source.worktreeSlug).toBe("string");
      expect(callInput.source.worktreeSlug?.length).toBeGreaterThan(0);
    }
  });
});

describe("describeMoveAgentTabResult", () => {
  it("maps failures to error copy and successes to existing vs created copy", () => {
    expect(
      describeMoveAgentTabResult(
        { ok: false, reason: "agent-running", message: "stop first" },
        { existing: "Moved to Target", created: "Moved to new workspace" },
      ),
    ).toEqual({ kind: "error", message: "stop first" });
    expect(
      describeMoveAgentTabResult(
        { ok: true, targetWorkspaceId: "wks-target", created: false },
        { existing: "Moved to Target", created: "Moved to new workspace" },
      ),
    ).toEqual({ kind: "success", message: "Moved to Target" });
    expect(
      describeMoveAgentTabResult(
        { ok: true, targetWorkspaceId: "wks-created", created: true },
        { existing: "Moved to Target", created: "Moved to new workspace" },
      ),
    ).toEqual({ kind: "success", message: "Moved to new workspace" });
  });
});

describe("buildMoveAgentTabMessages", () => {
  it("reads the tab-move toast keys from the translator", () => {
    expect(buildMoveAgentTabMessages((key) => key)).toEqual({
      daemonClientUnavailable: "common.errors.daemonClientUnavailable",
      agentRunningCannotMove: "workspace.tabs.toasts.agentRunningCannotMove",
      workspacePathUnavailable: "workspace.tabs.toasts.workspacePathUnavailable",
      createFailed: "workspace.tabs.toasts.failedToCreateWorkspace",
      moveFailed: "workspace.tabs.toasts.failedToMoveAgent",
    });
  });
});

describe("sessionFromStore", () => {
  it("adapts a client that implements the move methods", () => {
    const client = createClient();
    const session = sessionFromStore({
      client,
      agents: new Map([["agent-123", { status: "idle" }]]),
      workspaces: new Map(),
    });
    expect(session.client).not.toBeNull();
    expect(session.client?.moveAgentToWorkspace).toBeTypeOf("function");
    expect(session.client?.createWorkspace).toBeTypeOf("function");
  });

  it("treats a client missing moveAgentToWorkspace as unavailable", () => {
    const session = sessionFromStore({
      client: { createWorkspace: vi.fn() } as unknown as MoveAgentTabClient,
      agents: new Map(),
      workspaces: new Map(),
    });
    expect(session.client).toBeNull();
  });

  it("returns an empty session when the store snapshot is missing", () => {
    const session = sessionFromStore(null);
    expect(session.client).toBeNull();
    expect(session.agents.size).toBe(0);
    expect(session.workspaces.size).toBe(0);
  });
});
