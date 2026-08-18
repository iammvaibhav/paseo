import type { ProviderUsage, ProviderUsageView } from "./types";

export interface HostProviderUsageReport {
  serverId: string;
  view: ProviderUsageView;
  /** Null until this host's provider snapshot has loaded. */
  enabledProviderIds: readonly string[] | null;
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

function effectiveGroupId(usage: ProviderUsage): string {
  return usage.groupId ?? usage.providerId.split(/[:/#]/, 1)[0] ?? usage.providerId;
}

function emailSuffix(displayName: string): string | null {
  return displayName.match(/\s+—\s+([^\s@]+@[^\s@]+)\s*$/u)?.[1] ?? null;
}

function effectiveAccountEmail(usage: ProviderUsage): string | null {
  if (usage.accountEmail != null) return usage.accountEmail;
  const separatorIndex = usage.providerId.indexOf(":");
  if (separatorIndex >= 0) return usage.providerId.slice(separatorIndex + 1);
  return emailSuffix(usage.displayName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanDisplayName(displayName: string, accountEmail: string | null): string {
  let label = displayName.trim().replace(/^OMP\s*·\s*/iu, "");
  if (accountEmail) {
    label = label.replace(new RegExp(`\\s+—\\s+${escapeRegExp(accountEmail)}\\s*$`, "iu"), "");
  }
  return label.replace(/\s+—\s+[^\s@]+@[^\s@]+\s*$/u, "").trim();
}

interface NormalizedProviderUsage {
  usage: ProviderUsage;
  nativeMetadataCount: number;
}

function normalizeProviderUsage(usage: ProviderUsage): NormalizedProviderUsage {
  const groupId = effectiveGroupId(usage);
  const accountEmail = effectiveAccountEmail(usage);
  const displayName =
    cleanDisplayName(usage.displayName, accountEmail) || usage.displayName.trim() || groupId;

  return {
    usage: { ...usage, groupId, accountEmail: accountEmail ?? undefined, displayName },
    nativeMetadataCount: Number(usage.groupId != null) + Number(usage.accountEmail != null),
  };
}

function isBackedByEnabledProvider(
  usage: ProviderUsage,
  enabledProviderIds: ReadonlySet<string>,
): boolean {
  const groupId = effectiveGroupId(usage);
  if (groupId === "omp" || groupId.startsWith("omp-")) {
    return enabledProviderIds.has("omp");
  }
  return enabledProviderIds.has(usage.providerId);
}

/**
 * One account can be visible through more than one host. Keep the freshest copy so the footer
 * presents one account list instead of leaking host topology into the UI.
 */
export function mergeProviderUsageReports(
  reports: readonly HostProviderUsageReport[],
): ProviderUsage[] {
  const merged = new Map<
    string,
    { usage: ProviderUsage; fetchedAt: string; nativeMetadataCount: number }
  >();

  for (const report of reports) {
    if (report.view.kind !== "ready" || report.enabledProviderIds === null) continue;
    const enabledProviderIds = new Set(report.enabledProviderIds);

    for (const sourceUsage of report.view.payload.providers) {
      const normalized = normalizeProviderUsage(sourceUsage);
      const { usage } = normalized;
      if (!isBackedByEnabledProvider(usage, enabledProviderIds)) continue;

      const key = `${usage.groupId}::${usage.accountEmail ?? ""}`;
      const fetchedAt = effectiveFetchedAt(sourceUsage, report.view.payload.fetchedAt);
      const current = merged.get(key);
      if (current) {
        if (current.nativeMetadataCount > normalized.nativeMetadataCount) continue;
        if (
          current.nativeMetadataCount === normalized.nativeMetadataCount &&
          fetchedAtMillis(current.fetchedAt) >= fetchedAtMillis(fetchedAt)
        ) {
          continue;
        }
      }

      merged.set(key, {
        usage: usage.fetchedAt ? usage : { ...usage, fetchedAt },
        fetchedAt,
        nativeMetadataCount: normalized.nativeMetadataCount,
      });
    }
  }

  // Old daemons omit the account email on single-account cards. When another host
  // identifies accounts in the same group by email, the email-less card is the same
  // subscription seen through an old daemon — drop it instead of showing a duplicate.
  const groupsWithEmail = new Set<string>();
  for (const { usage } of merged.values()) {
    if (usage.accountEmail) groupsWithEmail.add(usage.groupId ?? usage.providerId);
  }
  return Array.from(merged.values(), ({ usage }) => usage).filter(
    (usage) => usage.accountEmail || !groupsWithEmail.has(usage.groupId ?? usage.providerId),
  );
}

/**
 * OMP account adapters sometimes include both their namespace and the account email in the
 * display name. Both are redundant in this surface: the namespace is not a provider label, and
 * the email has its own secondary line on each card.
 */
export function cleanProviderUsageDisplayName(usage: ProviderUsage): string {
  const label = cleanDisplayName(usage.displayName, effectiveAccountEmail(usage));
  return label || usage.displayName.trim() || effectiveGroupId(usage);
}

export function groupProviderUsage(providers: readonly ProviderUsage[]): ProviderUsageGroup[] {
  const groups = new Map<string, ProviderUsage[]>();

  for (const usage of providers) {
    const id = effectiveGroupId(usage);
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
