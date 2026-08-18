import { Fragment } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { ProviderUsageCard } from "./card";
import type { ProviderUsage } from "./types";

function providerGroupKey(usage: ProviderUsage): string {
  const explicitGroup = usage.groupId?.trim();
  if (explicitGroup) return explicitGroup;
  return usage.providerId.split(/[:/#]/, 1)[0] ?? usage.providerId;
}

function groupProviders(providers: ProviderUsage[]): ProviderUsage[] {
  const groups = new Map<string, ProviderUsage[]>();
  for (const usage of providers) {
    const key = providerGroupKey(usage);
    const group = groups.get(key);
    if (group) group.push(usage);
    else groups.set(key, [usage]);
  }
  return Array.from(groups.values()).flat();
}

export function ProviderUsageList({
  providers,
  listFetchedAt,
}: {
  providers: ProviderUsage[];
  listFetchedAt?: string | null;
}) {
  const groupedProviders = groupProviders(providers);
  return (
    <View style={settingsStyles.card}>
      {groupedProviders.map((usage, index) => (
        <Fragment key={`${usage.providerId}:${usage.accountEmail ?? ""}`}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <ProviderUsageCard usage={usage} listFetchedAt={listFetchedAt} />
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
