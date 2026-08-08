import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Bot, Clock, ShieldCheck } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { FeedCardEvent } from "@/screens/mission-control/feed-card";

export type ProposalResolvedStatus = "sent" | "denied";

const ThemedBot = withUnistyles(Bot);
const ThemedClock = withUnistyles(Clock);
const ThemedShieldCheck = withUnistyles(ShieldCheck);

const originIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function originLabel(origin: MissionControlProposal["origin"]): string {
  switch (origin) {
    case "verifier":
      return "Verifier contact";
    case "commander":
      return "Commander";
    case "stall":
      return "Stall check";
  }
}

/** True while the proposal still needs a user decision (Ask mode / forced ask). */
export function isPendingProposalEvent(event: FeedCardEvent): boolean {
  return event.kind === "proposal" && event.proposal?.status === "pending";
}

export function countPendingProposals(events: readonly FeedCardEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (isPendingProposalEvent(event)) {
      count += 1;
    }
  }
  return count;
}

export interface ProposalCardProps {
  proposal: MissionControlProposal;
  event: FeedCardEvent;
  /** Called once the proposal has a terminal outcome so the feed can supersede. */
  onResolved?: (proposalId: string, status: ProposalResolvedStatus) => void;
}

/**
 * Approval-gate proposal card: origin, target agent, drafted message, reason,
 * and Approve / Edit / Deny. Verifier exchanges carry an allow-pair checkbox
 * that auto-approves the rest of the exchange. Owns the respond RPC and its
 * pending/error state.
 */
export function ProposalCard({ proposal, event, onResolved }: ProposalCardProps): ReactElement {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.message);
  const [allowPair, setAllowPair] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveAgent = useSessionStore((state) =>
    event.serverId && event.agentId
      ? (state.sessions[event.serverId]?.agents.get(event.agentId) ?? null)
      : null,
  );
  const agentChipLabel = liveAgent?.name ?? liveAgent?.title ?? event.agentTitle;

  const respond = useCallback(
    async (action: "approve" | "deny", editedMessage?: string) => {
      if (isResponding) {
        return;
      }
      setIsResponding(true);
      setError(null);
      try {
        const client = getHostRuntimeStore().getClient(event.serverId);
        if (!client) {
          throw new Error(t("common.errors.hostDisconnected"));
        }
        const result = await client.missionControlProposalsRespond({
          proposalId: proposal.id,
          action,
          ...(editedMessage !== undefined ? { editedMessage } : {}),
          ...(allowPair ? { allowPair: true } : {}),
        });
        if (!result.ok) {
          throw new Error(result.error ?? "Unable to respond");
        }
        setIsEditing(false);
        onResolved?.(proposal.id, action === "approve" ? "sent" : "denied");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsResponding(false);
      }
    },
    [allowPair, event.serverId, isResponding, onResolved, proposal.id, t],
  );

  const isPending = proposal.status === "pending";
  const showAllowPair = isPending && proposal.origin === "verifier";

  const handleApprove = useCallback(() => {
    void respond("approve");
  }, [respond]);

  const handleDeny = useCallback(() => {
    void respond("deny");
  }, [respond]);

  const handleOpenEdit = useCallback(() => {
    setDraft(proposal.message);
    setError(null);
    setIsEditing(true);
  }, [proposal.message]);

  const handleCancelEdit = useCallback(() => {
    setError(null);
    setIsEditing(false);
  }, []);

  const handleSendEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError("Message cannot be empty");
      return;
    }
    void respond("approve", trimmed);
  }, [draft, respond]);

  const originIcon = useMemo(() => {
    if (proposal.origin === "verifier") {
      return <ThemedShieldCheck size={14} uniProps={originIconMapping} />;
    }
    if (proposal.origin === "commander") {
      return <ThemedBot size={14} uniProps={originIconMapping} />;
    }
    return <ThemedClock size={14} uniProps={originIconMapping} />;
  }, [proposal.origin]);

  return (
    <View style={styles.card} testID="mission-control-proposal-card">
      <View style={styles.headerRow}>
        <View style={styles.originSlot}>
          {originIcon}
          <Text style={styles.originLabel}>{originLabel(proposal.origin)}</Text>
        </View>
        {proposal.classification === "destructive" ? (
          <StatusBadge label="Destructive" variant="error" />
        ) : null}
      </View>

      <View style={styles.agentChipRow}>
        <View style={styles.agentChip}>
          <Text style={styles.agentChipText} numberOfLines={1}>
            {agentChipLabel}
          </Text>
        </View>
        <Text style={styles.hostLabel} numberOfLines={1}>
          {event.serverLabel}
        </Text>
      </View>

      {isEditing ? (
        <SettingsTextArea
          accessibilityLabel="Proposal message"
          value={draft}
          onChangeText={setDraft}
          placeholder="Message to send"
          testID="mission-control-proposal-message-input"
          style={styles.messageInput}
        />
      ) : (
        <Text style={styles.message} testID="mission-control-proposal-message">
          {proposal.message}
        </Text>
      )}

      {proposal.reason ? (
        <Text style={styles.reason} numberOfLines={3}>
          {proposal.reason}
        </Text>
      ) : null}

      {showAllowPair ? (
        <View style={styles.allowPairRow}>
          <Text style={styles.allowPairLabel}>Auto-approve this exchange</Text>
          <Switch
            value={allowPair}
            onValueChange={setAllowPair}
            accessibilityLabel="Auto-approve the rest of this verifier exchange"
            testID="mission-control-proposal-allow-pair"
          />
        </View>
      ) : null}

      {isPending ? (
        <View style={styles.actionsRow}>
          {isEditing ? (
            <>
              <Button
                variant="default"
                size="sm"
                onPress={handleSendEdit}
                disabled={isResponding}
                loading={isResponding}
                testID="mission-control-proposal-send"
              >
                Send
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onPress={handleCancelEdit}
                disabled={isResponding}
                testID="mission-control-proposal-cancel-edit"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="default"
                size="sm"
                onPress={handleApprove}
                disabled={isResponding}
                loading={isResponding}
                testID="mission-control-proposal-approve"
              >
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={handleOpenEdit}
                disabled={isResponding}
                testID="mission-control-proposal-edit"
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={handleDeny}
                disabled={isResponding}
                testID="mission-control-proposal-deny"
              >
                Deny
              </Button>
            </>
          )}
        </View>
      ) : (
        <Text style={styles.resolvedLabel}>{proposal.status}</Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  originSlot: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  originLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  agentChipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentChip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    maxWidth: "60%",
  },
  agentChipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  hostLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  messageInput: {
    minHeight: 80,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  reason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  allowPairRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  allowPairLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  resolvedLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
    marginTop: theme.spacing[1],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));
