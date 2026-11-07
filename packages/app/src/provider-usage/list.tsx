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

function groupProviders(
  providers: ProviderUsage[],
): { usage: ProviderUsage; group: ProviderUsage[] }[] {
  const groups = new Map<string, ProviderUsage[]>();
  for (const usage of providers) {
    const key = providerGroupKey(usage);
    const group = groups.get(key);
    if (group) group.push(usage);
    else groups.set(key, [usage]);
  }
  const result: { usage: ProviderUsage; group: ProviderUsage[] }[] = [];
  for (const group of groups.values()) {
    for (const usage of group) {
      result.push({ usage, group });
    }
  }
  return result;
}

export function ProviderUsageList({
  providers,
  listFetchedAt,
  titleForUsage,
}: {
  providers: ProviderUsage[];
  listFetchedAt?: string | null;
  titleForUsage?: (usage: ProviderUsage) => string;
}) {
  const groupedProviders = groupProviders(providers);
  return (
    <View style={settingsStyles.card}>
      {groupedProviders.map(({ usage, group }, index) => (
        <Fragment key={`${usage.providerId}:${usage.accountEmail ?? ""}`}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <ProviderUsageCard
            usage={usage}
            active={usage.active === true && group.length > 1}
            listFetchedAt={listFetchedAt}
            title={titleForUsage?.(usage)}
          />
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
