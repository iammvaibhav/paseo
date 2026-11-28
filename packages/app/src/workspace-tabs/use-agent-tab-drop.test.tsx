/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { View } from "react-native";
import { useAgentTabDropStore, type AgentTabDrop } from "./agent-tab-drop-target";
import { useAgentTabDropRow, useAgentTabDropTracking } from "./use-agent-tab-drop";

const DRAG = {
  serverId: "server-1",
  sourceWorkspaceId: "wks-source",
  agentId: "agent-1",
  tabId: "tab-1",
};

function fakeNode(rect: { left: number; top: number; right: number; bottom: number }): View {
  return {
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }),
  } as unknown as View;
}

function movePointer(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}

afterEach(() => {
  cleanup();
  useAgentTabDropStore.setState({ drag: null, hovered: null });
});

describe("agent tab drop wiring", () => {
  it("resolves a drop from a real window pointermove over a registered row", () => {
    const row = renderHook(() =>
      useAgentTabDropRow({
        serverId: "server-1",
        workspaceId: "wks-target",
        workspaceKey: "server-1:wks-target",
      }),
    );
    act(() => {
      row.result.current.dropRowRef(fakeNode({ left: 0, top: 100, right: 200, bottom: 140 }));
    });

    const tracking = renderHook(() => useAgentTabDropTracking());
    act(() => tracking.result.current.begin(DRAG));
    act(() => movePointer(100, 120));

    expect(useAgentTabDropStore.getState().hovered?.workspaceKey).toBe("server-1:wks-target");
    row.rerender();
    expect(row.result.current.isDropTarget).toBe(true);

    let drop: AgentTabDrop | null = null;
    act(() => {
      drop = tracking.result.current.end();
    });
    expect(drop).toEqual({
      drag: DRAG,
      target: {
        serverId: "server-1",
        workspaceId: "wks-target",
        workspaceKey: "server-1:wks-target",
      },
    });
  });

  it("stops following the pointer once the drag ends", () => {
    const row = renderHook(() =>
      useAgentTabDropRow({
        serverId: "server-1",
        workspaceId: "wks-target",
        workspaceKey: "server-1:wks-target",
      }),
    );
    act(() => {
      row.result.current.dropRowRef(fakeNode({ left: 0, top: 100, right: 200, bottom: 140 }));
    });

    const tracking = renderHook(() => useAgentTabDropTracking());
    act(() => tracking.result.current.begin(DRAG));
    act(() => movePointer(100, 120));
    act(() => {
      tracking.result.current.end();
    });

    act(() => movePointer(100, 120));
    expect(useAgentTabDropStore.getState().hovered).toBeNull();
  });
});
