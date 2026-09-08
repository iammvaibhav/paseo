import { beforeEach, describe, expect, it } from "vitest";
import {
  registerAgentTabDropTarget,
  resolveAgentTabDropTarget,
  useAgentTabDropStore,
  type AgentTabDragSource,
} from "./agent-tab-drop-target";

const drag: AgentTabDragSource = {
  serverId: "server-1",
  sourceWorkspaceId: "wks-source",
  agentId: "agent-123",
  tabId: "tab-123",
};

const targetRow = {
  serverId: "server-1",
  workspaceId: "wks-target",
  workspaceKey: "server-1:wks-target",
  rect: { left: 0, top: 100, right: 200, bottom: 140 },
};

describe("resolveAgentTabDropTarget", () => {
  it("matches the row under the pointer", () => {
    expect(
      resolveAgentTabDropTarget({ point: { x: 100, y: 120 }, drag, targets: [targetRow] }),
    ).toEqual({
      serverId: "server-1",
      workspaceId: "wks-target",
      workspaceKey: "server-1:wks-target",
    });
  });

  it("ignores points outside every row, including the row edges' exterior", () => {
    expect(
      resolveAgentTabDropTarget({ point: { x: 100, y: 141 }, drag, targets: [targetRow] }),
    ).toBeNull();
    expect(
      resolveAgentTabDropTarget({ point: { x: 201, y: 120 }, drag, targets: [targetRow] }),
    ).toBeNull();
  });

  it("never offers the workspace the agent already lives in", () => {
    expect(
      resolveAgentTabDropTarget({
        point: { x: 100, y: 120 },
        drag,
        targets: [{ ...targetRow, workspaceId: "wks-source" }],
      }),
    ).toBeNull();
  });

  it("never offers a workspace on another host", () => {
    expect(
      resolveAgentTabDropTarget({
        point: { x: 100, y: 120 },
        drag,
        targets: [{ ...targetRow, serverId: "server-2" }],
      }),
    ).toBeNull();
  });

  it("skips rows that cannot be measured", () => {
    expect(
      resolveAgentTabDropTarget({
        point: { x: 100, y: 120 },
        drag,
        targets: [{ ...targetRow, rect: null }],
      }),
    ).toBeNull();
  });
});

describe("useAgentTabDropStore", () => {
  beforeEach(() => {
    useAgentTabDropStore.setState({ drag: null, hovered: null });
  });

  it("tracks the hovered row across a drag and hands it back once on drop", () => {
    const unregister = registerAgentTabDropTarget({
      serverId: targetRow.serverId,
      workspaceId: targetRow.workspaceId,
      workspaceKey: targetRow.workspaceKey,
      measure: () => targetRow.rect,
    });

    const store = useAgentTabDropStore.getState();
    store.beginDrag(drag);
    store.updatePointer({ x: 100, y: 120 });
    expect(useAgentTabDropStore.getState().hovered?.workspaceKey).toBe("server-1:wks-target");

    store.updatePointer({ x: 100, y: 400 });
    expect(useAgentTabDropStore.getState().hovered).toBeNull();

    store.updatePointer({ x: 100, y: 120 });
    expect(useAgentTabDropStore.getState().endDrag()).toEqual({
      drag,
      target: {
        serverId: "server-1",
        workspaceId: "wks-target",
        workspaceKey: "server-1:wks-target",
      },
    });
    expect(useAgentTabDropStore.getState().drag).toBeNull();
    expect(useAgentTabDropStore.getState().hovered).toBeNull();

    unregister();
  });

  it("ignores pointer updates when no drag is active", () => {
    registerAgentTabDropTarget({
      serverId: targetRow.serverId,
      workspaceId: targetRow.workspaceId,
      workspaceKey: targetRow.workspaceKey,
      measure: () => targetRow.rect,
    })();

    useAgentTabDropStore.getState().updatePointer({ x: 100, y: 120 });
    expect(useAgentTabDropStore.getState().hovered).toBeNull();
  });

  it("stops offering a row once it unregisters", () => {
    const unregister = registerAgentTabDropTarget({
      serverId: targetRow.serverId,
      workspaceId: targetRow.workspaceId,
      workspaceKey: targetRow.workspaceKey,
      measure: () => targetRow.rect,
    });
    unregister();

    const store = useAgentTabDropStore.getState();
    store.beginDrag(drag);
    store.updatePointer({ x: 100, y: 120 });
    expect(useAgentTabDropStore.getState().hovered).toBeNull();
  });
});
