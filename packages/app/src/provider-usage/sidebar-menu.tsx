import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { providerUsageCopy } from "./copy";
import { ProviderUsageList } from "./list";
import {
  cleanProviderUsageDisplayName,
  groupProviderUsage,
  mergeProviderUsageReports,
  type HostProviderUsageReport,
  type ProviderUsageGroup,
} from "./sidebar-menu-data";
import { useProviderUsage } from "./use-provider-usage";

const ThemedGauge = withUnistyles(Gauge);
const foregroundMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface HostStatusSummary {
  loading: number;
  refreshing: number;
  failed: number;
}

function summarizeHostStatus(
  serverIds: readonly string[],
  reports: ReadonlyMap<string, HostProviderUsageReport>,
): HostStatusSummary {
  let loading = 0;
  let refreshing = 0;
  let failed = 0;

  for (const serverId of serverIds) {
    const report = reports.get(serverId);
    const view = report?.view;
    if (!view || view.kind === "loading") loading += 1;
    else if (view.kind === "error") failed += 1;
    else {
      if (report.enabledProviderIds === null) loading += 1;
      if (view.isRefreshing) refreshing += 1;
    }
  }

  return { loading, refreshing, failed };
}

function hostStatusText({ loading, refreshing, failed }: HostStatusSummary): string | null {
  const parts: string[] = [];
  if (loading > 0) parts.push(`${loading} ${loading === 1 ? "host" : "hosts"} still loading`);
  if (refreshing > 0) parts.push(`${refreshing} ${refreshing === 1 ? "host" : "hosts"} refreshing`);
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "host" : "hosts"} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function HostProviderUsageCollector({
  serverId,
  menuOpen,
  onReport,
}: {
  serverId: string;
  menuOpen: boolean;
  onReport: (report: HostProviderUsageReport) => void;
}) {
  const { view, refresh } = useProviderUsage(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const enabledProviderIds = useMemo(
    () => entries?.filter((entry) => entry.enabled).map((entry) => entry.provider) ?? null,
    [entries],
  );

  useEffect(() => {
    onReport({ serverId, view, enabledProviderIds });
  }, [enabledProviderIds, onReport, serverId, view]);

  // Cached usage renders immediately; opening the panel only asks for fresher numbers.
  useEffect(() => {
    if (menuOpen) void refresh().catch(() => {});
  }, [menuOpen, refresh]);

  return null;
}

const CHIP_SELECTED_STATE = { selected: true } as const;
const CHIP_UNSELECTED_STATE = { selected: false } as const;

function ProviderGroupChip({
  group,
  selected,
  onSelect,
}: {
  group: ProviderUsageGroup;
  selected: boolean;
  onSelect: (groupId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(group.id), [group.id, onSelect]);
  const chipStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.chip,
      (selected || hovered || pressed) && styles.chipActive,
    ],
    [selected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected ? CHIP_SELECTED_STATE : CHIP_UNSELECTED_STATE}
      accessibilityLabel={group.label}
      testID={`sidebar-provider-usage-chip-${group.id}`}
      onPress={handlePress}
      style={chipStyle}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelActive]} numberOfLines={1}>
        {group.label}
      </Text>
    </Pressable>
  );
}

function ProviderGroupChips({
  groups,
  selectedGroupId,
  onSelect,
}: {
  groups: ProviderUsageGroup[];
  selectedGroupId: string;
  onSelect: (groupId: string) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {groups.map((group) => (
        <ProviderGroupChip
          key={group.id}
          group={group}
          selected={group.id === selectedGroupId}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function SelectedGroupCards({
  group,
  isCompact,
}: {
  group: ProviderUsageGroup;
  isCompact: boolean;
}) {
  const list = (
    <ProviderUsageList providers={group.providers} titleForUsage={cleanProviderUsageDisplayName} />
  );
  if (isCompact) return list;
  return (
    <ScrollView
      style={styles.listScroll}
      contentContainerStyle={styles.listScrollContent}
      showsVerticalScrollIndicator
    >
      {list}
    </ScrollView>
  );
}

export function SidebarProviderUsageMenu() {
  const hosts = useHosts();
  const isCompact = useIsCompactFormFactor();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [reports, setReports] = useState<ReadonlyMap<string, HostProviderUsageReport>>(
    () => new Map(),
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const handleReport = useCallback((report: HostProviderUsageReport) => {
    setReports((current) => {
      const previous = current.get(report.serverId);
      if (
        previous?.view === report.view &&
        previous.enabledProviderIds === report.enabledProviderIds
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(report.serverId, report);
      return next;
    });
  }, []);

  const readyReports = useMemo(
    () =>
      serverIds.flatMap((serverId) => {
        const report = reports.get(serverId);
        return report ? [report] : [];
      }),
    [reports, serverIds],
  );
  const mergedProviders = useMemo(() => mergeProviderUsageReports(readyReports), [readyReports]);
  const groups = useMemo(() => groupProviderUsage(mergedProviders), [mergedProviders]);
  const status = useMemo(() => summarizeHostStatus(serverIds, reports), [reports, serverIds]);
  const statusText = hostStatusText(status);

  useEffect(() => {
    if (!open) return;
    setSelectedGroupId((current) =>
      current && groups.some((group) => group.id === current) ? current : (groups[0]?.id ?? null),
    );
  }, [groups, open]);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;

  const handleMenuOpenChange = useCallback((nextOpen: boolean) => {
    openRef.current = nextOpen;
    setOpen(nextOpen);
    if (nextOpen) setTooltipOpen(false);
    else setSelectedGroupId(null);
  }, []);

  const handleTooltipOpenChange = useCallback((nextOpen: boolean) => {
    // A delayed hover callback can arrive after the menu click. The ref gates that stale callback,
    // so the tooltip can never remount over a click-open menu.
    setTooltipOpen(nextOpen && !openRef.current);
  }, []);

  let emptyState: string | null = null;
  if (hosts.length === 0) emptyState = providerUsageCopy.hostUnavailable;
  else if (!selectedGroup && status.loading > 0) emptyState = providerUsageCopy.loading;
  else if (!selectedGroup && status.failed > 0) emptyState = providerUsageCopy.errorTitle;
  else if (!selectedGroup) emptyState = providerUsageCopy.empty;

  return (
    <DropdownMenu open={open} onOpenChange={handleMenuOpenChange} compactMode="sheet">
      {hosts.map((host) => (
        <HostProviderUsageCollector
          key={host.serverId}
          serverId={host.serverId}
          menuOpen={open}
          onReport={handleReport}
        />
      ))}

      <Tooltip
        open={tooltipOpen && !open}
        onOpenChange={handleTooltipOpenChange}
        delayDuration={300}
        enabledOnDesktop={!open}
      >
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={styles.trigger}
              testID="sidebar-provider-usage"
              nativeID="sidebar-provider-usage"
              accessibilityRole="button"
              accessibilityLabel={providerUsageCopy.title}
            >
              {({ hovered, open: triggerOpen }) => (
                <ThemedGauge
                  size={ICON_SIZE.md}
                  uniProps={hovered || triggerOpen ? foregroundMapping : mutedMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{providerUsageCopy.title}</Text>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        side="top"
        align="end"
        offset={8}
        width={360}
        sheetTitle={providerUsageCopy.title}
        testID="sidebar-provider-usage-menu"
      >
        <View style={[styles.content, !isCompact && styles.popoverContent]}>
          <View style={styles.header}>
            {!isCompact ? <Text style={styles.title}>{providerUsageCopy.title}</Text> : null}
            {selectedGroup ? (
              <ProviderGroupChips
                groups={groups}
                selectedGroupId={selectedGroup.id}
                onSelect={setSelectedGroupId}
              />
            ) : null}
            {statusText ? <Text style={styles.hostStatus}>{statusText}</Text> : null}
          </View>
          {selectedGroup ? (
            <SelectedGroupCards group={selectedGroup} isCompact={isCompact} />
          ) : (
            <Text style={styles.stateText}>{emptyState}</Text>
          )}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  content: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  popoverContent: {
    height: 480,
  },
  header: {
    flexShrink: 0,
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  listScroll: {
    flex: 1,
  },
  listScrollContent: {
    paddingBottom: theme.spacing[1],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  chipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  chipLabelActive: {
    color: theme.colors.foreground,
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  hostStatus: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
