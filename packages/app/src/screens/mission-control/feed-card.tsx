import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  CircleCheck,
  CircleX,
  Clock,
  Flag,
  GitFork,
  Rocket,
  Search,
  ShieldAlert,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type {
  MissionControlEvent,
  MissionControlEventKind,
  MissionControlProof,
} from "@getpaseo/protocol/mission-control/types";
import { ExternalLink } from "@/components/ui/external-link";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { formatTimeAgo } from "@/utils/time";

export type FeedCardEvent = MissionControlEvent & {
  serverId: string;
  serverLabel: string;
};

const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedClock = withUnistyles(Clock);
const ThemedFlag = withUnistyles(Flag);
const ThemedGitFork = withUnistyles(GitFork);
const ThemedRocket = withUnistyles(Rocket);
const ThemedSearch = withUnistyles(Search);
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
};

function openEventAgent(event: FeedCardEvent): void {
  const session = useSessionStore.getState().sessions[event.serverId];
  const agent = session?.agents.get(event.agentId);
  const archived = agent ? Boolean(agent.archivedAt) : true;
  void openAgentFromHistory({
    serverId: event.serverId,
    agentId: event.agentId,
    workspaceId: agent?.workspaceId ?? null,
    archived,
  });
}

function proofChipLabel(proof: MissionControlProof): string {
  return (proof.label || proof.url || proof.path || "").trim();
}

function UrlProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proofChipLabel(proof);
  if (!label) {
    return null;
  }
  return <ExternalLink href={proof.url ?? ""} label={label} />;
}

function LabeledProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proofChipLabel(proof);
  if (!label) {
    return null;
  }
  return (
    <View style={styles.proofChip}>
      <Text style={styles.proofChipText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function DiffProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const additions = proof.additions ?? 0;
  const deletions = proof.deletions ?? 0;
  return (
    <View style={styles.proofChip}>
      <Text style={styles.proofChipDiffAdd}>+{additions}</Text>
      <Text style={styles.proofChipDiffDel}>−{deletions}</Text>
    </View>
  );
}

function CommandProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proofChipLabel(proof);
  if (!label) {
    return null;
  }
  return (
    <View style={styles.proofChipCommand}>
      <Text style={styles.proofChipCommandText} numberOfLines={1}>
        {label}
        {proof.exitCode !== undefined ? ` · exit ${proof.exitCode}` : ""}
      </Text>
    </View>
  );
}

function ProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  switch (proof.kind) {
    case "url":
      return <UrlProofChip proof={proof} />;
    case "image":
      return <LabeledProofChip proof={proof} />;
    case "diff":
      return <DiffProofChip proof={proof} />;
    case "command":
      return <CommandProofChip proof={proof} />;
    default:
      return null;
  }
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
      ? (state.sessions[event.serverId]?.agents.get(event.agentId) ?? null)
      : null,
  );
  const agentChipLabel = liveAgent?.name ?? liveAgent?.title ?? event.agentTitle;

  return (
    <View
      style={[styles.card, isBlocker && styles.cardBlocker, isAttention && styles.cardAttention]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`mission-control-feed-card-${event.kind}`}
    >
      <View style={styles.iconSlot}>{kindIcons[event.kind]}</View>
      <View style={styles.content}>
        <Text style={styles.headline} numberOfLines={2}>
          {event.headline}
        </Text>
        {event.detail ? (
          <Text style={styles.detail} numberOfLines={3}>
            {event.detail}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Pressable
            onPress={handleOpenAgent}
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
        {event.proof && event.proof.length > 0 ? (
          <View style={styles.proofRow}>
            {event.proof.map((proof) => (
              <ProofChip
                key={`${event.id}:${proof.kind}:${proof.url ?? proof.path ?? proof.label ?? ""}`}
                proof={proof}
              />
            ))}
          </View>
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
  proofRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  proofChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  proofChipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  proofChipDiffAdd: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.success,
  },
  proofChipDiffDel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  proofChipCommand: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  proofChipCommandText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
