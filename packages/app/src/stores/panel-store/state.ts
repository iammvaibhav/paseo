import {
  buildExplorerCheckoutKey,
  isExplorerTab,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";
import { sanitizeSelectedSubmoduleByCheckout } from "../explorer-submodule-memory";
import { z } from "zod";

export type MobilePanelView = "agent" | "agent-list" | "file-explorer";

export interface MobilePanelSelection {
  target: MobilePanelView;
  revision: number;
}

export interface DesktopSidebarState {
  agentListOpen: boolean;
  fileExplorerOpen: boolean;
  focusModeEnabled: boolean;
}

export type SortOption = "name" | "modified" | "size";

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

export const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 400;
export const MIN_EXPLORER_SIDEBAR_WIDTH = 280;
// Upper bound is intentionally generous; desktop resizing enforces a min-chat-width constraint.
export const MAX_EXPLORER_SIDEBAR_WIDTH = 2000;

export const DEFAULT_TREE_RAIL_WIDTH = 320;
export const MIN_TREE_RAIL_WIDTH = 200;
export const MAX_TREE_RAIL_WIDTH = 600;

// Mission Control board rail (drag-resizable, persisted). Default matches the
// rail's historic hardcoded width; bounds keep the thread column readable.
export const DEFAULT_BOARD_RAIL_WIDTH = 300;
export const MIN_BOARD_RAIL_WIDTH = 240;
export const MAX_BOARD_RAIL_WIDTH = 480;

// Mission Control inspector (drag-resizable, persisted). Default matches the
// inspector's historic hardcoded width; bounds keep the thread column and the
// board rail readable.
export const DEFAULT_INSPECTOR_WIDTH = 400;
export const MIN_INSPECTOR_WIDTH = 280;
// No hard ceiling: inspector fills free space when the board is collapsed.
// Soft default only; clamp uses a large upper bound so drag is unbounded in practice.
export const MAX_INSPECTOR_WIDTH = 10_000;

export interface PanelVisibilityState {
  isAgentListOpen: boolean;
  isFileExplorerOpen: boolean;
}

export interface PanelLayoutInput {
  isCompact: boolean;
}

export interface ExplorerPanelIntent extends PanelLayoutInput {
  checkout: ExplorerCheckoutContext;
}

export interface PanelCoreState {
  mobilePanel: MobilePanelSelection;
  desktop: DesktopSidebarState;
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function clampSidebarWidth(width: number): number {
  return clampNumber(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function clampExplorerWidth(width: number): number {
  return clampNumber(width, MIN_EXPLORER_SIDEBAR_WIDTH, MAX_EXPLORER_SIDEBAR_WIDTH);
}

export function clampBoardRailWidth(width: number): number {
  return clampNumber(width, MIN_BOARD_RAIL_WIDTH, MAX_BOARD_RAIL_WIDTH);
}

export function clampInspectorWidth(width: number): number {
  return clampNumber(width, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH);
}

export function clampTreeRailWidth(width: number): number {
  return clampNumber(width, MIN_TREE_RAIL_WIDTH, MAX_TREE_RAIL_WIDTH);
}

export function selectPanelVisibility(
  state: PanelCoreState,
  input: PanelLayoutInput,
): PanelVisibilityState {
  if (input.isCompact) {
    return {
      isAgentListOpen: state.mobilePanel.target === "agent-list",
      isFileExplorerOpen: state.mobilePanel.target === "file-explorer",
    };
  }
  return {
    isAgentListOpen: state.desktop.agentListOpen,
    isFileExplorerOpen: state.desktop.fileExplorerOpen,
  };
}

export function selectIsAgentListOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isAgentListOpen;
}

export function selectIsFileExplorerOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isFileExplorerOpen;
}

export function setMobilePanelTarget(
  selection: MobilePanelSelection,
  target: MobilePanelView,
): MobilePanelSelection {
  if (selection.target === target) {
    return selection;
  }
  return { target, revision: selection.revision + 1 };
}

function resolveExplorerTabFromCheckout(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): ExplorerTab {
  return resolveExplorerTabForCheckout({
    serverId: checkout.serverId,
    cwd: checkout.cwd,
    isGit: checkout.isGit,
    explorerTabByCheckout: state.explorerTabByCheckout,
  });
}

export interface OpenFileExplorerPatch {
  mobilePanel?: MobilePanelSelection;
  desktop?: DesktopSidebarState;
  explorerTab: ExplorerTab;
}

export function buildOpenFileExplorerPatch(
  state: PanelCoreState,
  input: ExplorerPanelIntent,
): OpenFileExplorerPatch {
  const resolvedTab = resolveExplorerTabFromCheckout(state, input.checkout);
  if (input.isCompact) {
    return {
      mobilePanel: setMobilePanelTarget(state.mobilePanel, "file-explorer"),
      explorerTab: resolvedTab,
    };
  }
  return {
    desktop: { ...state.desktop, fileExplorerOpen: true },
    explorerTab: resolvedTab,
  };
}

export type ToggleFileExplorerPatch =
  | OpenFileExplorerPatch
  | { mobilePanel: MobilePanelSelection }
  | { desktop: DesktopSidebarState };

export function buildToggleFileExplorerPatch(
  state: PanelCoreState,
  input: ExplorerPanelIntent,
): ToggleFileExplorerPatch {
  const isOpen = selectIsFileExplorerOpen(state, input);
  if (!isOpen) {
    return buildOpenFileExplorerPatch(state, input);
  }
  if (input.isCompact) {
    return { mobilePanel: setMobilePanelTarget(state.mobilePanel, "agent") };
  }
  return { desktop: { ...state.desktop, fileExplorerOpen: false } };
}

const ExplorerTabSchema = z.enum(["changes", "files", "pr"]);
const DesktopSidebarStorageSchema = z.strictObject({
  agentListOpen: z.boolean().optional(),
  fileExplorerOpen: z.boolean().optional(),
  focusModeEnabled: z.boolean().optional(),
  zoomed: z.boolean().optional(),
  focused: z.boolean().optional(),
});

export const PanelPersistedStateSchema = z.strictObject({
  mobileView: z.enum(["agent", "agent-list", "file-explorer"]).optional(),
  mobilePanel: z
    .strictObject({
      target: z.enum(["agent", "agent-list", "file-explorer"]),
      revision: z.number().int().nonnegative(),
    })
    .optional(),
  desktop: DesktopSidebarStorageSchema.optional(),
  explorerTab: ExplorerTabSchema.optional(),
  explorerTabByCheckout: z.record(z.string(), ExplorerTabSchema).optional(),
  selectedSubmoduleByCheckout: z.record(z.string(), z.unknown()).optional(),
  expandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  // Accepted only so migration can discard the former per-file diff expansion state.
  diffExpandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  diffCollapsedFoldersByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  collapsedFilePathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  sidebarWidth: z.number().optional(),
  explorerWidth: z.number().optional(),
  explorerSortOption: z.enum(["name", "modified", "size"]).optional(),
  explorerShowHiddenFiles: z.boolean().optional(),
  explorerFilesSplitRatio: z.number().optional(),
  treeRailWidth: z.number().optional(),
  boardRailWidth: z.number().optional(),
  inspectorWidth: z.number().optional(),
  boardRailCollapsed: z.boolean().optional(),
});

type MigratablePanelState = Omit<
  z.infer<typeof PanelPersistedStateSchema>,
  "selectedSubmoduleByCheckout"
> & {
  selectedSubmoduleByCheckout?: Record<string, string>;
  boardRailWidth?: number;
  inspectorWidth?: number;
  boardRailCollapsed?: boolean;
};

function migratePanelV2Explorer(state: MigratablePanelState, isWeb: boolean): void {
  if (isWeb && typeof state.explorerWidth === "number" && state.explorerWidth === 400) {
    state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }
}

function migratePanelV3Explorer(state: MigratablePanelState, isWeb: boolean): void {
  if (
    isWeb &&
    typeof state.explorerWidth === "number" &&
    (state.explorerWidth === 400 || state.explorerWidth === 520)
  ) {
    state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }
}

function migratePanelExplorerTabByCheckout(state: MigratablePanelState, version: number): void {
  if (
    version < 4 ||
    typeof state.explorerTabByCheckout !== "object" ||
    !state.explorerTabByCheckout
  ) {
    state.explorerTabByCheckout = {};
    return;
  }
  const entries = Object.entries(state.explorerTabByCheckout);
  const next: Record<string, ExplorerTab> = {};
  for (const [key, value] of entries) {
    if (!isExplorerTab(value)) {
      continue;
    }
    next[key] = value;
  }
  state.explorerTabByCheckout = next;
}

function migratePanelDesktopFocusMode(state: MigratablePanelState): void {
  const desktop = state.desktop;
  if (!desktop) {
    return;
  }
  if ("zoomed" in desktop) {
    desktop.focusModeEnabled = desktop.zoomed;
    delete desktop.zoomed;
  }
  if ("focused" in desktop) {
    desktop.focusModeEnabled = desktop.focused;
    delete desktop.focused;
  }
  if (typeof desktop.focusModeEnabled !== "boolean") {
    desktop.focusModeEnabled = false;
  }
}

function migratePanelLayoutDimensions(state: MigratablePanelState, version: number): void {
  if (version < 6 || typeof state.sidebarWidth !== "number") {
    state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  }
  if (typeof state.boardRailWidth !== "number") {
    state.boardRailWidth = DEFAULT_BOARD_RAIL_WIDTH;
  }
  if (typeof state.inspectorWidth !== "number") {
    state.inspectorWidth = DEFAULT_INSPECTOR_WIDTH;
  }
  if (typeof state.boardRailCollapsed !== "boolean") {
    state.boardRailCollapsed = false;
  }
}

function migratePanelWorkspaceExpansionMaps(state: MigratablePanelState, version: number): void {
  if (
    version < 9 ||
    typeof state.expandedPathsByWorkspace !== "object" ||
    !state.expandedPathsByWorkspace
  ) {
    state.expandedPathsByWorkspace = {};
  }
  delete state.diffExpandedPathsByWorkspace;
  if (
    version < 12 ||
    typeof state.diffCollapsedFoldersByWorkspace !== "object" ||
    !state.diffCollapsedFoldersByWorkspace
  ) {
    state.diffCollapsedFoldersByWorkspace = {};
  }
  if (
    typeof state.collapsedFilePathsByWorkspace !== "object" ||
    !state.collapsedFilePathsByWorkspace
  ) {
    state.collapsedFilePathsByWorkspace = {};
  }
}

function migrateTreeRailWidth(state: MigratablePanelState, version: number): void {
  if (version < 13 || typeof state.treeRailWidth !== "number") {
    delete state.explorerFilesSplitRatio;
    state.treeRailWidth = DEFAULT_TREE_RAIL_WIDTH;
    return;
  }
  state.treeRailWidth = clampTreeRailWidth(state.treeRailWidth);
}

export function migratePanelState(
  persistedState: unknown,
  version: number,
  options: { isWeb: boolean },
): MigratablePanelState {
  const result = PanelPersistedStateSchema.safeParse(persistedState);
  const rawState = (result.success ? result.data : {}) as z.infer<typeof PanelPersistedStateSchema>;
  const state: MigratablePanelState = {
    ...rawState,
    selectedSubmoduleByCheckout: sanitizeSelectedSubmoduleByCheckout(
      rawState.selectedSubmoduleByCheckout,
    ),
  };
  const { isWeb } = options;

  if (version < 2) {
    migratePanelV2Explorer(state, isWeb);
  }
  if (version < 3) {
    migratePanelV3Explorer(state, isWeb);
  }
  if (!isExplorerTab(state.explorerTab)) {
    state.explorerTab = "changes";
  }
  migratePanelExplorerTabByCheckout(state, version);
  if (version < 8) {
    migratePanelDesktopFocusMode(state);
  }
  migratePanelLayoutDimensions(state, version);
  migratePanelWorkspaceExpansionMaps(state, version);
  state.selectedSubmoduleByCheckout = sanitizeSelectedSubmoduleByCheckout(
    state.selectedSubmoduleByCheckout,
  );

  if (typeof state.explorerShowHiddenFiles !== "boolean") {
    state.explorerShowHiddenFiles = true;
  }
  migrateTreeRailWidth(state, version);
  if (version < 12) {
    // Compact panel position is transient UI state. Cold starts always begin
    // at content, regardless of what an older version persisted.
    delete state.mobileView;
    delete state.mobilePanel;
  }

  return state;
}

export { buildExplorerCheckoutKey, resolveExplorerTabForCheckout };
export type { ExplorerTab, ExplorerCheckoutContext };
