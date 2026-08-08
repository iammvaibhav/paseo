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
  GitBranch,
  GitFork,
  LoaderCircle,
  Rocket,
  Search,
  Send,
  ShieldAlert,
  Wrench,
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
import { isVerboseOnlyProposalEvent, ProposalCard } from "@/screens/mission-control/proposal-card";
import { formatTimeAgo } from "@/utils/time";
import { ProofSections } from "./proofs/proof-sections";
import { HostGlyph } from "@/components/host-glyph";
export type FeedCardEvent = MissionControlEvent & {
  serverId: string;
  serverLabel: string;
};

const ThemedBadgeCheck = withUnistyles(BadgeCheck);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedClock = withUnistyles(Clock);
const ThemedFlag = withUnistyles(Flag);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedGitFork = withUnistyles(GitFork);
const ThemedLoaderCircle = withUnistyles(LoaderCircle);
const ThemedRocket = withUnistyles(Rocket);
const ThemedSearch = withUnistyles(Search);
const ThemedSend = withUnistyles(Send);
const ThemedShieldAlert = withUnistyles(ShieldAlert);
const ThemedWrench = withUnistyles(Wrench);

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

/**
 * Card icon for an event. The daemon collapses report_status kinds onto event
 * kinds (fix/decision → "finding", progress → "milestone"), so the original
 * report kind rides `reportKind` (additive, absent on older hosts/events).
 * Each report kind gets a semantically distinct glyph at a glance: finding
 * search, fix wrench, milestone flag, decision branch, progress loader.
 */
function eventIcon(event: FeedCardEvent): ReactElement {
  switch (event.reportKind) {
    case "progress":
      return <ThemedLoaderCircle size={14} uniProps={iconForegroundMutedMapping} />;
    case "fix":
      return <ThemedWrench size={14} uniProps={iconForegroundMutedMapping} />;
    case "decision":
      return <ThemedGitBranch size={14} uniProps={iconForegroundMutedMapping} />;
    default:
      // finding/milestone reports keep the event-kind icon; legacy hosts
      // (no reportKind) keep the collapsed event-kind icon.
      return kindIcons[event.kind];
  }
}

function openEventAgent(event: FeedCardEvent): void {
  useInspectorStore.getState().openInspectorAgent({
    serverId: event.serverId,
    agentId: event.agentId,
  });
}

export function FeedCard({
  event,
  verbose = false,
}: {
  event: FeedCardEvent;
  /**
   * Verbose mode (per-device MC header overflow toggle, default OFF). Normal
   * mode never renders machinery-only cards (stall status-ask nudges); verbose
   * is the debug view. Approval-gated proposals (recovery/verifier/commander)
   * always render.
   */
  verbose?: boolean;
}): ReactElement | null {
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
    if (!verbose && isVerboseOnlyProposalEvent(event)) {
      return null;
    }
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
      <HostGlyph
        serverId={event.serverId}
        label={event.serverLabel}
        size="sm"
        testID="mission-control-feed-host-glyph"
      />
      <Text style={styles.metaSeparator}>·</Text>
      <Text style={styles.timestamp}>{formatTimeAgo(timestamp)}</Text>
      <Text style={[styles.metaSeparator, !showOpenAffordance && styles.openHidden]}>·</Text>
      <Text style={[styles.openLabel, !showOpenAffordance && styles.openHidden]}>open</Text>
    </View>
  );
}

/** Card copy: reactive live identity joined onto every event kind (pure). */
export function deriveFeedCardText(
  event: FeedCardEvent,
  liveAgent: Agent | null,
  hideAgentNames: boolean,
): {
  agentChipLabel: string;
  title: string;
  headline: string | null;
  detail: string | null;
} {
  const title = liveAgent?.title ?? event.agentTitle;
  const agentChipLabel = hideAgentNames
    ? title
    : (liveAgent?.name ?? liveAgent?.title ?? event.agentTitle);
  // Every historical card reacts to a later identity report. Started cards
  // retain their living short description; terminal/status cards keep their
  // event headline below the title rather than collapsing to a bare name chip.
  let headline: string | null = event.headline === title ? null : event.headline;
  if (event.kind === "started" && liveAgent?.shortDescription) {
    headline = liveAgent.shortDescription;
  }
  return { agentChipLabel, title, headline, detail: event.detail ?? null };
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
  const { agentChipLabel, title, headline, detail } = deriveFeedCardText(
    event,
    liveAgent,
    hideAgentNames,
  );

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
      <View style={styles.iconSlot}>{eventIcon(event)}</View>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {headline ? (
          <Text style={styles.headline} numberOfLines={2}>
            {headline}
          </Text>
        ) : null}
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
    overflow: "hidden",
  },
  cardBlocker: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface1,
  },
  cardAttention: {
    backgroundColor: theme.colors.surface1,
  },
  iconSlot: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  headline: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
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
