import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { SettingsTextArea } from "@/components/settings-textarea";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { encodeImages } from "@/utils/encode-images";
import { HostGlyph } from "@/components/host-glyph";
import { useLiveTimeAgo } from "@/hooks/use-compact-time-ago";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { useSessionStore } from "@/stores/session-store";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import type { Theme } from "@/styles/theme";
import type { CardRunPosition, FeedCardEvent } from "./feed-card";
import { filterClarificationOptions } from "./clarification-card-options";

const ThemedHelpCircle = withUnistyles(HelpCircle);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ClarificationCardProps {
  event: FeedCardEvent;
  position?: CardRunPosition;
}

export function ClarificationCard({
  event,
  position = "only",
}: ClarificationCardProps): ReactElement | null {
  const { t } = useTranslation();
  const clarification = event.clarification;
  const [answeredWith, setAnsweredWith] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveAgent = useSessionStore((state) =>
    event.serverId && event.agentId
      ? resolveSessionAgent(state.sessions[event.serverId], event.agentId)
      : null,
  );
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;
  const agentTitle = event.agentTitle;
  const agentChipLabel = hideAgentNames ? agentTitle : (liveAgent?.name ?? event.agentTitle);
  const timestamp = new Date(event.ts);
  const timeAgo = useLiveTimeAgo(timestamp);

  const handleSelectOption = useCallback(
    async (option: string) => {
      if (isSending || answeredWith !== null) {
        return;
      }
      setIsSending(true);
      setError(null);
      try {
        const client = getHostRuntimeStore().getClient(event.serverId);
        if (!client) {
          throw new Error(t("common.errors.hostDisconnected"));
        }
        await dispatchComposerAgentMessage({
          client,
          agentId: event.agentId,
          text: option,
          attachments: [],
          encodeImages,
          submission: createMessageSubmissionWriter(event.serverId),
        });
        setAnsweredWith(option);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsSending(false);
      }
    },
    [answeredWith, event.agentId, event.serverId, isSending, t],
  );

  const handleSubmitFreeText = useCallback(() => {
    const trimmed = freeText.trim();
    if (trimmed.length > 0) {
      void handleSelectOption(trimmed);
    }
  }, [freeText, handleSelectOption]);

  const handleOptionPress = useCallback(
    (option: string) => () => {
      void handleSelectOption(option);
    },
    [handleSelectOption],
  );

  if (!clarification) {
    return null;
  }

  const clickableOptions = filterClarificationOptions(
    clarification.options,
    clarification.allowFreeText,
  );

  return (
    <View
      style={[
        styles.card,
        position === "first" && styles.cardRunFirst,
        position === "middle" && styles.cardRunMiddle,
        position === "last" && styles.cardRunLast,
      ]}
      testID="mission-control-clarification-card"
    >
      <View style={styles.iconSlot}>
        <ThemedHelpCircle size={14} uniProps={iconMapping} />
      </View>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.originLabel}>{t("missionControl.clarification.title")}</Text>
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
            testID="mission-control-clarification-host-glyph"
          />
          <Text style={styles.metaSeparator}>·</Text>
          <Text style={styles.timestamp}>{timeAgo}</Text>
        </View>

        <Text style={styles.questionText} testID="mission-control-clarification-question">
          {clarification.question}
        </Text>

        {answeredWith !== null ? (
          <Text style={styles.answeredLabel} testID="mission-control-clarification-answered">
            {t("missionControl.clarification.answered", { answer: answeredWith })}
          </Text>
        ) : (
          <>
            {clickableOptions.length > 0 ? (
              <View style={styles.optionsRow}>
                {clickableOptions.map((opt, idx) => (
                  <Button
                    key={opt}
                    variant="outline"
                    size="sm"
                    disabled={isSending}
                    onPress={handleOptionPress(opt)}
                    testID={`mission-control-clarification-option-${idx}`}
                  >
                    {opt}
                  </Button>
                ))}
              </View>
            ) : null}

            {clarification.allowFreeText ? (
              <View style={styles.freeTextRow}>
                <SettingsTextArea
                  accessibilityLabel="Clarification answer"
                  value={freeText}
                  onChangeText={setFreeText}
                  placeholder={t("missionControl.clarification.answerPlaceholder")}
                  testID="mission-control-clarification-input"
                  style={styles.input}
                />
                <Button
                  variant="default"
                  size="sm"
                  disabled={isSending || freeText.trim().length === 0}
                  loading={isSending}
                  onPress={handleSubmitFreeText}
                  testID="mission-control-clarification-submit"
                >
                  {t("missionControl.clarification.send")}
                </Button>
              </View>
            ) : null}
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
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
  questionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
  },
  optionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  freeTextRow: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  input: {
    minHeight: 60,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  answeredLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
    marginTop: theme.spacing[1],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));
