import { type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react-native";
import { HostGlyph } from "@/components/host-glyph";
import { useLiveTimeAgo } from "@/hooks/use-compact-time-ago";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useSessionStore } from "@/stores/session-store";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import type { Theme } from "@/styles/theme";
import type { CardRunPosition, FeedCardEvent } from "./feed-card";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface AnswerCardProps {
  event: FeedCardEvent;
  position?: CardRunPosition;
}

export function AnswerCard({ event, position = "only" }: AnswerCardProps): ReactElement | null {
  const { t } = useTranslation();
  const answer = event.answer;

  const targetAgentId = answer?.agentId ?? event.agentId;
  const liveAgent = useSessionStore((state) =>
    event.serverId && targetAgentId
      ? resolveSessionAgent(state.sessions[event.serverId], targetAgentId)
      : null,
  );
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;
  const agentTitle = event.agentTitle;
  const agentChipLabel = hideAgentNames ? agentTitle : (liveAgent?.name ?? agentTitle);
  const timestamp = new Date(event.ts);
  const timeAgo = useLiveTimeAgo(timestamp);

  if (!answer) {
    return null;
  }

  const isAgentStatus = answer.kind === "agent_status";

  return (
    <View
      style={[
        styles.card,
        position === "first" && styles.cardRunFirst,
        position === "middle" && styles.cardRunMiddle,
        position === "last" && styles.cardRunLast,
      ]}
      testID="mission-control-answer-card"
    >
      <View style={styles.iconSlot}>
        <ThemedMessageSquare size={14} uniProps={iconMapping} />
      </View>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.originLabel}>{t("missionControl.answer.title")}</Text>
          {isAgentStatus ? (
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>{t("missionControl.answer.agentStatus")}</Text>
            </View>
          ) : null}
        </View>

        {isAgentStatus ? (
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
              testID="mission-control-answer-host-glyph"
            />
            <Text style={styles.metaSeparator}>·</Text>
            <Text style={styles.timestamp}>{timeAgo}</Text>
          </View>
        ) : null}

        <Text style={styles.headline} testID="mission-control-answer-headline">
          {answer.headline}
        </Text>

        {answer.body ? (
          <Text style={styles.body} testID="mission-control-answer-body">
            {answer.body}
          </Text>
        ) : null}

        {answer.fields && answer.fields.length > 0 ? (
          <View style={styles.fieldsContainer} testID="mission-control-answer-fields">
            {answer.fields.map((field) => (
              <View key={field.label} style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>{field.label}:</Text>
                <Text style={styles.fieldValue}>{field.value}</Text>
              </View>
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
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
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
  statusBadge: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  statusBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  headline: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
  },
  body: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  fieldsContainer: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface0,
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  fieldValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    flex: 1,
  },
}));
