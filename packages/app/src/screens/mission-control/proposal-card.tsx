import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Bot, ChevronDown, Clock, ShieldCheck } from "lucide-react-native";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { resolvePlanChips, type WorkspaceTitleResolver } from "./proposal-card-chips";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { HostGlyph } from "@/components/host-glyph";
import { useLiveTimeAgo } from "@/hooks/use-compact-time-ago";
import {
  deriveProposalCardIdentity,
  resolveAgentIdentityAcrossSessions,
  resolveOpaqueAgentLabel,
} from "./proposal-card-identity";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import type { Theme } from "@/styles/theme";
import type { CardRunPosition, FeedCardEvent } from "@/screens/mission-control/feed-card";

export type ProposalResolvedStatus = "sent" | "denied";

const ThemedBot = withUnistyles(Bot);
const ThemedClock = withUnistyles(Clock);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedChevronDown = withUnistyles(ChevronDown);

const originIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SubmitProposalResponseParams {
  serverId: string;
  proposalId: string;
  action: "approve" | "deny";
  editedMessage?: string;
  reason?: string;
  allowPair: boolean;
  t: TFunction;
}

/** The respond RPC, lifted out of ProposalCard to keep its complexity bounded. */
async function submitProposalResponse({
  serverId,
  proposalId,
  action,
  editedMessage,
  reason,
  allowPair,
  t,
}: SubmitProposalResponseParams): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error(t("common.errors.hostDisconnected"));
  }
  const result = await client.missionControlProposalsRespond({
    proposalId,
    action,
    ...(editedMessage !== undefined ? { editedMessage } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(allowPair ? { allowPair: true } : {}),
  });
  if (!result.ok) {
    throw new Error(result.error ?? "Unable to respond");
  }
}

interface ProposalCardActionsProps {
  isPending: boolean;
  isEditing: boolean;
  isResponding: boolean;
  showAllowPair: boolean;
  allowPair: boolean;
  onAllowPairChange: (value: boolean) => void;
  onSendEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onOpenEdit: () => void;
  onDeny: () => void;
  isDenyReasonOpen: boolean;
  denyReason: string;
  onDenyReasonChange: (value: string) => void;
  onCancelDenyReason: () => void;
  error: string | null;
  resolvedStatus: string;
}

/**
 * The proposal's interactive tail (allow-pair row, pending actions / resolved
 * label, error). Lifted out of ProposalCard to keep its complexity bounded.
 */
function ProposalCardActions({
  isPending,
  isEditing,
  isResponding,
  showAllowPair,
  allowPair,
  onAllowPairChange,
  onSendEdit,
  onCancelEdit,
  onApprove,
  onOpenEdit,
  onDeny,
  isDenyReasonOpen,
  denyReason,
  onDenyReasonChange,
  onCancelDenyReason,
  error,
  resolvedStatus,
}: ProposalCardActionsProps): ReactElement {
  let pendingActions: ReactElement;
  if (isEditing) {
    pendingActions = (
      <>
        <Button
          variant="default"
          size="sm"
          onPress={onSendEdit}
          disabled={isResponding}
          loading={isResponding}
          testID="mission-control-proposal-send"
        >
          Send
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onPress={onCancelEdit}
          disabled={isResponding}
          testID="mission-control-proposal-cancel-edit"
        >
          Cancel
        </Button>
      </>
    );
  } else if (isDenyReasonOpen) {
    pendingActions = (
      <>
        <Button
          variant="ghost"
          size="sm"
          onPress={onDeny}
          disabled={isResponding}
          loading={isResponding}
          testID="mission-control-proposal-deny"
        >
          Deny
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onPress={onCancelDenyReason}
          disabled={isResponding}
          testID="mission-control-proposal-cancel-deny-reason"
        >
          Cancel
        </Button>
      </>
    );
  } else {
    pendingActions = (
      <>
        <Button
          variant="default"
          size="sm"
          onPress={onApprove}
          disabled={isResponding}
          loading={isResponding}
          testID="mission-control-proposal-approve"
        >
          Approve
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={onOpenEdit}
          disabled={isResponding}
          testID="mission-control-proposal-edit"
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onDeny}
          disabled={isResponding}
          testID="mission-control-proposal-deny"
        >
          Deny
        </Button>
      </>
    );
  }

  return (
    <>
      {showAllowPair ? (
        <View style={styles.allowPairRow}>
          <Text style={styles.allowPairLabel}>Auto-approve this exchange</Text>
          <Switch
            value={allowPair}
            onValueChange={onAllowPairChange}
            accessibilityLabel="Auto-approve the rest of this verifier exchange"
            testID="mission-control-proposal-allow-pair"
          />
        </View>
      ) : null}

      {isPending ? (
        <>
          {isDenyReasonOpen ? (
            <View style={styles.denyReasonRow}>
              <SettingsTextArea
                accessibilityLabel="Deny reason"
                value={denyReason}
                onChangeText={onDenyReasonChange}
                placeholder="Reason (optional)"
                testID="mission-control-proposal-deny-reason-input"
                style={styles.denyReasonInput}
              />
            </View>
          ) : null}
          <View style={styles.actionsRow}>{pendingActions}</View>
        </>
      ) : (
        <Text style={styles.resolvedLabel}>{resolvedStatus}</Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

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

function getMetaSummary(
  metaPlan: NonNullable<MissionControlProposal["metaPlan"]>,
  t: TFunction,
): string {
  const target = metaPlan.targetLabel ?? metaPlan.targetId ?? "";
  const name = metaPlan.newValue ?? "";
  const destination = metaPlan.destination ?? "";
  switch (metaPlan.action) {
    case "rename_project":
      return t("missionControl.proposal.meta.renameProject", { target, name });
    case "rename_workspace":
      return t("missionControl.proposal.meta.renameWorkspace", { target, name });
    case "rename_agent_title":
      return t("missionControl.proposal.meta.renameAgentTitle", { target, name });
    case "archive_project":
      return t("missionControl.proposal.meta.archiveProject", { target });
    case "archive_workspace":
      return t("missionControl.proposal.meta.archiveWorkspace", { target });
    case "archive_agent":
      return t("missionControl.proposal.meta.archiveAgent", { target });
    case "create_project":
      return t("missionControl.proposal.meta.createProject", { target: target || name });
    case "move_agent":
      return t("missionControl.proposal.meta.moveAgent", { target, destination });
    case "promote_workspace":
      return t("missionControl.proposal.meta.promoteWorkspace", { target, destination });
    case "adopt_agent":
      return `Adopt agent ${target}`;
    case "release_agent":
      return `Release agent ${target} from Commander`;
    default:
      return target;
  }
}

/** True while the proposal still needs a user decision (Ask mode / forced ask). */
export function isPendingProposalEvent(event: FeedCardEvent): boolean {
  return event.kind === "proposal" && event.proposal?.status === "pending";
}

// Shared with thread row classification (classifyThreadRow): verbose-only
// stall nudges are "skip" in normal mode. Re-export keeps feed-card's
// `import ... from "./proposal-card"` unchanged.
export { isVerboseOnlyProposalEvent } from "./thread-classification";

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
  /** Verbose mode (per-device MC header overflow toggle). Defaults to false. */
  verbose?: boolean;
  /**
   * Position within this card's run of adjacent cards (see CardRunPosition).
   * The thread derives it from same-family rows; standalone cards default to
   * "only" and keep all four rounded corners.
   */
  position?: CardRunPosition;
  /** Called once the proposal has a terminal outcome so the feed can supersede. */
  onResolved?: (proposalId: string, status: ProposalResolvedStatus) => void;
}

/**
 * Approval-gate proposal card: origin, target agent, drafted message, reason,
 * and Approve / Edit / Deny. Verifier exchanges carry an allow-pair checkbox
 * that auto-approves the rest of the exchange. Owns the respond RPC and its
 * pending/error state.
 */
export function ProposalCard({
  proposal,
  event,
  verbose = false,
  onResolved,
  position = "only",
}: ProposalCardProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.message);
  const [isDenyReasonOpen, setIsDenyReasonOpen] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [allowPair, setAllowPair] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPayloadExpanded, setIsPayloadExpanded] = useState(true);
  // Every host session (agents + agentDetails, incl. peer hosts and archived
  // agents): app-composed chrome resolves opaque stored ids across the whole
  // fleet, not just the card's own host. The selector returns the sessions
  // record reference, which only changes when sessions change.
  const sessions = useSessionStore((state) => state.sessions);
  // Workspace titles for plan chips resolve from the live session store like
  // every other surface (title ?? name); the id is a record key, never a
  // display label. Selecting the map reference keeps the card reactive to
  // workspace renames without re-subscribing per workspace.
  const sessionWorkspaces = useSessionStore((state) =>
    event.serverId ? (state.sessions[event.serverId]?.workspaces ?? null) : null,
  );
  const resolveWorkspaceTitle = useCallback<WorkspaceTitleResolver>(
    (workspaceId: string) => {
      const workspace = sessionWorkspaces?.get(workspaceId);
      const title = workspace?.title?.trim() || workspace?.name?.trim();
      return title || undefined;
    },
    [sessionWorkspaces],
  );
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;
  // App-composed chrome: the stored title snapshot stays the card copy unless
  // it is an opaque agent id (the daemon's title fallback for unnamed
  // subjects) — those resolve to the record's own label / live fleet identity
  // across ALL host sessions / the neutral fallback, never a raw UUID. Only
  // the name chip may read live identity (names are write-once).
  const { title: agentTitle, agentChipLabel } = deriveProposalCardIdentity(
    event,
    proposal,
    sessions,
    hideAgentNames,
  );
  const resolveAgentLabel = useCallback(
    (rawAgent: string) =>
      resolveOpaqueAgentLabel(rawAgent, [event.agentId, proposal.targetAgentId], (agentId) =>
        resolveAgentIdentityAcrossSessions(sessions, agentId),
      ),
    [event.agentId, proposal.targetAgentId, sessions],
  );
  const timestamp = new Date(event.ts);
  // Live relative time via the shared ticker; the label ages in place without
  // re-rendering the card or the list.
  const timeAgo = useLiveTimeAgo(timestamp);

  const respond = useCallback(
    async (action: "approve" | "deny", editedMessage?: string, reason?: string) => {
      if (isResponding) {
        return;
      }
      setIsResponding(true);
      setError(null);
      try {
        await submitProposalResponse({
          serverId: event.serverId,
          proposalId: proposal.id,
          action,
          editedMessage,
          reason,
          allowPair,
          t,
        });
        setIsEditing(false);
        setIsDenyReasonOpen(false);
        setDenyReason("");
        onResolved?.(proposal.id, action === "approve" ? "sent" : "denied");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        // Errors must never be silent: the respond RPC now carries spawn and
        // delivery failures back (ok:false), so surface them as a toast too —
        // the card's inline error can be lost when the feed re-renders the
        // proposal from its aggregated event.
        toast.error(message);
      } finally {
        setIsResponding(false);
      }
    },
    [allowPair, event.serverId, isResponding, onResolved, proposal.id, t, toast],
  );

  const isPending = proposal.status === "pending";
  const showAllowPair = isPending && proposal.origin === "verifier";

  const handleApprove = useCallback(() => {
    void respond("approve");
  }, [respond]);

  const handleDeny = useCallback(() => {
    // First press reveals the optional reason field; the second press submits
    // (empty reason = plain deny, skippable).
    if (!isDenyReasonOpen) {
      setError(null);
      setIsDenyReasonOpen(true);
      return;
    }
    const trimmed = denyReason.trim();
    void respond("deny", undefined, trimmed.length > 0 ? trimmed : undefined);
  }, [denyReason, isDenyReasonOpen, respond]);

  const handleCancelDenyReason = useCallback(() => {
    setError(null);
    setIsDenyReasonOpen(false);
    setDenyReason("");
  }, []);

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

  const handleTogglePayload = useCallback(() => {
    setIsPayloadExpanded((prev) => !prev);
  }, []);

  const originIcon = useMemo(() => {
    if (proposal.origin === "verifier") {
      return <ThemedShieldCheck size={14} uniProps={originIconMapping} />;
    }
    if (proposal.origin === "commander") {
      return <ThemedBot size={14} uniProps={originIconMapping} />;
    }
    return <ThemedClock size={14} uniProps={originIconMapping} />;
  }, [proposal.origin]);

  const modelName = useMemo(() => {
    const spawnPlan = proposal.spawnPlan;
    if (!spawnPlan) {
      return undefined;
    }
    if (spawnPlan.model) {
      return spawnPlan.provider ? `${spawnPlan.provider}/${spawnPlan.model}` : spawnPlan.model;
    }
    return spawnPlan.provider;
  }, [proposal.spawnPlan]);

  return (
    <View
      style={[
        styles.card,
        position === "first" && styles.cardRunFirst,
        position === "middle" && styles.cardRunMiddle,
        position === "last" && styles.cardRunLast,
      ]}
      testID="mission-control-proposal-card"
    >
      <View style={styles.iconSlot}>{originIcon}</View>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.originLabel}>{originLabel(proposal.origin)}</Text>
          {proposal.classification === "destructive" ? (
            <StatusBadge label="Destructive" variant="error" />
          ) : null}
        </View>

        <Text style={styles.agentTitle} numberOfLines={1}>
          {agentTitle}
        </Text>

        <View style={styles.agentChipRow}>
          <View style={styles.agentChip}>
            <Text style={styles.agentChipText} numberOfLines={1}>
              {agentChipLabel}
            </Text>
          </View>
          <Text style={styles.metaSeparator}>·</Text>
          <HostGlyph
            serverId={event.serverId}
            label={event.serverLabel}
            size="sm"
            testID="mission-control-proposal-host-glyph"
          />
          <Text style={styles.metaSeparator}>·</Text>
          <Text style={styles.timestamp}>{timeAgo}</Text>
        </View>

        {(() => {
          const chips = resolvePlanChips(proposal, t, resolveWorkspaceTitle, resolveAgentLabel);
          if (chips.length === 0) return null;
          return (
            <View style={styles.planChipsRow} testID="mission-control-proposal-chips">
              {chips.map((c) => (
                <View key={c.key} style={styles.planChip}>
                  <Text style={styles.planChipText}>{c.label}</Text>
                </View>
              ))}
            </View>
          );
        })()}

        {modelName ? (
          <Text style={styles.modelLine} testID="mission-control-proposal-model">
            {t("missionControl.proposal.model", { model: modelName })}
          </Text>
        ) : null}

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
            {proposal.metaPlan
              ? getMetaSummary(proposal.metaPlan, t)
              : (proposal.spawnPlan?.summary ?? proposal.message)}
          </Text>
        )}

        {proposal.reason ? (
          <Text style={styles.reason} numberOfLines={3}>
            {proposal.reason}
          </Text>
        ) : null}

        {verbose ? (
          <View style={styles.payloadSection} testID="mission-control-proposal-payload-section">
            <Pressable
              onPress={handleTogglePayload}
              style={styles.payloadToggle}
              accessibilityRole="button"
              accessibilityLabel={t("missionControl.proposal.payload")}
              testID="mission-control-proposal-payload-toggle"
            >
              <Text style={styles.payloadToggleText}>{t("missionControl.proposal.payload")}</Text>
              <ThemedChevronDown size={14} uniProps={originIconMapping} />
            </Pressable>
            {isPayloadExpanded ? (
              <Text style={styles.payloadJson} testID="mission-control-proposal-payload">
                {JSON.stringify(proposal, null, 2)}
              </Text>
            ) : null}
          </View>
        ) : null}

        <ProposalCardActions
          isPending={isPending}
          isEditing={isEditing}
          isResponding={isResponding}
          showAllowPair={showAllowPair}
          allowPair={allowPair}
          onAllowPairChange={setAllowPair}
          onSendEdit={handleSendEdit}
          onCancelEdit={handleCancelEdit}
          onApprove={handleApprove}
          onOpenEdit={handleOpenEdit}
          onDeny={handleDeny}
          isDenyReasonOpen={isDenyReasonOpen}
          denyReason={denyReason}
          onDenyReasonChange={setDenyReason}
          onCancelDenyReason={handleCancelDenyReason}
          error={error}
          resolvedStatus={proposal.status}
        />
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
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  // Run composition (see CardRunPosition): consecutive cards read as ONE
  // rounded rectangle — first keeps the top corners, last the bottom, middle
  // is square; every member carries the side edges and the top border of each
  // member after the first is the hairline divider (design.md §5).
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
  // Same icon-slot column as FeedCard (width 18 + row gap 12) so the proposal
  // content left edge aligns with every other feed card.
  iconSlot: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  originLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  agentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  agentChipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
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
  metaSeparator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  timestamp: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  denyReasonRow: {
    marginTop: theme.spacing[1],
  },
  denyReasonInput: {
    minHeight: 48,
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
  planChipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  planChip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  planChipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  modelLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  payloadSection: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
    paddingTop: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  payloadToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  payloadToggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  payloadJson: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
}));
