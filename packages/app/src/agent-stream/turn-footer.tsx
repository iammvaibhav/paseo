import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { collectTurnEditedFiles } from "./turn-metrics";
import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { type Theme } from "@/styles/theme";
import {
  TURN_FOOTER_BOTTOM_SPACING,
  TURN_FOOTER_COMPACT_BOTTOM_SPACING,
  type TurnFooterDensity,
} from "./turn-footer-spacing";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import {
  resolveAssistantTurnForkBoundary,
  resolvePrecedingUserMessage,
  type AssistantTurnForkBoundary,
} from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
  type AssistantTurnSourceContext,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
export {
  TURN_FOOTER_BOTTOM_SPACING,
  TURN_FOOTER_COMPACT_BOTTOM_SPACING,
  resolveTurnFooterBottomSpacing,
  type TurnFooterDensity,
} from "./turn-footer-spacing";

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
export type AssistantTurnSecondOpinionHandler = (input: {
  target: { provider: string; model: string };
  boundary: AssistantTurnForkBoundary;
  userMessage?: string;
  assistantText?: string;
  editedFiles?: string[];
}) => Promise<void> | void;
export type JumpToUserMessageHandler = (itemId: string) => void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onJumpToUserMessage,
  onForkInFlightTurn,
  density = "comfortable",
  supportsTurnMetrics,
  canSecondOpinion,
  onSecondOpinionAssistantTurn,
  serverId,
  agentProvider,
  agentModel,
  agentCwd,
  sourceContext,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onJumpToUserMessage?: JumpToUserMessageHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
  density?: TurnFooterDensity;
  supportsTurnMetrics?: boolean;
  canSecondOpinion?: boolean;
  onSecondOpinionAssistantTurn?: AssistantTurnSecondOpinionHandler;
  serverId?: string;
  agentProvider?: string;
  agentModel?: string | null;
  agentCwd?: string | null;
  sourceContext?: AssistantTurnSourceContext;
}) {
  // Compact grid tiles must not keep the live elapsed row or the completed
  // 3-dot/fork chrome. Hide the whole footer, not just the fork control.
  if (density === "compact") {
    return null;
  }
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          onForkInFlightTurn={onForkInFlightTurn}
          density={density}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      supportsTimelineCursor={supportsTimelineCursor}
      onForkAssistantTurn={onForkAssistantTurn}
      onJumpToUserMessage={onJumpToUserMessage}
      supportsTurnMetrics={supportsTurnMetrics}
      canSecondOpinion={canSecondOpinion}
      onSecondOpinionAssistantTurn={onSecondOpinionAssistantTurn}
      serverId={serverId}
      agentProvider={agentProvider}
      agentModel={agentModel}
      agentCwd={agentCwd}
      metrics={host.metrics}
      sourceContext={sourceContext}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onJumpToUserMessage,
  supportsTurnMetrics,
  canSecondOpinion,
  onSecondOpinionAssistantTurn,
  serverId,
  agentProvider,
  agentModel,
  agentCwd,
  metrics,
  sourceContext,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onJumpToUserMessage?: JumpToUserMessageHandler;
  supportsTurnMetrics?: boolean;
  canSecondOpinion?: boolean;
  onSecondOpinionAssistantTurn?: AssistantTurnSecondOpinionHandler;
  serverId?: string;
  agentProvider?: string;
  agentModel?: string | null;
  agentCwd?: string | null;
  metrics?: AgentUsage;
  sourceContext?: AssistantTurnSourceContext;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        supportsTimelineCursor={supportsTimelineCursor}
        onForkAssistantTurn={onForkAssistantTurn}
        onJumpToUserMessage={onJumpToUserMessage}
        supportsTurnMetrics={supportsTurnMetrics}
        canSecondOpinion={canSecondOpinion}
        onSecondOpinionAssistantTurn={onSecondOpinionAssistantTurn}
        serverId={serverId}
        agentProvider={agentProvider}
        agentModel={agentModel}
        agentCwd={agentCwd}
        metrics={metrics}
        sourceContext={sourceContext}
      />
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
      </View>
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  onForkInFlightTurn,
  density = "comfortable",
}: {
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
  density?: TurnFooterDensity;
}) {
  return (
    <View
      style={
        density === "compact"
          ? [stylesheet.turnFooterSlot, stylesheet.turnFooterSlotCompact]
          : stylesheet.turnFooterSlot
      }
      testID="turn-working-indicator"
    >
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onJumpToUserMessage,
  supportsTurnMetrics = false,
  canSecondOpinion = false,
  onSecondOpinionAssistantTurn,
  serverId,
  agentProvider,
  agentModel,
  agentCwd,
  metrics: explicitMetrics,
  sourceContext,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onJumpToUserMessage?: JumpToUserMessageHandler;
  supportsTurnMetrics?: boolean;
  canSecondOpinion?: boolean;
  onSecondOpinionAssistantTurn?: AssistantTurnSecondOpinionHandler;
  serverId?: string;
  agentProvider?: string;
  agentModel?: string | null;
  agentCwd?: string | null;
  metrics?: AgentUsage;
  sourceContext?: AssistantTurnSourceContext;
}) {
  const assistantItem = items[startIndex];
  const metrics =
    explicitMetrics ??
    (assistantItem && assistantItem.kind === "assistant_message"
      ? assistantItem.metrics
      : undefined);
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const precedingUserMessage = useMemo(
    () =>
      resolvePrecedingUserMessage({
        items,
        startIndex,
        getNeighborIndex: strategy.getNeighborIndex,
      }),
    [items, startIndex, strategy],
  );
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  const handleJumpToUserMessage = useCallback(() => {
    if (!precedingUserMessage || !onJumpToUserMessage) {
      return;
    }
    onJumpToUserMessage(precedingUserMessage.id);
  }, [onJumpToUserMessage, precedingUserMessage]);

  const handleSecondOpinion = useCallback(
    async (target: { provider: string; model: string }) => {
      if (!boundary || !onSecondOpinionAssistantTurn) return;
      const assistantText = getContent();
      const userMessage = precedingUserMessage?.text;
      const editedFiles = collectTurnEditedFiles({
        items,
        startIndex,
        getNeighborIndex: strategy.getNeighborIndex,
      });
      await onSecondOpinionAssistantTurn({
        target,
        boundary,
        userMessage,
        assistantText,
        editedFiles,
      });
    },
    [
      boundary,
      onSecondOpinionAssistantTurn,
      getContent,
      precedingUserMessage?.text,
      items,
      startIndex,
      strategy.getNeighborIndex,
    ],
  );

  const secondOpinionProps = useMemo(
    () =>
      canSecondOpinion && boundary && onSecondOpinionAssistantTurn && serverId
        ? {
            serverId,
            currentProvider: agentProvider,
            currentModel: metrics?.model ?? agentModel ?? null,
            cwd: agentCwd,
            onSecondOpinion: handleSecondOpinion,
          }
        : undefined,
    [
      agentCwd,
      agentModel,
      agentProvider,
      boundary,
      canSecondOpinion,
      handleSecondOpinion,
      metrics?.model,
      onSecondOpinionAssistantTurn,
      serverId,
    ],
  );

  return (
    <View style={stylesheet.turnFooterSlot}>
      <AssistantTurnFooter
        getContent={getContent}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs}
        metrics={metrics}
        model={agentModel}
        turnMetricsEnabled={supportsTurnMetrics}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
        onJumpToUserMessage={
          precedingUserMessage && onJumpToUserMessage ? handleJumpToUserMessage : undefined
        }
        onSecondOpinion={secondOpinionProps}
        sourceContext={sourceContext}
      />
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return <View style={rowStyle}>{children}</View>;
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    // Web flex parents often ignore alignSelf centering; match the composer.
    marginHorizontal: "auto",
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  turnFooterRow: {
    marginTop: theme.spacing[2] + 5,
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    minHeight: 24,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterSlotCompact: {
    paddingBottom: TURN_FOOTER_COMPACT_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
