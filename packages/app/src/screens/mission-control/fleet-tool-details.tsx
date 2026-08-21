import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { MarkdownRenderer } from "@/components/markdown/renderer";

/**
 * Pretty collapsed bodies for the Commander's fleet dispatch tools (spec
 * "Tool rendering"). Hooked from tool-call-details.tsx via the presentation
 * registry: the protocol display model supplies the one-line badge
 * (tool-call-display.ts) and this component supplies the expandable body, so
 * known tools never dump raw JSON.
 *
 * Fleet calls arrive with `detail: { type: "unknown", input: args, output:
 * result }`; the omp host-tool result carries structuredContent under
 * `output.details`.
 */

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readToolInput(detail: ToolCallDetail | undefined): Record<string, unknown> | null {
  return detail?.type === "unknown" && typeof detail.input === "object" && detail.input !== null
    ? (detail.input as Record<string, unknown>)
    : null;
}

function readToolOutput(detail: ToolCallDetail | undefined): Record<string, unknown> | null {
  if (detail?.type !== "unknown") {
    return null;
  }
  const output = detail.output;
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const outputRecord = output as Record<string, unknown>;
  return typeof outputRecord.details === "object" && outputRecord.details !== null
    ? (outputRecord.details as Record<string, unknown>)
    : null;
}

function rowLabel(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "Agent";
  }
  const row = raw as Record<string, unknown>;
  return readString(row.name) ?? readString(row.title) ?? "Agent";
}

export function FleetToolCallDetailBody({
  toolName,
  detail,
  resolveHost,
}: {
  toolName: string;
  detail?: ToolCallDetail;
  resolveHost?: (host: string) => string;
}): ReactElement | null {
  const leaf = toolName.trim().toLowerCase().split(/[.:/]/).at(-1) ?? toolName;
  const body = useMemo(
    () => buildFleetBody(leaf, detail, resolveHost),
    [leaf, detail, resolveHost],
  );
  if (!body) {
    return null;
  }
  return <View style={styles.container}>{body}</View>;
}

function buildFleetBody(
  leaf: string,
  detail: ToolCallDetail | undefined,
  resolveHost?: (host: string) => string,
): ReactElement | null {
  const input = readToolInput(detail);
  const output = readToolOutput(detail);

  switch (leaf) {
    case "fleet_send_prompt": {
      const prompt = input ? readString(input.prompt) : undefined;
      if (!prompt) {
        return null;
      }
      return <MarkdownRenderer text={prompt} compact />;
    }
    case "fleet_list_agents": {
      const agents = output?.agents;
      if (!Array.isArray(agents) || agents.length === 0) {
        return null;
      }
      return (
        <View style={styles.roster}>
          {agents.map((raw) => {
            const rawHost =
              typeof raw === "object" && raw !== null && !Array.isArray(raw)
                ? readString((raw as Record<string, unknown>).host)
                : undefined;
            const host = rawHost ? (resolveHost?.(rawHost) ?? rawHost) : undefined;
            const status =
              typeof raw === "object" && raw !== null && !Array.isArray(raw)
                ? readString((raw as Record<string, unknown>).status)
                : undefined;
            const rosterKey = `${rowLabel(raw)}:${host ?? ""}:${status ?? ""}`;
            return (
              <View key={rosterKey} style={styles.rosterRow}>
                <View style={styles.agentChip}>
                  <Text style={styles.agentChipText} numberOfLines={1}>
                    {rowLabel(raw)}
                  </Text>
                </View>
                {host ? (
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {host}
                  </Text>
                ) : null}
                {status ? (
                  <Text style={styles.rowStatus} numberOfLines={1}>
                    {status}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      );
    }
    case "fleet_search": {
      const matches = output?.matches;
      if (!Array.isArray(matches) || matches.length === 0) {
        return null;
      }
      return (
        <View style={styles.matchList}>
          {matches.map((raw) => {
            const row =
              typeof raw === "object" && raw !== null && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : null;
            const rawHost = row ? readString(row.host) : undefined;
            const host = rawHost ? (resolveHost?.(rawHost) ?? rawHost) : undefined;
            const snippet = row ? readString(row.snippet) : undefined;
            const matchKey = `${rowLabel(raw)}:${host ?? ""}:${snippet ?? ""}`;
            return (
              <View key={matchKey} style={styles.matchRow}>
                <View style={styles.matchChipRow}>
                  <View style={styles.agentChip}>
                    <Text style={styles.agentChipText} numberOfLines={1}>
                      {rowLabel(raw)}
                    </Text>
                  </View>
                  {host ? (
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {host}
                    </Text>
                  ) : null}
                </View>
                {snippet ? (
                  <Text style={styles.matchSnippet} numberOfLines={2}>
                    {snippet}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      );
    }
    default:
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  roster: {
    gap: theme.spacing[1],
  },
  rosterRow: {
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
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  rowMeta: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowStatus: {
    marginLeft: "auto",
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  matchList: {
    gap: theme.spacing[2],
  },
  matchRow: {
    gap: theme.spacing[0.5],
  },
  matchChipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  matchSnippet: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
}));
