import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  Clock,
  Flag,
  GitFork,
  Rocket,
  Search,
  Send,
  ShieldAlert,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type {
  MissionControlEvent,
  MissionControlEventKind,
} from "@getpaseo/protocol/mission-control/types";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useInspectorStore } from "@/screens/mission-control/inspector-store";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { ProposalCard } from "@/screens/mission-control/proposal-card";
import { formatTimeAgo } from "@/utils/time";
import { ProofSections } from "./proofs/proof-sections";
export type FeedCardEvent = MissionControlEvent & {
  serverId: string;
  serverLabel: string;
};

const ThemedBadgeCheck = withUnistyles(BadgeCheck);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedClock = withUnistyles(Clock);
const ThemedFlag = withUnistyles(Flag);
const ThemedGitFork = withUnistyles(GitFork);
const ThemedRocket = withUnistyles(Rocket);
const ThemedSearch = withUnistyles(Search);
const ThemedSend = withUnistyles(Send);
const ThemedShieldAlert = withUnistyles(ShieldAlert);

const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const kindIcons: Record<MissionControlEventKind, ReactElement> = {
  started: <ThemedRocket size={14} uniProps={iconForegroundMutedMapping} />,
  finished: <ThemedCircleCheck size={14} uniProps={iconForegroundMutedMapping} />,
  failed: <ThemedCircleX size={14} uniProps={iconForegroundMutedMapping} />,
  blocked: <ThemedShieldAlert size={14} uniProps={iconForegroundMutedMapping} />,
  stalled: <ThemedClock size={14} uniProps={iconForegroundMutedMapping} />,
  milestone: <ThemedFlag size={14} uniProps={iconForegroundMutedMapping} />,
  finding: <ThemedSearch size={14} uniProps={iconForegroundMutedMapping} />,
  diverged: <ThemedGitFork size={14} uniProps={iconForegroundMutedMapping} />,
  proposal: <ThemedSend size={14} uniProps={iconForegroundMutedMapping} />,
  verdict: <ThemedBadgeCheck size={14} uniProps={iconForegroundMutedMapping} />,
};

function openEventAgent(event: FeedCardEvent): void {
  useInspectorStore.getState().openInspectorAgent({
    serverId: event.serverId,
    agentId: event.agentId,
  });
}

export function FeedCard({ event }: { event: FeedCardEvent }): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const showOpenAffordance = isHovered || isNative || isCompact;
  const isBlocker = event.severity === "blocker";
  const isAttention = event.severity === "attention";

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleOpenAgent = useCallback(() => openEventAgent(event), [event]);
  const timestamp = new Date(event.ts);
  // The daemon now stamps names onto MC events, but events recorded before
  // that or arriving from older hosts only carry the title — prefer the live
  // agent's identity when one is known.
  const liveAgent = useSessionStore((state) =>
    event.serverId && event.agentId
      ? resolveSessionAgent(state.sessions[event.serverId], event.agentId)
      : null,
  );
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;

  if (event.kind === "proposal" && event.proposal) {
    return <ProposalCard proposal={event.proposal} event={event} />;
  }

  return (
    <FeedCardBody
      event={event}
      showOpenAffordance={showOpenAffordance}
      isBlocker={isBlocker}
      isAttention={isAttention}
      liveAgent={liveAgent}
      hideAgentNames={hideAgentNames}
      timestamp={timestamp}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onOpenAgent={handleOpenAgent}
    />
  );
}

function FeedCardMetaRow({
  event,
  agentChipLabel,
  showOpenAffordance,
  timestamp,
  onOpenAgent,
}: {
  event: FeedCardEvent;
  agentChipLabel: string;
  showOpenAffordance: boolean;
  timestamp: Date;
  onOpenAgent: () => void;
}): ReactElement {
  return (
    <View style={styles.metaRow}>
      <Pressable
        onPress={onOpenAgent}
        accessibilityRole="button"
        accessibilityLabel={`Open agent ${agentChipLabel}`}
        style={styles.agentChip}
        testID="mission-control-feed-agent-chip"
      >
        <Text style={styles.agentChipText} numberOfLines={1}>
          {agentChipLabel}
        </Text>
      </Pressable>
      <Text style={styles.metaSeparator}>·</Text>
      <Text style={styles.hostLabel} numberOfLines={1}>
        {event.serverLabel}
      </Text>
      <Text style={styles.metaSeparator}>·</Text>
      <Text style={styles.timestamp}>{formatTimeAgo(timestamp)}</Text>
      <Text style={[styles.metaSeparator, !showOpenAffordance && styles.openHidden]}>·</Text>
      <Text style={[styles.openLabel, !showOpenAffordance && styles.openHidden]}>open</Text>
    </View>
  );
}

/** Card copy: name/title chip label + started-card identity join (pure). */
function deriveFeedCardText(
  event: FeedCardEvent,
  liveAgent: Agent | null,
  hideAgentNames: boolean,
): { agentChipLabel: string; headline: string; detail: string | null } {
  const agentChipLabel = hideAgentNames
    ? (liveAgent?.title ?? liveAgent?.name ?? event.agentTitle)
    : (liveAgent?.name ?? liveAgent?.title ?? event.agentTitle);
  // Started cards join live identity reactively: once the agent's first
  // report_status lands a title/description, the SAME card shows it (no new
  // event row). A started card never reads as a bare "agent started" once
  // anything better is known.
  const isStarted = event.kind === "started";
  const headline = isStarted && liveAgent?.title ? liveAgent.title : event.headline;
  const detail =
    isStarted && liveAgent?.shortDescription ? liveAgent.shortDescription : (event.detail ?? null);
  return { agentChipLabel, headline, detail };
}

function FeedCardBody({
  event,
  showOpenAffordance,
  isBlocker,
  isAttention,
  liveAgent,
  hideAgentNames,
  timestamp,
  onPointerEnter,
  onPointerLeave,
  onOpenAgent,
}: {
  event: FeedCardEvent;
  showOpenAffordance: boolean;
  isBlocker: boolean;
  isAttention: boolean;
  liveAgent: Agent | null;
  hideAgentNames: boolean;
  timestamp: Date;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpenAgent: () => void;
}): ReactElement {
  const { agentChipLabel, headline, detail } = deriveFeedCardText(event, liveAgent, hideAgentNames);

  return (
    <Pressable
      style={[styles.card, isBlocker && styles.cardBlocker, isAttention && styles.cardAttention]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPress={onOpenAgent}
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${agentChipLabel}`}
      testID={`mission-control-feed-card-${event.kind}`}
    >
      <View style={styles.iconSlot}>{kindIcons[event.kind]}</View>
      <View style={styles.content}>
        <Text style={styles.headline} numberOfLines={2}>
          {headline}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={3}>
            {detail}
          </Text>
        ) : null}
        <FeedCardMetaRow
          event={event}
          agentChipLabel={agentChipLabel}
          showOpenAffordance={showOpenAffordance}
          timestamp={timestamp}
          onOpenAgent={onOpenAgent}
        />
        {event.proof && event.proof.length > 0 ? (
          <ProofSections proofs={event.proof} serverId={event.serverId} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "transparent",
    minHeight: 56,
  },
  cardBlocker: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface1,
  },
  cardAttention: {
    backgroundColor: theme.colors.surface1,
  },
  iconSlot: {
    paddingTop: 2,
    width: 18,
    alignItems: "center",
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  headline: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  detail: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  agentChip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  agentChipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  metaSeparator: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  hostLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  timestamp: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  openLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  openHidden: {
    opacity: 0,
  },
}));
