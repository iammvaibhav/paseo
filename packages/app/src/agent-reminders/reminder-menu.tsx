import { useCallback, useMemo, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { AlarmClock, AlarmClockOff, CalendarClock } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentReminder, AgentReminderPreset } from "@getpaseo/protocol/agent-reminders";
import {
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import type { Theme } from "@/styles/theme";
import {
  cancelAgentReminder,
  setAgentReminder,
  useCustomReminderStore,
} from "@/agent-reminders/actions";
import {
  buildReminderPresetOptions,
  describeReminderTime,
  deviceTimeZone,
} from "@/agent-reminders/reminder-time";

const ThemedAlarmClock = withUnistyles(AlarmClock);
const ThemedAlarmClockOff = withUnistyles(AlarmClockOff);
const ThemedCalendarClock = withUnistyles(CalendarClock);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ALARM_ICON = <ThemedAlarmClock size={14} uniProps={mutedIconMapping} />;
const CUSTOM_ICON = <ThemedCalendarClock size={14} uniProps={mutedIconMapping} />;
const CANCEL_ICON = <ThemedAlarmClockOff size={14} uniProps={mutedIconMapping} />;

const REMINDER_PAGE_ID = "agent-remind-me";

const PRESET_LABEL_KEYS: Record<AgentReminderPreset, string> = {
  in_20m: "reminders.menu.in20m",
  in_1h: "reminders.menu.in1h",
  in_3h: "reminders.menu.in3h",
  tomorrow_9am: "reminders.menu.tomorrow9am",
  next_monday_9am: "reminders.menu.nextMonday9am",
};

/** The agent's pending reminder, as its host last pushed it. */
export function useAgentReminder(serverId: string, agentId: string): AgentReminder | null {
  return useSessionStore(
    (state) => resolveSessionAgent(state.sessions[serverId], agentId)?.reminder ?? null,
  );
}

/** "Tomorrow 9:00 AM", "Today 3:40 PM", "Mon, Oct 26 9:00 AM" in the device's time zone. */
export function useFormatReminderTime(): (at: Date) => string {
  const { t } = useTranslation();
  return useCallback(
    (at: Date) => {
      const when = describeReminderTime(at, new Date(), deviceTimeZone());
      return t(`reminders.when.${when.day}`, { date: when.date, time: when.time });
    },
    [t],
  );
}

interface ReminderPageProps {
  serverId: string;
  agentId: string;
  reminder: AgentReminder | null;
  testIDBase: string;
}

function ReminderPage({ serverId, agentId, reminder, testIDBase }: ReminderPageProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const formatWhen = useFormatReminderTime();
  const options = useMemo(() => buildReminderPresetOptions(new Date(), deviceTimeZone()), []);

  const choose = useCallback(
    (remindAt: Date) => {
      setAgentReminder({ serverId, agentId, remindAt, note: reminder?.note ?? null })
        .then((set) =>
          toast.show(t("reminders.toast.set", { when: formatWhen(new Date(set.remindAt)) })),
        )
        .catch((error: unknown) =>
          toast.error(
            t("reminders.toast.setFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    },
    [agentId, formatWhen, reminder?.note, serverId, t, toast],
  );

  const handleCustom = useCallback(() => {
    useCustomReminderStore.getState().open({ serverId, agentId, note: reminder?.note ?? null });
  }, [agentId, reminder?.note, serverId]);

  const handleCancel = useCallback(() => {
    cancelAgentReminder(serverId, agentId)
      .then(() => toast.show(t("reminders.toast.cancelled")))
      .catch((error: unknown) =>
        toast.error(
          t("reminders.toast.cancelFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
  }, [agentId, serverId, t, toast]);

  return (
    <>
      {options.map((option) => (
        <PresetRow
          key={option.preset}
          at={option.at}
          label={t(PRESET_LABEL_KEYS[option.preset])}
          hint={formatWhen(option.at)}
          onChoose={choose}
          testID={`${testIDBase}-remind-${option.preset}`}
        />
      ))}
      <MenuSeparator />
      <MenuItem
        leading={CUSTOM_ICON}
        onSelect={handleCustom}
        testID={`${testIDBase}-remind-custom`}
      >
        {t("reminders.menu.custom")}
      </MenuItem>
      {reminder ? (
        <>
          <MenuSeparator />
          <MenuLabel testID={`${testIDBase}-remind-pending`}>
            {t("reminders.menu.pending", { when: formatWhen(new Date(reminder.remindAt)) })}
          </MenuLabel>
          <MenuItem
            leading={CANCEL_ICON}
            destructive
            onSelect={handleCancel}
            testID={`${testIDBase}-remind-cancel`}
          >
            {t("reminders.menu.cancel")}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function PresetRow({
  at,
  label,
  hint,
  onChoose,
  testID,
}: {
  at: Date;
  label: string;
  hint: string;
  onChoose: (at: Date) => void;
  testID: string;
}) {
  const handleSelect = useCallback(() => onChoose(at), [at, onChoose]);
  const trailing = useMemo(() => <Text style={styles.hint}>{hint}</Text>, [hint]);
  return (
    <MenuItem onSelect={handleSelect} trailing={trailing} testID={testID}>
      {label}
    </MenuItem>
  );
}

export interface AgentReminderMenu {
  /** The "Remind me ›" row; null when the host predates reminders. */
  trigger: ReactElement | null;
  /** Pass to the menu surface's `pages`. */
  pages: MenuPageDefinition[];
}

/**
 * "Remind me" for an agent's context menu: a submenu of Slack-style presets,
 * Custom…, and Cancel reminder when one is pending. Works in any menu surface.
 */
export function useAgentReminderMenu(input: {
  serverId: string;
  agentId: string;
  testIDBase: string;
}): AgentReminderMenu {
  const { serverId, agentId, testIDBase } = input;
  const reminder = useAgentReminder(serverId, agentId);
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "agentReminders");
  const formatWhen = useFormatReminderTime();

  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      supported
        ? [
            {
              id: REMINDER_PAGE_ID,
              title: t("reminders.menu.remindMe"),
              content: (
                <ReminderPage
                  serverId={serverId}
                  agentId={agentId}
                  reminder={reminder}
                  testIDBase={testIDBase}
                />
              ),
            },
          ]
        : [],
    [agentId, reminder, serverId, supported, t, testIDBase],
  );

  const trigger = supported ? (
    <MenuSubTrigger
      id={REMINDER_PAGE_ID}
      leading={ALARM_ICON}
      value={reminder ? formatWhen(new Date(reminder.remindAt)) : undefined}
      indicator={reminder !== null}
      testID={`${testIDBase}-remind-me`}
    >
      {t("reminders.menu.remindMe")}
    </MenuSubTrigger>
  ) : null;

  return { trigger, pages };
}

const styles = StyleSheet.create((theme) => ({
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
