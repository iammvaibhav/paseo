import type { ProviderUsage, ProviderUsageView, ProviderUsageWindow } from "./types";

export interface HostProviderUsageReport {
  serverId: string;
  view: ProviderUsageView;
  /** Null until this host's provider snapshot has loaded. */
  enabledProviderIds: readonly string[] | null;
  /** Provider-snapshot fetch error, if the snapshot failed. */
  snapshotError: string | null;
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

function antigravityWindowOrder(label: string): number {
  const lower = label.toLowerCase();
  const isGemini = lower.includes("gemini");
  const is5h = lower.includes("five hour") || lower.includes("5h") || lower.includes("5 hour");
  const isWeekly = lower.includes("weekly") || lower.includes("week");

  if (isGemini && is5h) return 1;
  if (isGemini && isWeekly) return 2;
  if (!isGemini && is5h) return 3;
  if (!isGemini && isWeekly) return 4;
  return 99;
}

function sortAntigravityWindows(windows: readonly ProviderUsageWindow[]): ProviderUsageWindow[] {
  return [...windows].sort((a, b) => {
    return antigravityWindowOrder(a.label) - antigravityWindowOrder(b.label);
  });
}

function normalizeProviderUsage(usage: ProviderUsage): NormalizedProviderUsage {
  const groupId = effectiveGroupId(usage);
  const accountEmail = effectiveAccountEmail(usage);
  const displayName =
    cleanDisplayName(usage.displayName, accountEmail) || usage.displayName.trim() || groupId;
  const windows =
    groupId === "omp-antigravity" ? sortAntigravityWindows(usage.windows) : usage.windows;

  return {
    usage: { ...usage, groupId, accountEmail: accountEmail ?? undefined, displayName, windows },
    nativeMetadataCount: Number(usage.groupId != null) + Number(usage.accountEmail != null),
  };
}

function isRetiredProviderUsage(usage: ProviderUsage): boolean {
  const effectiveId = effectiveGroupId(usage);
  const label = usage.displayName.trim().toLowerCase();
  return (
    effectiveId === "omp" ||
    label === "supergrok" ||
    label.startsWith("supergrok ") ||
    label === "super grok"
  );
}

function isBackedByEnabledProvider(
  usage: ProviderUsage,
  enabledProviderIds: ReadonlySet<string>,
): boolean {
  const groupId = effectiveGroupId(usage);
  if (groupId.startsWith("omp-")) {
    return enabledProviderIds.has("omp");
  }
  return enabledProviderIds.has(usage.providerId);
}

/**
 * One account can be visible through more than one host. Keep a single copy so the footer
 * presents one account list instead of leaking host topology into the UI. When copies collide,
 * prefer (a) the card with native metadata (groupId/accountEmail), then (b) the card with MORE
 * usage windows — the rich direct-API card over a CLI-shaped card — then (c) the freshest.
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
      if (isRetiredProviderUsage(sourceUsage)) continue;
      const normalized = normalizeProviderUsage(sourceUsage);
      const { usage } = normalized;
      if (!isBackedByEnabledProvider(usage, enabledProviderIds)) continue;

      const key = `${usage.groupId}::${usage.accountEmail ?? ""}`;
      const fetchedAt = effectiveFetchedAt(sourceUsage, report.view.payload.fetchedAt);
      const current = merged.get(key);
      if (current && !candidateBeatsCurrent(current, normalized, fetchedAt)) continue;

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

// Collision order: native group/email metadata first (new daemons over old), then
// quality score (a direct-API 4-window Antigravity summary beats a raw CLI card with duplicates),
// then freshest fetch.
function providerUsageRichnessScore(usage: ProviderUsage): number {
  const windows = usage.windows;
  if (windows.length === 0) return 0;
  const uniqueLabels = new Set(windows.map((w) => w.label.trim().toLowerCase()));
  if (uniqueLabels.size < windows.length) {
    return uniqueLabels.size;
  }
  if (usage.groupId === "omp-antigravity") {
    const compoundCount = windows.filter((w) => w.label.includes(" · ")).length;
    if (compoundCount === 4) return 100;
    return compoundCount * 10 + windows.length;
  }
  return windows.length;
}

function candidateBeatsCurrent(
  current: { usage: ProviderUsage; fetchedAt: string; nativeMetadataCount: number },
  candidate: NormalizedProviderUsage,
  candidateFetchedAt: string,
): boolean {
  if (current.nativeMetadataCount !== candidate.nativeMetadataCount) {
    return candidate.nativeMetadataCount > current.nativeMetadataCount;
  }
  const currentRichness = providerUsageRichnessScore(current.usage);
  const candidateRichness = providerUsageRichnessScore(candidate.usage);
  if (currentRichness !== candidateRichness) {
    return candidateRichness > currentRichness;
  }
  return fetchedAtMillis(candidateFetchedAt) > fetchedAtMillis(current.fetchedAt);
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

export interface HostStatusSummary {
  loading: number;
  refreshing: number;
  failed: number;
}

export function summarizeHostStatus(
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
      // Usage arrived but the provider snapshot failed: the host's cards stay
      // hidden (enablement unknown), so count it as failed, not loading.
      if (report.enabledProviderIds === null) {
        if (report.snapshotError) failed += 1;
        else loading += 1;
      }
      if (view.isRefreshing) refreshing += 1;
    }
  }

  return { loading, refreshing, failed };
}

export function hostStatusText({ loading, refreshing, failed }: HostStatusSummary): string | null {
  const parts: string[] = [];
  if (loading > 0) parts.push(`${loading} ${loading === 1 ? "host" : "hosts"} still loading`);
  if (refreshing > 0) parts.push(`${refreshing} ${refreshing === 1 ? "host" : "hosts"} refreshing`);
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "host" : "hosts"} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
