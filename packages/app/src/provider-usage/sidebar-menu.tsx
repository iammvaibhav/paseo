import { useEffect, useState } from "react";
import { Text, View } from "react-native";
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
import type { ProviderUsageView } from "./types";
import { useProviderUsage } from "./use-provider-usage";

const ThemedGauge = withUnistyles(Gauge);
const foregroundMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function HostUsageBody({ view }: { view: ProviderUsageView }) {
  if (view.kind === "loading") {
    return <Text style={styles.stateText}>{providerUsageCopy.loading}</Text>;
  }
  if (view.kind === "error") {
    return <Text style={styles.stateText}>{view.message}</Text>;
  }
  if (view.payload.providers.length === 0) {
    return <Text style={styles.stateText}>{providerUsageCopy.empty}</Text>;
  }
  return (
    <ProviderUsageList providers={view.payload.providers} listFetchedAt={view.payload.fetchedAt} />
  );
}

function HostProviderUsage({
  serverId,
  heading,
  menuOpen,
}: {
  serverId: string;
  heading: string;
  menuOpen: boolean;
}) {
  const { view, refresh } = useProviderUsage(serverId);

  // Cached usage renders immediately; opening the panel only asks for fresher numbers.
  useEffect(() => {
    if (menuOpen) void refresh().catch(() => {});
  }, [menuOpen, refresh]);

  return (
    <View style={styles.hostSection}>
      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionTitle}>{heading}</Text>
        {view.kind === "ready" && view.isRefreshing ? (
          <Text style={styles.refreshing}>{providerUsageCopy.refreshing}</Text>
        ) : null}
      </View>
      <HostUsageBody view={view} />
    </View>
  );
}

export function SidebarProviderUsageMenu() {
  const hosts = useHosts();
  const [open, setOpen] = useState(false);
  const showHostLabels = hosts.length > 1;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} compactMode="sheet">
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
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
          {hosts.length > 0 ? (
            hosts.map((host) => (
              <HostProviderUsage
                key={host.serverId}
                serverId={host.serverId}
                heading={showHostLabels ? host.label : providerUsageCopy.title}
                menuOpen={open}
              />
            ))
          ) : (
            <Text style={styles.stateText}>{providerUsageCopy.hostUnavailable}</Text>
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
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  hostSection: {
    gap: theme.spacing[2],
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  refreshing: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
