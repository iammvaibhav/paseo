/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KeyboardActionDefinition,
  KeyboardActionHandler,
} from "@/keyboard/keyboard-action-dispatcher";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { MissionControlActiveContext } from "@/screens/mission-control/focus-context";
import {
  GRID_NEW_AGENT_HANDLER_ID,
  GRID_NEW_AGENT_KEYBOARD_PRIORITY,
  useGridNewAgentAction,
} from "./use-grid-new-agent-action";

interface Dispatcher {
  dispatch: (action: KeyboardActionDefinition) => boolean;
  registerHandler: (handler: KeyboardActionHandler) => () => void;
}

let mockPathname = "/mission-control";

vi.mock("expo-router", () => ({
  usePathname: () => mockPathname,
  router: {
    navigate: vi.fn(),
  },
}));

function createWrapper(isFocused = true) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <KeyboardActionDispatcherProvider>
        <MissionControlActiveContext.Provider value={isFocused}>
          {children}
        </MissionControlActiveContext.Provider>
      </KeyboardActionDispatcherProvider>
    );
  };
}

describe("useGridNewAgentAction", () => {
  beforeEach(() => {
    mockPathname = "/mission-control";
    const store = useAgentGridStore.getState();
    store.clearDraft();
    store.setView("grid");
  });

  it("opens draft tile on workspace.new when MC is active and grid view is open", () => {
    let dispatcher: Dispatcher | null = null;

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
      },
      { wrapper: createWrapper(true) },
    );

    expect(useAgentGridStore.getState().draft).toBeNull();

    let handled = false;
    act(() => {
      handled = dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    expect(handled).toBe(true);
    const draft = useAgentGridStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft?.id).toBeTruthy();
    expect(draft?.serverId).toBeNull();
    expect(draft?.workspaceId).toBeNull();
    expect(draft?.projectKey).toBeNull();
  });

  it("does not create duplicate draft if one is already open", () => {
    let dispatcher: Dispatcher | null = null;

    useAgentGridStore.getState().setDraft({
      id: "initial-draft-id",
      serverId: "srv-1",
      workspaceId: "ws-1",
      projectKey: "proj-1",
    });

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
      },
      { wrapper: createWrapper(true) },
    );

    let handled = false;
    act(() => {
      handled = dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    // Consumed the event to prevent workspace navigation
    expect(handled).toBe(true);
    // Draft was NOT overwritten
    const draft = useAgentGridStore.getState().draft;
    expect(draft?.id).toBe("initial-draft-id");
    expect(draft?.serverId).toBe("srv-1");
  });

  it("does not intercept workspace.new when grid view is not open (commander view)", () => {
    let dispatcher: Dispatcher | null = null;
    useAgentGridStore.getState().setView("commander");

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
      },
      { wrapper: createWrapper(true) },
    );

    let handled = false;
    act(() => {
      handled = dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    expect(handled).toBe(false);
    expect(useAgentGridStore.getState().draft).toBeNull();
  });

  it("does not intercept workspace.new when Mission Control is not active", () => {
    let dispatcher: Dispatcher | null = null;

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
      },
      { wrapper: createWrapper(false) },
    );

    let handled = false;
    act(() => {
      handled = dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    expect(handled).toBe(false);
    expect(useAgentGridStore.getState().draft).toBeNull();
  });

  it("falls through to lower-priority global handler when grid is not active", () => {
    let dispatcher: Dispatcher | null = null;
    useAgentGridStore.getState().setView("commander");
    const globalHandler = vi.fn(() => true);

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
        // Register mock global workspace-new handler with priority 0
        dispatcher.registerHandler({
          handlerId: "workspace-new-global",
          actions: ["workspace.new"],
          enabled: true,
          priority: 0,
          handle: globalHandler,
        });
      },
      { wrapper: createWrapper(true) },
    );

    act(() => {
      dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    // Global handler was called because grid view is not open
    expect(globalHandler).toHaveBeenCalledTimes(1);
    expect(useAgentGridStore.getState().draft).toBeNull();
  });

  it("supersedes lower-priority global handler when grid view is active", () => {
    let dispatcher: Dispatcher | null = null;
    useAgentGridStore.getState().setView("grid");
    const globalHandler = vi.fn(() => true);

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction();
        // Register mock global workspace-new handler with priority 0
        dispatcher.registerHandler({
          handlerId: "workspace-new-global",
          actions: ["workspace.new"],
          enabled: true,
          priority: 0,
          handle: globalHandler,
        });
      },
      { wrapper: createWrapper(true) },
    );

    act(() => {
      dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    // Global handler was NOT called because grid handler intercepted at priority 100
    expect(globalHandler).not.toHaveBeenCalled();
    expect(useAgentGridStore.getState().draft).not.toBeNull();
  });

  it("respects explicit isGridView and isFocused options", () => {
    let dispatcher: Dispatcher | null = null;

    renderHook(
      () => {
        dispatcher = useKeyboardActionDispatcher();
        useGridNewAgentAction({
          isGridView: true,
          isFocused: true,
        });
      },
      { wrapper: createWrapper(false) }, // Wrapper says false, but options say true
    );

    let handled = false;
    act(() => {
      handled = dispatcher!.dispatch({ id: "workspace.new", scope: "sidebar" });
    });

    expect(handled).toBe(true);
    expect(useAgentGridStore.getState().draft).not.toBeNull();
  });

  it("uses expected handler ID and priority constants", () => {
    expect(GRID_NEW_AGENT_HANDLER_ID).toBe("grid-new-agent");
    expect(GRID_NEW_AGENT_KEYBOARD_PRIORITY).toBe(100);
  });
});
