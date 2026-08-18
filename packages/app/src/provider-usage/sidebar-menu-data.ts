import type { ProviderUsage, ProviderUsageView } from "./types";

export interface HostProviderUsageReport {
  serverId: string;
  view: ProviderUsageView;
}

export interface ProviderUsageGroup {
  id: string;
  label: string;
  providers: ProviderUsage[];
}

function effectiveFetchedAt(usage: ProviderUsage, listFetchedAt: string): string {
  return usage.fetchedAt ?? listFetchedAt;
}

function fetchedAtMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? Number.NEGATIVE_INFINITY : millis;
}

/**
 * One account can be visible through more than one host. Keep the freshest copy so the footer
 * presents one account list instead of leaking host topology into the UI.
 */
export function mergeProviderUsageReports(
  reports: readonly HostProviderUsageReport[],
): ProviderUsage[] {
  const merged = new Map<string, { usage: ProviderUsage; fetchedAt: string }>();

  for (const report of reports) {
    if (report.view.kind !== "ready") continue;

    for (const usage of report.view.payload.providers) {
      const key = `${usage.groupId ?? usage.providerId}::${usage.accountEmail ?? ""}`;
      const fetchedAt = effectiveFetchedAt(usage, report.view.payload.fetchedAt);
      const current = merged.get(key);
      if (current && fetchedAtMillis(current.fetchedAt) >= fetchedAtMillis(fetchedAt)) continue;

      merged.set(key, {
        usage: usage.fetchedAt ? usage : { ...usage, fetchedAt },
        fetchedAt,
      });
    }
  }

  return Array.from(merged.values(), ({ usage }) => usage);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * OMP account adapters sometimes include both their namespace and the account email in the
 * display name. Both are redundant in this surface: the namespace is not a provider label, and
 * the email has its own secondary line on each card.
 */
export function cleanProviderUsageDisplayName(usage: ProviderUsage): string {
  let label = usage.displayName.trim().replace(/^OMP\s*·\s*/iu, "");
  const email = usage.accountEmail?.trim();

  if (email) {
    label = label.replace(new RegExp(`\\s+—\\s+${escapeRegExp(email)}\\s*$`, "iu"), "");
  }
  label = label.replace(/\s+—\s+[^\s@]+@[^\s@]+\s*$/u, "").trim();

  return label || usage.displayName.trim() || usage.groupId || usage.providerId;
}

export function groupProviderUsage(providers: readonly ProviderUsage[]): ProviderUsageGroup[] {
  const groups = new Map<string, ProviderUsage[]>();

  for (const usage of providers) {
    const id = usage.groupId ?? usage.providerId;
    const group = groups.get(id);
    if (group) group.push(usage);
    else groups.set(id, [usage]);
  }

  return Array.from(groups, ([id, groupProviders]) => {
    const providersByAccount = [...groupProviders].sort((left, right) =>
      (left.accountEmail ?? "").localeCompare(right.accountEmail ?? ""),
    );
    const label =
      providersByAccount
        .map(cleanProviderUsageDisplayName)
        .sort((left, right) => left.localeCompare(right))[0] ?? id;
    return { id, label, providers: providersByAccount };
  }).sort(
    (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
  );
}
