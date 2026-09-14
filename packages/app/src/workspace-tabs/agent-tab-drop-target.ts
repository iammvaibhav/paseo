import { create } from "zustand";

/**
 * Agent tabs are dragged by dnd-kit, not by HTML5 drag and drop: dnd-kit's
 * pointer sensor registers a window-level `dragstart` -> preventDefault as soon
 * as the pointer goes down on a chip (@dnd-kit/core AbstractPointerSensor.attach),
 * so a native `draggable` tab never emits `dragstart`.
 *
 * The sidebar lives outside the workspace `DndContext`, so it cannot be a
 * dnd-kit droppable either. Sidebar rows instead register their measured rect
 * here, and the workspace drag lifecycle hit-tests the pointer against them.
 */
export interface AgentTabDragSource {
  serverId: string;
  sourceWorkspaceId: string;
  agentId: string;
  tabId: string;
}

export interface AgentTabDropTarget {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}

export interface AgentTabDropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface RegisteredDropTarget extends AgentTabDropTarget {
  measure: () => AgentTabDropRect | null;
}

const registeredDropTargets = new Map<string, RegisteredDropTarget>();

export function registerAgentTabDropTarget(target: RegisteredDropTarget): () => void {
  registeredDropTargets.set(target.workspaceKey, target);
  return () => {
    if (registeredDropTargets.get(target.workspaceKey) === target) {
      registeredDropTargets.delete(target.workspaceKey);
    }
  };
}

/**
 * The workspace whose row contains `point`, or null. A drop is only offered on
 * the dragged agent's own host and never onto the workspace it already lives in.
 */
export function resolveAgentTabDropTarget(input: {
  point: { x: number; y: number };
  drag: AgentTabDragSource;
  targets: Array<AgentTabDropTarget & { rect: AgentTabDropRect | null }>;
}): AgentTabDropTarget | null {
  for (const target of input.targets) {
    if (!target.rect) continue;
    if (target.serverId !== input.drag.serverId) continue;
    if (target.workspaceId === input.drag.sourceWorkspaceId) continue;
    const { left, top, right, bottom } = target.rect;
    if (
      input.point.x >= left &&
      input.point.x <= right &&
      input.point.y >= top &&
      input.point.y <= bottom
    ) {
      return {
        serverId: target.serverId,
        workspaceId: target.workspaceId,
        workspaceKey: target.workspaceKey,
      };
    }
  }
  return null;
}

function hitTestRegistry(
  point: { x: number; y: number },
  drag: AgentTabDragSource,
): AgentTabDropTarget | null {
  return resolveAgentTabDropTarget({
    point,
    drag,
    targets: Array.from(registeredDropTargets.values()).map((target) => ({
      serverId: target.serverId,
      workspaceId: target.workspaceId,
      workspaceKey: target.workspaceKey,
      rect: target.measure(),
    })),
  });
}

export interface AgentTabDrop {
  drag: AgentTabDragSource;
  target: AgentTabDropTarget;
}

interface AgentTabDropStore {
  drag: AgentTabDragSource | null;
  hovered: AgentTabDropTarget | null;
  beginDrag: (drag: AgentTabDragSource) => void;
  updatePointer: (point: { x: number; y: number }) => void;
  endDrag: () => AgentTabDrop | null;
}

export const useAgentTabDropStore = create<AgentTabDropStore>((set, get) => ({
  drag: null,
  hovered: null,
  beginDrag: (drag) => set({ drag, hovered: null }),
  updatePointer: (point) => {
    const { drag, hovered } = get();
    if (!drag) return;
    const next = hitTestRegistry(point, drag);
    if (next?.workspaceKey === hovered?.workspaceKey) return;
    set({ hovered: next });
  },
  endDrag: () => {
    const { drag, hovered } = get();
    set({ drag: null, hovered: null });
    return drag && hovered ? { drag, target: hovered } : null;
  },
}));
