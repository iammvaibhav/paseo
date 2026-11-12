import React from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { StatusBadge } from "@/components/ui/status-badge";

interface StatusReport {
  status: string;
  headline: string;
  description?: string;
  kind?: string;
}

function readText(record: object, key: string): string | undefined {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStatusReport(detail: ToolCallDetail): StatusReport | null {
  if (detail.type !== "unknown" || !detail.input || typeof detail.input !== "object") {
    return null;
  }
  const headline = readText(detail.input, "headline");
  if (!headline) {
    return null;
  }
  return {
    status: readText(detail.input, "status") ?? "working",
    headline,
    description: readText(detail.input, "description"),
    kind: readText(detail.input, "kind"),
  };
}

/**
 * An agent's `report_status`: the headline beside a status dot, the report kind as a
 * quiet tag, and the description below. It reads as a card in the transcript, not as a
 * tool step, because it is what the agent says about its own progress.
 */
export function StatusReportCard({ detail }: { detail: ToolCallDetail }) {
  const report = readStatusReport(detail);
  if (!report) {
    return null;
  }
  return (
    <View style={styles.spacing} testID="status-report-card">
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={[styles.dot, dotStyle(report.status)]} />
          <Text style={styles.headline} numberOfLines={1}>
            {report.headline}
          </Text>
          {report.kind ? <StatusBadge label={report.kind} size="xs" /> : null}
          <Text style={styles.status}>{report.status}</Text>
        </View>
        {report.description ? <Text style={styles.description}>{report.description}</Text> : null}
      </View>
    </View>
  );
}

const DOT_SIZE = 7;

const styles = StyleSheet.create((theme) => ({
  spacing: {
    paddingVertical: theme.spacing[1],
  },
  card: {
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotWorking: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  dotDone: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  dotBlocked: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  dotFailed: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  headline: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  status: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  description: {
    // Hang the description on the headline's rail, past the dot and its gap.
    paddingLeft: DOT_SIZE + theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
}));

// report_status statuses: working | completed | inconclusive | blocked. Read at render
// time, never cached at module scope (docs/unistyles.md).
function dotStyle(status: string) {
  switch (status) {
    case "completed":
      return styles.dotDone;
    case "inconclusive":
    case "blocked":
      return styles.dotBlocked;
    case "failed":
      return styles.dotFailed;
    default:
      return styles.dotWorking;
  }
}
