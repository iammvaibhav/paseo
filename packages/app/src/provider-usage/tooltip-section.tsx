import { Fragment } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import { providerUsageCopy } from "./copy";
import { matchProviderUsage } from "./match-provider-usage";
import type { ProviderUsageView } from "./types";

export { matchProviderUsage } from "./match-provider-usage";

// Renders plan usage inside the context-meter tooltip: every account of the active
// model's provider group, or — when no provider can be resolved from the agent — every
// known account, so the popover is never empty just because the agent has not reported
// a model yet.
export function ProviderUsageTooltipSection({
  view,
  activeProviderId,
  activeModelId,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
  activeModelId?: string | null;
}) {
  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{providerUsageCopy.tooltipLoading}</Text>
      </>
    );
  }

  if (view.kind === "error") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.error}>{view.message}</Text>
      </>
    );
  }

  const matched = matchProviderUsage(view.payload.providers, activeProviderId, activeModelId);
  const providers = matched.length > 0 ? matched : view.payload.providers;

  return (
    <>
      <View style={styles.divider} />
      <View style={styles.headingRow}>
        <Text style={styles.heading}>{providerUsageCopy.title}</Text>
        {view.isRefreshing ? (
          <Text style={styles.refreshing}>{providerUsageCopy.refreshing}</Text>
        ) : null}
      </View>
      {providers.length > 0 ? (
        <View style={styles.list}>
          {providers.map((usage, index) => (
            // A provider group holds several subscriptions, so the provider id alone
            // is not unique across cards.
            <Fragment key={`${usage.providerId}:${usage.accountEmail ?? ""}`}>
              {index > 0 ? <View style={styles.cardDivider} /> : null}
              <ProviderUsageCard usage={usage} compact listFetchedAt={view.payload.fetchedAt} />
            </Fragment>
          ))}
        </View>
      ) : (
        <Text style={styles.detail}>{providerUsageCopy.empty}</Text>
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    // Same token the popover draws its own outline with, so the rule reads as the
    // popover's edge. `border` is invisible here (equals the popover background).
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    // Cancel the tooltip content's horizontal padding so the rule spans edge to edge.
    marginHorizontal: -theme.spacing[2],
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  refreshing: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  list: {
    gap: theme.spacing[3],
  },
  cardDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
