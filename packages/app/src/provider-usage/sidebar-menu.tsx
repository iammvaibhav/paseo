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
import type { ProviderUsageView } from "./types";
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
  reports: ReadonlyMap<string, ProviderUsageView>,
): HostStatusSummary {
  let loading = 0;
  let refreshing = 0;
  let failed = 0;

  for (const serverId of serverIds) {
    const view = reports.get(serverId);
    if (!view || view.kind === "loading") loading += 1;
    else if (view.kind === "error") failed += 1;
    else if (view.isRefreshing) refreshing += 1;
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

  useEffect(() => {
    onReport({ serverId, view });
  }, [onReport, serverId, view]);

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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroller}
      contentContainerStyle={styles.chipRow}
    >
      {groups.map((group) => (
        <ProviderGroupChip
          key={group.id}
          group={group}
          selected={group.id === selectedGroupId}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

export function SidebarProviderUsageMenu() {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [reports, setReports] = useState<ReadonlyMap<string, ProviderUsageView>>(() => new Map());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const handleReport = useCallback((report: HostProviderUsageReport) => {
    setReports((current) => {
      if (current.get(report.serverId) === report.view) return current;
      const next = new Map(current);
      next.set(report.serverId, report.view);
      return next;
    });
  }, []);

  const readyReports = useMemo(
    () =>
      serverIds.flatMap((serverId) => {
        const view = reports.get(serverId);
        return view ? [{ serverId, view }] : [];
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
        maxHeight={560}
        scrollable
        sheetTitle={providerUsageCopy.title}
        testID="sidebar-provider-usage-menu"
      >
        <View style={styles.content}>
          {selectedGroup ? (
            <>
              <ProviderGroupChips
                groups={groups}
                selectedGroupId={selectedGroup.id}
                onSelect={setSelectedGroupId}
              />
              <ProviderUsageList
                providers={selectedGroup.providers}
                titleForUsage={cleanProviderUsageDisplayName}
              />
            </>
          ) : (
            <Text style={styles.stateText}>{emptyState}</Text>
          )}
          {statusText ? <Text style={styles.hostStatus}>{statusText}</Text> : null}
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
  chipScroller: {
    flexGrow: 0,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
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
