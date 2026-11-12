import { useCallback } from "react";
import { usePathname } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { useMissionControlActive } from "@/screens/mission-control/focus-context";

/**
 * Keyboard action IDs routed to grid draft creation.
 * Listens to "workspace.new" (Cmd+N on Mac, Ctrl+N on Linux/Windows)
 * and "workspace.agent.new" (palette / action dispatcher).
 */
const GRID_NEW_AGENT_ACTIONS: readonly KeyboardActionId[] = [
  "workspace.new",
  "workspace.agent.new",
];

export const GRID_NEW_AGENT_HANDLER_ID = "grid-new-agent";

/**
 * Higher priority than global workspace.new (priority 0) so the grid
 * consumes the shortcut when Mission Control grid view is active.
 */
export const GRID_NEW_AGENT_KEYBOARD_PRIORITY = 100;

export interface UseGridNewAgentActionOptions {
  /**
   * Explicit override for whether the grid view is open.
   * If omitted, checks whether view is "grid" in useAgentGridStore.
   */
  isGridView?: boolean;
  /**
   * Explicit override for whether Mission Control is active.
   * If omitted, derives from MissionControlActiveContext and route pathname.
   */
  isFocused?: boolean;
  /**
   * Explicit override to enable or disable the handler.
   */
  enabled?: boolean;
  /**
   * Priority in the keyboard action dispatcher (default: 100, above global workspace.new at 0).
   */
  priority?: number;
  /**
   * Optional custom handler to run when creating a draft.
   */
  onNewAgent?: () => void;
}

/**
 * Intercepts Cmd+N (Mac) / Ctrl+N (non-Mac) when Mission Control is active and
 * grid view is open. Opens a draft tile in the grid instead of navigating to
 * the new workspace screen.
 *
 * If a draft tile is already open, prevents duplicate draft creation and
 * still consumes the event to prevent workspace navigation.
 *
 * Outside grid view or when Mission Control is inactive, leaves the event
 * unhandled so global workspace-new navigation runs as usual.
 */
export function useGridNewAgentAction(options?: UseGridNewAgentActionOptions): void {
  const contextActive = useMissionControlActive();
  const pathname = usePathname();
  const gridView = useAgentGridStore((state) => state.view);

  const isMissionControlRoute =
    typeof pathname === "string" && pathname.includes("/mission-control");

  // Derive focus: explicit prop > context active + route match (or fallback in tests without pathname)
  const resolvedIsFocused =
    options?.isFocused ?? (contextActive && (isMissionControlRoute || !pathname));

  // Derive grid view: explicit prop > zustand store view
  const resolvedIsGridView = options?.isGridView ?? gridView === "grid";

  // Master enabled gate
  const isEnabled = options?.enabled ?? (resolvedIsFocused && resolvedIsGridView);

  const handle = useCallback(() => {
    const store = useAgentGridStore.getState();

    // No duplicate draft if one is already open: consume event without overwriting
    if (store.draft !== null) {
      return true;
    }

    if (options?.onNewAgent) {
      options.onNewAgent();
      return true;
    }

    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    store.setDraft({
      id,
      serverId: null,
      workspaceId: null,
      projectKey: null,
    });
    return true;
  }, [options]);

  const isActive = useCallback(() => {
    if (options?.enabled !== undefined) {
      return options.enabled;
    }
    const focused = options?.isFocused ?? (contextActive && (isMissionControlRoute || !pathname));
    if (!focused) {
      return false;
    }
    const gridOpen = options?.isGridView ?? useAgentGridStore.getState().view === "grid";
    return gridOpen;
  }, [contextActive, isMissionControlRoute, options, pathname]);

  useKeyboardActionHandler({
    handlerId: GRID_NEW_AGENT_HANDLER_ID,
    actions: GRID_NEW_AGENT_ACTIONS,
    enabled: isEnabled,
    priority: options?.priority ?? GRID_NEW_AGENT_KEYBOARD_PRIORITY,
    isActive,
    handle,
  });
}
