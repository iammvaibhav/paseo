import { useCallback, useEffect, useMemo, useRef } from "react";
import type { View } from "react-native";
import { isWeb } from "@/constants/platform";
import {
  registerAgentTabDropTarget,
  useAgentTabDropStore,
  type AgentTabDragSource,
  type AgentTabDrop,
} from "./agent-tab-drop-target";

/**
 * Registers a sidebar workspace row as an agent-tab drop target and reports
 * whether a dragged tab is currently over it. Web only: the workspace tab drag
 * is a dnd-kit pointer drag that exists on the desktop shell.
 */
export function useAgentTabDropRow(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  disabled?: boolean;
}): { dropRowRef: (node: View | null) => void; isDropTarget: boolean } {
  const nodeRef = useRef<HTMLElement | null>(null);
  const isDropTarget = useAgentTabDropStore(
    (state) => state.hovered?.workspaceKey === input.workspaceKey,
  );

  const dropRowRef = useCallback((node: View | null) => {
    nodeRef.current = node as unknown as HTMLElement | null;
  }, []);

  const { serverId, workspaceId, workspaceKey, disabled = false } = input;
  useEffect(() => {
    if (!isWeb || disabled) return;
    return registerAgentTabDropTarget({
      serverId,
      workspaceId,
      workspaceKey,
      measure: () => {
        const node = nodeRef.current;
        if (!node?.getBoundingClientRect) return null;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      },
    });
  }, [disabled, serverId, workspaceId, workspaceKey]);

  return { dropRowRef, isDropTarget };
}

export interface AgentTabDropTracking {
  begin: (drag: AgentTabDragSource) => void;
  end: () => AgentTabDrop | null;
}

/**
 * Follows the pointer for the duration of a workspace tab drag so sidebar rows
 * outside the workspace `DndContext` can still light up and accept the drop.
 */
export function useAgentTabDropTracking(): AgentTabDropTracking {
  const beginDrag = useAgentTabDropStore((state) => state.beginDrag);
  const updatePointer = useAgentTabDropStore((state) => state.updatePointer);
  const endDrag = useAgentTabDropStore((state) => state.endDrag);
  const detachRef = useRef<(() => void) | null>(null);

  const detach = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  return useMemo(
    () => ({
      begin: (drag) => {
        beginDrag(drag);
        if (!isWeb || typeof window === "undefined") return;
        detachRef.current?.();
        const handlePointerMove = (event: PointerEvent) => {
          updatePointer({ x: event.clientX, y: event.clientY });
        };
        window.addEventListener("pointermove", handlePointerMove);
        detachRef.current = () => {
          window.removeEventListener("pointermove", handlePointerMove);
        };
      },
      end: () => {
        detach();
        return endDrag();
      },
    }),
    [beginDrag, detach, endDrag, updatePointer],
  );
}
