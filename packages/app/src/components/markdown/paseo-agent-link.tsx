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
import {
  normalizeHostGlyphOverride,
  resolveHostGlyphPresentation,
} from "@/components/host-glyph-model";
import { identityColor } from "@/styles/identity-colors";
import { useDaemonConfig } from "@/hooks/use-daemon-config";

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
  const daemonConfig = useDaemonConfig(target?.serverId ?? null);

  const handlePress = useCallback(() => {
    if (context) {
      context.openAgent(href);
    }
  }, [context, href]);

  const hideAgentNames = context?.hideAgentNames === true;
  const hostPresentation = useMemo(() => {
    if (!target) {
      return null;
    }
    const override = normalizeHostGlyphOverride(daemonConfig.config?.missionControl?.hostGlyph);
    return resolveHostGlyphPresentation({
      serverId: target.serverId,
      label: target.serverId,
      override,
    });
  }, [target, daemonConfig.config]);

  if (!target) {
    return null;
  }

  const title = liveAgent?.title ?? "";
  const name = liveAgent?.name ?? "";
  // Respect hideAgentNames: the chip shows the title only.
  const primary = hideAgentNames
    ? title || name || fallbackText || "Open agent"
    : name || title || fallbackText || "Open agent";
  const secondary = hideAgentNames ? null : title;

  return (
    <Text
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${primary}`}
      style={styles.chip}
      numberOfLines={1}
      testID="mission-control-paseo-agent-chip"
    >
      {hostPresentation ? (
        <Text
          style={[styles.hostGlyph, { backgroundColor: identityColor(hostPresentation.colorName) }]}
        >
          {hostPresentation.glyph}
        </Text>
      ) : null}
      {` ${primary}`}
      {secondary && secondary !== primary ? (
        <Text style={styles.chipTitle} numberOfLines={1}>
          {` · ${secondary}`}
        </Text>
      ) : null}
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
  chipTitle: {
    color: theme.colors.foregroundMuted,
  },
  hostGlyph: {
    borderRadius: 999,
    overflow: "hidden",
    paddingHorizontal: 3,
    color: "#ffffff",
  },
}));
