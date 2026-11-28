import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  formatDisplayPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatResetTime,
  formatRunsOutLabel,
} from "./format";
import { UsageMeter } from "./meter";
import { displayPercent } from "./model";
import { usagePace } from "./pace";
import { UsageDatapointLine } from "./datapoint-line";
import type { UsageDisplayAs } from "./preferences";
import { windowTone } from "./tone";
import type { UsageTone, UsageWindow } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

export function UsageWindowBar({
  window,
  displayAs,
  retained = false,
  forecastAt,
}: {
  retained?: boolean;
  forecastAt: string | null;
  window: UsageWindow;
  displayAs: UsageDisplayAs;
}) {
  const { t, i18n } = useTranslation();
  const shownPct = displayPercent(window, displayAs);
  const now = useRelativeTimeTick({ enabled: window.runsOutAt != null || window.resetsAt != null });
  const pace = usagePace(window, forecastAt, now);
  const forecast = formatPace(pace, now, t);
  const countdown = formatResetLabel(window.resetsAt, retained, now, t);
  const exactTime = formatResetTime(window.resetsAt, now, t);

  const value =
    shownPct != null ? formatDisplayPct(shownPct, displayAs, i18n.resolvedLanguage, t) : "—";
  const datapoints = [countdown, exactTime, forecast?.label ?? null];
  return (
    <View style={styles.row}>
      <WindowRowContent
        label={formatProviderUsageLabel(window.id, window.label, t)}
        value={value}
        datapoints={datapoints}
        percent={shownPct ?? 0}
        tone={forecast?.tone ?? windowTone(window)}
      />
    </View>
  );
}

function WindowRowContent({
  label,
  value,
  datapoints,
  percent,
  tone,
}: {
  label: string;
  value: string;
  datapoints: readonly (string | null)[];
  percent: number;
  tone: UsageTone;
}) {
  return (
    <>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <UsageMeter percent={percent} tone={tone} />
      <UsageDatapointLine datapoints={datapoints} />
    </>
  );
}

interface PaceDisplay {
  label: string | null;
  tone: UsageTone;
}

function formatPace(
  pace: ReturnType<typeof usagePace>,
  now: number,
  t: TFunction,
): PaceDisplay | null {
  switch (pace.kind) {
    case "reached":
      return { label: t("providerUsage.timing.limitReached"), tone: "danger" };
    case "runsOut": {
      const label =
        Date.parse(pace.at) <= now
          ? t("providerUsage.timing.mayHaveRunOut")
          : formatRunsOutLabel(pace.at, now, t);
      return label ? { label, tone: "danger" } : null;
    }
    case "tight":
      return { label: null, tone: "warning" };
    case "onTrack":
      return { label: null, tone: "default" };
    case "unknown":
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: 3, paddingVertical: theme.spacing[1.5] },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  value: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
