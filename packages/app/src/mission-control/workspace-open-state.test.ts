import { describe, expect, it } from "vitest";
import { selectWorkspaceOpenState } from "./workspace-open-state";
import type { SessionsSnapshot } from "@/stores/session-store-hooks/selectors";
import type { WorkspaceDescriptor } from "@/stores/session-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "wks_1";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "running",
    archivingAt: input.archivingAt ?? null,
    statusEnteredAt: null,
    activityAt: null,
    createdAt: null,
    diffStat: null,
    scripts: [],
  };
}

function snapshot(input: {
  workspace?: WorkspaceDescriptor | null;
  hasHydratedWorkspaces?: boolean;
}): SessionsSnapshot {
  return {
    sessions: {
      [SERVER_ID]: {
        hasHydratedWorkspaces: input.hasHydratedWorkspaces,
        workspaces: input.workspace ? new Map([[input.workspace.id, input.workspace]]) : new Map(),
      },
    },
  };
}

describe("selectWorkspaceOpenState", () => {
  it("reports a workspace being archived as archived, not unavailable", () => {
    const state = snapshot({
      workspace: createWorkspace({ id: WORKSPACE_ID, archivingAt: "2026-08-01T00:00:00.000Z" }),
      hasHydratedWorkspaces: true,
    });
    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: true,
      isUnavailable: false,
      isArchivedOrMissing: true,
    });
  });

  it("reports an absent-but-hydrated workspace as unavailable, NOT archived", () => {
    const state = snapshot({ hasHydratedWorkspaces: true });
    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: true,
      isArchivedOrMissing: true,
    });
  });

  it("reports a present live workspace as neither archived nor unavailable", () => {
    const state = snapshot({
      workspace: createWorkspace({ id: WORKSPACE_ID, status: "running" }),
      hasHydratedWorkspaces: true,
    });
    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });

  it("reports a still-hydrating absent workspace as neither (cold-open path)", () => {
    const state = snapshot({ hasHydratedWorkspaces: false });
    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });

  it("reports neither when the workspace record predates the hydration flag", () => {
    const state = snapshot({});
    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });

  it("reports neither when there is no serverId or workspaceId", () => {
    const state = snapshot({ hasHydratedWorkspaces: true });
    expect(selectWorkspaceOpenState(state, null, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
    expect(selectWorkspaceOpenState(state, SERVER_ID, null)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });
});

describe("selectWorkspaceOpenState idle vs archived", () => {
  it("does not call an idle workspace archived", () => {
    // The daemon stamps `archivingAt: null, status: "done"` on a quiet
    // workspace; "done" means no active work. Treating it as archived put an
    // Archived banner on every live agent in an idle workspace.
    const state = snapshot({
      workspace: createWorkspace({ id: WORKSPACE_ID, status: "done", archivingAt: null }),
      hasHydratedWorkspaces: true,
    });

    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });
});
