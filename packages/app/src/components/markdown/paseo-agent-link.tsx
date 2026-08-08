import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { parseHistoryAskAgentOpenUrl } from "@/history-ask/open-agent-link-parse";
import { useSessionStore } from "@/stores/session-store";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";

/**
 * `paseo://` agent links in Commander prose render as inline agent chips
 * (spec "Native chips": same pressable component family as feed cards, opened
 * in the Inspector — never navigation). The link rule in markdown/renderer.tsx
 * only renders chips where this provider is mounted (the Mission Control
 * thread); everywhere else the deep links keep their existing behavior.
 *
 * The chip is a styled nested Text (onPress + chip tokens), because markdown
 * inline rules render inside Text parents on native — a View would break
 * Text nesting.
 */

export interface PaseoAgentLinkContextValue {
  /** Open an agent deep link (paseo://h/{serverId}/agent/{agentId}). */
  openAgent: (href: string) => boolean;
  /** hideAgentNames central config: chips fall back to titles. */
  hideAgentNames: boolean;
}

const PaseoAgentLinkContext = createContext<PaseoAgentLinkContextValue | null>(null);

export function usePaseoAgentLinkContext(): PaseoAgentLinkContextValue | null {
  return useContext(PaseoAgentLinkContext);
}

export function PaseoAgentLinkProvider({
  openAgent,
  children,
}: {
  openAgent: (href: string) => boolean;
  children: ReactNode;
}): ReactElement {
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;
  const value = useMemo(() => ({ openAgent, hideAgentNames }), [openAgent, hideAgentNames]);
  return <PaseoAgentLinkContext.Provider value={value}>{children}</PaseoAgentLinkContext.Provider>;
}

export function isPaseoAgentLink(href: string): boolean {
  return parseHistoryAskAgentOpenUrl(href) !== null;
}

/** Inline agent chip for a `paseo://` deep link in prose. */
export function PaseoAgentLinkChip({
  href,
  fallbackText,
}: {
  href: string;
  fallbackText?: string;
}): ReactElement | null {
  const context = usePaseoAgentLinkContext();
  const target = useMemo(() => parseHistoryAskAgentOpenUrl(href), [href]);
  const liveAgent = useSessionStore((state) =>
    target ? resolveSessionAgent(state.sessions[target.serverId], target.agentId) : null,
  );

  const handlePress = useCallback(() => {
    if (context) {
      context.openAgent(href);
    }
  }, [context, href]);

  if (!target) {
    return null;
  }
  const label = context?.hideAgentNames
    ? (liveAgent?.title ?? liveAgent?.name ?? fallbackText ?? "Open agent")
    : (liveAgent?.name ?? liveAgent?.title ?? fallbackText ?? "Open agent");

  return (
    <Text
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${label}`}
      style={styles.chip}
      testID="mission-control-paseo-agent-chip"
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    overflow: "hidden",
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
