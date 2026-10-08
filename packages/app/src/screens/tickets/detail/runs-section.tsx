import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUpRight } from "lucide-react-native";
import type { TicketRun } from "@getpaseo/protocol/tickets/types";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import { RunChip } from "@/screens/tickets/components/run-chip";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { DetailSection, SectionEmpty, SectionHeader } from "./section";

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const OPEN_ICON = <ThemedArrowUpRight size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;

/** The agents linked to this ticket, newest first. Pressing one opens it. */
export function RunsSection({ runs }: { runs: readonly TicketRun[] }): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const hostLabelById = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label?.trim() || host.serverId])),
    [hosts],
  );
  const ordered = useMemo(
    () => [...runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [runs],
  );

  return (
    <DetailSection testID="ticket-detail-runs">
      <SectionHeader
        title={t("tickets.detail.runs.title")}
        tally={runs.length > 0 ? String(runs.length) : undefined}
      />
      {ordered.length === 0 ? (
        <SectionEmpty>{t("tickets.detail.runs.empty")}</SectionEmpty>
      ) : (
        ordered.map((run) => (
          <RunRow
            key={`${run.serverId}:${run.agentId}`}
            run={run}
            hostLabel={hostLabelById.get(run.serverId) ?? run.serverId}
          />
        ))
      )}
    </DetailSection>
  );
}

function RunRow({ run, hostLabel }: { run: TicketRun; hostLabel: string }): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleOpen = useCallback(() => {
    const session = useSessionStore.getState().sessions[run.serverId];
    const agent = session?.agents.get(run.agentId) ?? session?.agentDetails.get(run.agentId);
    void openAgentFromHistory({
      serverId: run.serverId,
      agentId: run.agentId,
      workspaceId: agent?.workspaceId ?? null,
      archived: run.archived,
    });
  }, [run.agentId, run.archived, run.serverId]);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );
  const metaParts = [hostLabel, formatTimeAgo(new Date(run.updatedAt))];
  if (run.archived) {
    metaParts.push(t("tickets.detail.runs.archived"));
  }
  const showOpenIcon = isHovered || isCompact || isNative;

  return (
    <View
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={handleOpen}
        accessibilityRole="link"
        accessibilityLabel={t("tickets.detail.runs.open", {
          agent: run.agentName ?? run.agentTitle ?? run.agentId,
        })}
        testID={`ticket-run-${run.agentId}`}
      >
        <RunChip run={run} />
        <View style={styles.text}>
          {run.agentTitle ? (
            <Text style={styles.title} numberOfLines={1}>
              {run.agentTitle}
            </Text>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {metaParts.join(" · ")}
          </Text>
        </View>
        <View style={showOpenIcon ? styles.openSlot : styles.openSlotHidden}>{OPEN_ICON}</View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
  },
  row: {
    minHeight: CONTROL_HEIGHTS.field,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  openSlot: {
    opacity: 1,
  },
  openSlotHidden: {
    opacity: 0,
  },
}));
