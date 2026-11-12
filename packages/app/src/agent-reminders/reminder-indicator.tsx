import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { AlarmClock } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentReminder } from "@getpaseo/protocol/agent-reminders";
import type { Theme } from "@/styles/theme";
import { useFormatReminderTime } from "@/agent-reminders/reminder-menu";

const ThemedAlarmClock = withUnistyles(AlarmClock);
const accentMapping = (theme: Theme) => ({ color: theme.colors.accent });

/** Marks an agent that has a pending "Remind me" reminder. Renders nothing otherwise. */
export function AgentReminderIndicator({
  reminder,
  size = 12,
  testID,
}: {
  reminder: AgentReminder | null | undefined;
  size?: number;
  testID?: string;
}) {
  const { t } = useTranslation();
  const formatWhen = useFormatReminderTime();
  if (!reminder) return null;
  const label = t("reminders.indicator", { when: formatWhen(new Date(reminder.remindAt)) });
  return (
    <View style={styles.slot} accessibilityLabel={label} accessible testID={testID}>
      <ThemedAlarmClock size={size} uniProps={accentMapping} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));
