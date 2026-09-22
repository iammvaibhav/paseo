import { createElement, memo, useEffect, useRef, type ReactElement } from "react";
import {
  Animated,
  type ScrollView,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentGridItem } from "./items";
import type { AgentGridLayout } from "./layout";
import { useAgentGridStore } from "./store";

export const GLOW_DURATION_MS = 2500;

let glowClearTimer: number | NodeJS.Timeout | null = null;

/**
 * Triggers the glow state for a specific tile key `${serverId}:${agentId}`.
 * The glow automatically clears after durationMs (default 1000ms).
 */
export function triggerAgentGridGlow(key: string | null, durationMs = GLOW_DURATION_MS): void {
  if (glowClearTimer !== null) {
    clearTimeout(glowClearTimer);
    glowClearTimer = null;
  }

  const store = useAgentGridStore.getState();
  if (typeof store.setGlow === "function") {
    store.setGlow(key);
  }

  if (!key) {
    return;
  }

  glowClearTimer = setTimeout(() => {
    const current = useAgentGridStore.getState();
    if (current.glowKey === key && typeof current.setGlow === "function") {
      current.setGlow(null);
    }
    glowClearTimer = null;
  }, durationMs);
}

/**
 * Explicitly clears the active glow state.
 */
export function clearAgentGridGlow(): void {
  if (glowClearTimer !== null) {
    clearTimeout(glowClearTimer);
    glowClearTimer = null;
  }
  const store = useAgentGridStore.getState();
  if (typeof store.setGlow === "function") {
    store.setGlow(null);
  }
}

type ScrollToKeyHandler = (key: string) => void;
const scrollHandlers = new Set<ScrollToKeyHandler>();
let pendingScrollTargetKey: string | null = null;

/**
 * Register a scroll handler from the mounted AgentGrid ScrollView.
 */
export function registerAgentGridScrollHandler(handler: ScrollToKeyHandler): () => void {
  scrollHandlers.add(handler);

  // If a scroll request was queued before the grid registered its handler, execute it now.
  if (pendingScrollTargetKey !== null) {
    const targetKey = pendingScrollTargetKey;
    pendingScrollTargetKey = null;
    try {
      handler(targetKey);
    } catch {
      // Ignore initial layout races
    }
  }

  return () => {
    scrollHandlers.delete(handler);
  };
}

/**
 * Request grid to scroll to a specific tile key `${serverId}:${agentId}`.
 */
export function requestAgentGridScroll(key: string): void {
  if (scrollHandlers.size === 0) {
    pendingScrollTargetKey = key;
    return;
  }
  pendingScrollTargetKey = null;
  for (const handler of scrollHandlers) {
    try {
      handler(key);
    } catch {
      // Fail open on individual handler error
    }
  }
}

/**
 * Focuses an agent in the Mission Control Agent Grid:
 * 1. Sets active key in store
 * 2. Triggers 1s inner border glow (auto-cleared)
 * 3. Requests grid to scroll the tile into view
 */
export function focusAgentInGrid(serverId: string, agentId: string): void {
  const key = `${serverId}:${agentId}`;
  const store = useAgentGridStore.getState();

  if (typeof store.setActiveKey === "function") {
    store.setActiveKey(key);
  }

  triggerAgentGridGlow(key, GLOW_DURATION_MS);
  requestAgentGridScroll(key);
}

export interface ScrollAgentGridOptions {
  scrollView: ScrollView | null;
  layout: AgentGridLayout;
  items: AgentGridItem[];
  targetKey: string;
  viewportWidth?: number;
  viewportHeight?: number;
  animated?: boolean;
  draftOffset?: number;
}

/**
 * Utility to scroll a tile into view within the AgentGrid ScrollView.
 * Clamps coordinates to content boundaries.
 */
export function scrollAgentGridIntoView(options: ScrollAgentGridOptions): boolean {
  const {
    scrollView,
    layout,
    items,
    targetKey,
    viewportWidth = 0,
    viewportHeight = 0,
    animated = true,
    draftOffset = 0,
  } = options;
  if (!scrollView || items.length === 0) {
    return false;
  }

  const itemIndex = items.findIndex((item) => item.key === targetKey);
  if (itemIndex === -1) {
    return false;
  }

  const { x, y } = layout.placeTile(itemIndex + draftOffset);

  if (layout.direction === "horizontal") {
    const maxOffset = Math.max(0, layout.contentWidth - viewportWidth);
    const targetX = Math.max(0, Math.min(x, maxOffset));
    scrollView.scrollTo({ x: targetX, y: 0, animated });
  } else {
    const maxOffset = Math.max(0, layout.contentHeight - viewportHeight);
    const targetY = Math.max(0, Math.min(y, maxOffset));
    scrollView.scrollTo({ x: 0, y: targetY, animated });
  }

  return true;
}

export interface AgentGridTileGlowProps extends ViewProps {
  glow?: boolean;
  agentId?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Subtle 1s inner border glow component for an AgentGridTile.
 * Uses an absolutely positioned overlay with pointerEvents="none" so there is
 * ZERO layout shift.
 */
export const AgentGridTileGlow = memo(function AgentGridTileGlow({
  glow = true,
  agentId,
  style,
  testID,
  ...rest
}: AgentGridTileGlowProps): ReactElement | null {
  const opacityAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!glow) {
      opacityAnim.setValue(0);
      return;
    }

    opacityAnim.setValue(1);
    const animation = Animated.timing(opacityAnim, {
      toValue: 0.2,
      duration: GLOW_DURATION_MS,
      useNativeDriver: true,
    });
    animation.start();

    return () => {
      animation.stop();
    };
  }, [glow, opacityAnim]);

  if (!glow) {
    return null;
  }

  const resolvedTestId =
    testID ??
    (agentId ? `mission-control-agent-grid-glow-${agentId}` : "mission-control-agent-grid-glow");

  return createElement(Animated.View, {
    pointerEvents: "none",
    "aria-hidden": true,
    accessibilityElementsHidden: true,
    importantForAccessibility: "no-hide-descendants",
    testID: resolvedTestId,
    dataSet: { glow: "true" },
    style: [styles.glowOverlay, { opacity: opacityAnim }, style],
    ...({
      "data-glow": "true",
      "data-testid": resolvedTestId,
    } as object),
    ...rest,
  });
});

export const styles = StyleSheet.create((theme) => ({
  glowOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    borderRadius: theme.borderRadius.lg,
    zIndex: 10,
    pointerEvents: "none",
  },
}));

export const agentGridGlowStyles = styles;
