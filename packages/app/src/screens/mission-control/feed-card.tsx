import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  BadgeCheck,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Flag,
  GitBranch,
  GitFork,
  HelpCircle,
  LoaderCircle,
  MessageSquareText,
  Rocket,
  Search,
  Send,
  ShieldAlert,
  Wrench,
} from "lucide-react-native";
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
import { isVerboseOnlyProposalEvent, ProposalCard } from "./proposal-card";
import { ClarificationCard } from "./clarification-card";
import { AnswerCard } from "./answer-card";
import { useLiveTimeAgo } from "@/hooks/use-compact-time-ago";
import { ProofSections } from "./proofs/proof-sections";
import { HostGlyph } from "@/components/host-glyph";
export type FeedCardEvent = MissionControlEvent & {
  serverId: string;
  serverLabel: string;
};

/**
 * Position of a card within its run of adjacent cards in the thread. Runs are
 * derived from adjacent same-family rows (event rows that render as cards),
 * never from index parity. A run of one card is "only" and keeps the
 * standalone pill; run members square their inner corners and share the run's
 * frame so a run reads as ONE rounded rectangle with hairline dividers
 * (design.md §5).
 */
export type CardRunPosition = "only" | "first" | "middle" | "last";

/**
 * Row classification for card-run derivation (see `cardRunPosition`):
 * - "card": renders a card in the current mode — a run member.
 * - "skip": renders nothing and takes no vertical space (verbose-only
 *   machinery hidden by normal mode) — transparent to runs: the cards on
 *   either side are still visually adjacent.
 * - "gap": renders visible non-card content (messages, tool calls) — breaks
 *   runs.
 */
export type CardRunRowClass = "card" | "skip" | "gap";

/**
 * Position of `index` within its maximal run of consecutive card rows. A run
 * is a maximal sequence of adjacent rows classified "card"; "skip" rows
 * (zero-height, render nothing) are transparent — they neither join nor break
 * a run — and "gap" rows break it. A run of one card is "only". Throws when
 * the row at `index` is not classified "card".
 */
export function cardRunPosition<T>(
  rows: readonly T[],
  index: number,
  classify: (row: T) => CardRunRowClass,
): CardRunPosition {
  if (classify(rows[index]) !== "card") {
    throw new RangeError(`cardRunPosition: row ${index} is not a card row`);
  }
  const hasCardAbove = hasCardNeighbor(rows, index - 1, -1, classify);
  const hasCardBelow = hasCardNeighbor(rows, index + 1, 1, classify);
  if (hasCardAbove && hasCardBelow) {
    return "middle";
  }
  if (hasCardAbove) {
    return "last";
  }
  if (hasCardBelow) {
    return "first";
  }
  return "only";
}

function hasCardNeighbor<T>(
  rows: readonly T[],
  from: number,
  step: 1 | -1,
  classify: (row: T) => CardRunRowClass,
): boolean {
  for (let i = from; i >= 0 && i < rows.length; i += step) {
    const rowClass = classify(rows[i]);
    if (rowClass === "card") {
      return true;
    }
    if (rowClass === "gap") {
      return false;
    }
    // "skip": zero-height row — look past it to the next visible row.
  }
  return false;
}

const ThemedBadgeCheck = withUnistyles(BadgeCheck);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleSlash = withUnistyles(CircleSlash);
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
const ThemedHelpCircle = withUnistyles(HelpCircle);
const ThemedMessageSquareText = withUnistyles(MessageSquareText);

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
  // A run superseded by a USER prompt (interrupt-and-send): distinct
  // non-error glyph — the interruption is the user's own action, nothing
  // failed. Same muted tone as the other status icons.
  interrupted: <ThemedCircleSlash size={14} uniProps={iconForegroundMutedMapping} />,
  clarification: <ThemedHelpCircle size={14} uniProps={iconForegroundMutedMapping} />,
  answer: <ThemedMessageSquareText size={14} uniProps={iconForegroundMutedMapping} />,
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
  // Verifier-attributed cards (verdict, verification-failed, verifier-origin
  // proposal) open the VERIFIER's thread in the inspector: verifiers are
  // hidden from board buckets but reachable from their cards, and the thread
  // shows the verifier<->worker exchange plus the pending approval cards.
  useInspectorStore.getState().openInspectorAgent({
    serverId: event.serverId,
    agentId: event.verifierAgentId ?? event.agentId,
  });
}

export function FeedCard({
  event,
  verbose = false,
  position = "only",
}: {
  event: FeedCardEvent;
  /**
   * Verbose mode (per-device MC header overflow toggle, default OFF). Normal
   * mode never renders machinery-only cards (stall status-ask nudges); verbose
   * is the debug view. Approval-gated proposals (recovery/verifier/commander)
   * always render.
   */
  verbose?: boolean;
  /**
   * Position within this card's run of adjacent cards (see CardRunPosition).
   * The thread derives it from same-family rows; standalone cards default to
   * "only" and keep all four rounded corners.
   */
  position?: CardRunPosition;
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
    return (
      <ProposalCard proposal={event.proposal} event={event} position={position} verbose={verbose} />
    );
  }

  if (event.kind === "clarification" && event.clarification) {
    return <ClarificationCard event={event} position={position} />;
  }

  if (event.kind === "answer" && event.answer) {
    return <AnswerCard event={event} position={position} />;
  }
  return (
    <FeedCardBody
      event={event}
      position={position}
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
  // Live relative time: the shared ticker re-renders ONLY this label as it
  // ages (see useLiveTimeAgo), never the card or the list.
  const timeAgo = useLiveTimeAgo(timestamp);
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
      <Text style={styles.timestamp}>{timeAgo}</Text>
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
  // Title is frozen from the event snapshot at emit time (immutable card copy).
  const title = event.agentTitle;
  // Agent name chip stays live (names are stable identity); its fallback is
  // the emit-time title snapshot, never the live title.
  const agentChipLabel = hideAgentNames ? title : (liveAgent?.name ?? event.agentTitle);

  // Cards are immutable append-only snapshots: cards render from their stored
  // snapshot, never from live agent identity updates. On started cards, the
  // stored shortDescription snapshot (if present at emit time) is shown;
  // legacy rows with no snapshot fall back to the event's own headline.
  let headline: string | null = event.headline === title ? null : event.headline;
  if (event.kind === "started" && event.shortDescription) {
    headline = event.shortDescription;
  }
  return { agentChipLabel, title, headline, detail: event.detail ?? null };
}

function FeedCardBody({
  event,
  position,
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
  position: CardRunPosition;
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

  // hover.md separate-inner-Pressable doctrine: the frame is a plain View
  // (hover tracker, card geometry, testID), the "Open agent" press lives on a
  // SEPARATE inner Pressable, and the interactive meta row / proof sections
  // render as SIBLINGS of that Pressable — a button role must never wrap
  // another button role (React nesting + hydration error, BUG-8).
  return (
    <View
      style={[
        styles.card,
        isBlocker && styles.cardBlocker,
        isAttention && styles.cardAttention,
        position !== "only" && styles.cardInRun,
        position === "first" && styles.cardRunFirst,
        position === "middle" && styles.cardRunMiddle,
        position === "last" && styles.cardRunLast,
      ]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      testID={`mission-control-feed-card-${event.kind}`}
    >
      <View style={styles.iconSlot}>{eventIcon(event)}</View>
      <View style={styles.content}>
        <Pressable
          onPress={onOpenAgent}
          accessibilityRole="button"
          accessibilityLabel={`Open agent ${agentChipLabel}`}
          testID="mission-control-feed-card-open"
        >
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
        </Pressable>
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
    </View>
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
  // Run composition (see CardRunPosition): consecutive cards read as ONE
  // rounded rectangle — first keeps the top corners, last the bottom, middle
  // is square; every member carries the side edges and the top border of each
  // member after the first is the hairline divider (design.md §5).
  cardInRun: {
    // Run members join the group frame: shared surface + border-colored edge.
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  cardRunFirst: {
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius.md,
    borderTopRightRadius: theme.borderRadius.md,
    borderBottomLeftRadius: theme.borderRadius.none,
    borderBottomRightRadius: theme.borderRadius.none,
  },
  cardRunMiddle: {
    borderBottomWidth: 0,
    borderRadius: theme.borderRadius.none,
  },
  cardRunLast: {
    borderTopLeftRadius: theme.borderRadius.none,
    borderTopRightRadius: theme.borderRadius.none,
    borderBottomLeftRadius: theme.borderRadius.md,
    borderBottomRightRadius: theme.borderRadius.md,
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
