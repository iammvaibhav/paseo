import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { zonedDateTimeToInstant } from "@getpaseo/protocol/agent-reminders";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useToast } from "@/contexts/toast-context";
import {
  setAgentReminder,
  useCustomReminderStore,
  type CustomReminderTarget,
} from "@/agent-reminders/actions";
import { useFormatReminderTime } from "@/agent-reminders/reminder-menu";
import {
  buildReminderDayOptions,
  buildReminderTimeOptions,
  defaultCustomReminderStart,
  deviceTimeZone,
  type ReminderDayOption,
  type ReminderTimeOption,
} from "@/agent-reminders/reminder-time";

/** How far ahead the day picker reaches. */
const DAY_OPTION_COUNT = 90;
/** SelectField identity for day and time options. */
const optionKey = (option: { key: string }) => option.key;

/** Mounted once at the app root; opened by a "Remind me → Custom…" menu row. */
export function CustomReminderHost() {
  const target = useCustomReminderStore((state) => state.target);
  const close = useCustomReminderStore((state) => state.close);
  if (!target) return null;
  // Keyed so each open starts from a fresh draft.
  return (
    <CustomReminderSheet
      key={`${target.serverId}:${target.agentId}`}
      target={target}
      onClose={close}
    />
  );
}

function CustomReminderSheet({
  target,
  onClose,
}: {
  target: CustomReminderTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const formatWhen = useFormatReminderTime();
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const [now] = useState(() => new Date());
  const dayOptions = useMemo(
    () => buildReminderDayOptions(now, timeZone, DAY_OPTION_COUNT),
    [now, timeZone],
  );
  const timeOptions = useMemo(() => buildReminderTimeOptions(), []);
  const start = useMemo(() => defaultCustomReminderStart(now, timeZone), [now, timeZone]);
  const [day, setDay] = useState<ReminderDayOption | null>(dayOptions[start.dayOffset] ?? null);
  const [time, setTime] = useState<ReminderTimeOption | null>(
    timeOptions.find((option) => option.key === start.timeKey) ?? null,
  );
  const [note, setNote] = useState(target.note ?? "");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const daySelectOptions = useMemo<SelectFieldOption<ReminderDayOption>[]>(
    () =>
      dayOptions.map((option) => ({
        id: option.key,
        value: option,
        label: option.label,
        testID: `custom-reminder-day-${option.key}`,
      })),
    [dayOptions],
  );
  const timeSelectOptions = useMemo<SelectFieldOption<ReminderTimeOption>[]>(
    () =>
      timeOptions.map((option) => ({
        id: option.key,
        value: option,
        label: option.label,
        testID: `custom-reminder-time-${option.key}`,
      })),
    [timeOptions],
  );

  const remindAt =
    day && time
      ? zonedDateTimeToInstant(
          { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
          timeZone,
        )
      : null;

  const handleSubmit = useCallback(async () => {
    if (!remindAt || isPending) return;
    if (remindAt.getTime() <= Date.now()) {
      setError(t("reminders.custom.pastError"));
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      const reminder = await setAgentReminder({
        serverId: target.serverId,
        agentId: target.agentId,
        remindAt,
        note,
      });
      toast.show(t("reminders.toast.set", { when: formatWhen(new Date(reminder.remindAt)) }));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsPending(false);
    }
  }, [formatWhen, isPending, note, onClose, remindAt, t, target, toast]);

  const header = useMemo<SheetHeader>(() => ({ title: t("reminders.custom.title") }), [t]);
  const dayDisplay = useMemo(() => (day ? { label: day.label } : null), [day]);
  const timeDisplay = useMemo(() => (time ? { label: time.label } : null), [time]);
  const handleSubmitPress = useCallback(() => void handleSubmit(), [handleSubmit]);

  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="custom-reminder-sheet">
      <View style={styles.body}>
        <View style={styles.row}>
          <View style={styles.cell}>
            <SelectField
              label={t("reminders.custom.day")}
              value={day}
              selectedDisplay={dayDisplay}
              options={daySelectOptions}
              onChange={setDay}
              getValueKey={optionKey}
              placeholder={t("reminders.custom.dayPlaceholder")}
              emptyText={t("reminders.custom.noMatches")}
              searchable
              title={t("reminders.custom.day")}
              disabled={isPending}
              triggerTestID="custom-reminder-day-trigger"
            />
          </View>
          <View style={styles.cell}>
            <SelectField
              label={t("reminders.custom.time")}
              value={time}
              selectedDisplay={timeDisplay}
              options={timeSelectOptions}
              onChange={setTime}
              getValueKey={optionKey}
              placeholder={t("reminders.custom.timePlaceholder")}
              emptyText={t("reminders.custom.noMatches")}
              searchable
              title={t("reminders.custom.time")}
              disabled={isPending}
              triggerTestID="custom-reminder-time-trigger"
            />
          </View>
        </View>
        {remindAt ? <Text style={styles.summary}>{formatWhen(remindAt)}</Text> : null}
        <Field label={t("reminders.custom.note")}>
          <AdaptiveTextInput
            initialValue={target.note ?? ""}
            onChangeText={setNote}
            placeholder={t("reminders.custom.notePlaceholder")}
            editable={!isPending}
            maxLength={2000}
            style={styles.input}
            testID="custom-reminder-note"
          />
        </Field>
        {error ? (
          <Text style={styles.errorText} testID="custom-reminder-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={onClose}
            disabled={isPending}
            testID="custom-reminder-cancel"
          >
            {t("reminders.custom.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSubmitPress}
            disabled={isPending || remindAt === null}
            testID="custom-reminder-submit"
          >
            {t("reminders.custom.submit")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  cell: {
    flex: 1,
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
