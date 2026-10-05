import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "../../server/messages.js";
import type { ProviderApiFetch } from "./provider.js";

export const ApiNumberSchema = z.coerce.number().finite();
export const ApiNullableNumberSchema = z.preprocess(
  (value) => (value == null ? null : value),
  ApiNumberSchema.nullable(),
);
export const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

// COMPAT(fastProviderUsage): per-provider budget for the parallel refresh. Six
// seconds covers OAuth quota endpoints and the OMP usage CLI on a loaded host;
// a hung provider must not hold the whole list.
const PROVIDER_HTTP_TIMEOUT_MS = 6_000;

export function fetchProviderApi(
  fetchApi: ProviderApiFetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetchApi(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS),
  });
}

// COMPAT(fastProviderUsage): caps one provider's whole fetch (sequential CLI
// calls, token refreshes, HTTP hops) at ~6 s. HTTP itself is already bounded by
// fetchProviderApi; this covers providers like OMP that chain several
// subprocess calls, so a hung `omp usage` cannot hold the refresh.
export function toIsoStringOrNull(timestampMs: number): string | null {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function withProviderTimeout<T>(
  promise: Promise<T>,
  timeoutMs = PROVIDER_HTTP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Provider usage fetch timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function unavailableUsage(provider: {
  providerId: string;
  displayName: string;
  error?: string | null;
}): ProviderUsage {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: provider.error ? "error" : "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: provider.error ?? null,
  };
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: ProviderUsageWindow["tone"];
}): ProviderUsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: ProviderUsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.tone) {
    window.tone = input.tone;
  }
  return window;
}

/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct: number | null | undefined): ProviderUsageTone {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): ProviderUsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return (used / limit) * 100;
}

export type ProviderHeadroomTone = "ready" | "low" | "exhausted" | "checking" | "unknown";

// COMPAT(fastProviderUsage): headroom of one window, ported from MonoCode
// accountHeadroom: remaining percent of the tightest window. A window whose
// reset already passed counts as fully available.
function windowHeadroom(window: ProviderUsageWindow, nowMs: number): number | null {
  const used = typeof window.usedPct === "number" ? window.usedPct : null;
  let consumed: number | null = used;
  if (consumed === null && typeof window.remainingPct === "number") {
    consumed = 100 - window.remainingPct;
  }
  if (consumed === null) return null;
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs) return 100;
  return Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(100, consumed))));
}

// COMPAT(fastProviderUsage): remaining percent of the tightest window across
// session/weekly/monthly, or null when no window carries usage data.
export function providerHeadroomPercent(usage: ProviderUsage, nowMs: number): number | null {
  const values: number[] = [];
  for (const window of usage.windows ?? []) {
    const headroom = windowHeadroom(window, nowMs);
    if (headroom !== null) values.push(headroom);
  }
  if (values.length === 0) return null;
  return Math.min(...values);
}

// COMPAT(fastProviderUsage): "back in 31m" for the used-up window that stays
// blocked longest, ported from MonoCode backIn/formatResetDuration.
export function providerResetCountdown(usage: ProviderUsage, nowMs: number): string | null {
  let latest = -1;
  for (const window of usage.windows ?? []) {
    const used = typeof window.usedPct === "number" ? window.usedPct : null;
    const remaining = window.remainingPct;
    const exhausted =
      (used !== null && used >= 100) ||
      (remaining !== null && remaining !== undefined && remaining <= 0);
    if (!exhausted) continue;
    if (!window.resetsAt) continue;
    const resetsAtMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) continue;
    if (resetsAtMs > latest) latest = resetsAtMs;
  }
  if (latest < 0) return null;
  return `back in ${formatResetDuration(latest - nowMs)}`;
}

function formatResetDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// COMPAT(fastProviderUsage): ready/low/exhausted tone for a usage card, ported
// from MonoCode accountStatus. 20% matches LOW_HEADROOM_PERCENT there.
export function providerHeadroomTone(
  usage: ProviderUsage,
  headroom: number | null,
): ProviderHeadroomTone {
  if (usage.status !== "available") return "unknown";
  if (headroom === null) {
    return usage.windows.length === 0 ? "unknown" : "checking";
  }
  if (headroom <= 0) return "exhausted";
  if (headroom <= 20) return "low";
  return "ready";
}

// COMPAT(fastProviderUsage): stamps headroomTone/headroomPercent/resetCountdown
// onto a card so the first render already carries the tone; clients recompute
// locally every 30 s against resetsAt without network traffic.
export function withHeadroom(usage: ProviderUsage, nowMs: number): ProviderUsage {
  const headroomPercent = providerHeadroomPercent(usage, nowMs);
  const headroomTone = providerHeadroomTone(usage, headroomPercent);
  return {
    ...usage,
    headroomTone,
    headroomPercent,
    resetCountdown: headroomTone === "exhausted" ? providerResetCountdown(usage, nowMs) : null,
  };
}

// COMPAT(fastProviderUsage): the sibling account with the most headroom above
// 20%, ported from MonoCode bestAlternativeAccount. Cards sharing groupId are
// siblings; returns null when the active card is healthy or no sibling clears
// the bar.
export function markBestAlternative(providers: ProviderUsage[], nowMs: number): ProviderUsage[] {
  const byGroup = new Map<string, number[]>();
  providers.forEach((usage, index) => {
    const key = usage.groupId ?? usage.providerId;
    const list = byGroup.get(key) ?? [];
    list.push(index);
    byGroup.set(key, list);
  });
  const bestByGroup = new Map<string, number>();
  for (const [group, indexes] of byGroup) {
    if (indexes.length < 2) continue;
    let best = -1;
    let bestHeadroom = 20;
    for (const index of indexes) {
      const headroom = providerHeadroomPercent(providers[index]!, nowMs);
      if (headroom !== null && headroom > bestHeadroom) {
        bestHeadroom = headroom;
        best = index;
      }
    }
    if (best >= 0) bestByGroup.set(group, best);
  }
  return providers.map((usage) => {
    const key = usage.groupId ?? usage.providerId;
    const best = bestByGroup.get(key);
    if (best === undefined) return usage;
    const bestCard = providers[best]!;
    const active = usage.active === true;
    const tone = usage.headroomTone;
    const needsSwitch = tone === "low" || tone === "exhausted";
    if (providers[best] === usage) return { ...usage, isBestAlternative: true };
    if (!active || !needsSwitch) return usage;
    return {
      ...usage,
      isBestAlternative: false,
      bestAlternativeAccountId: bestCard.providerId,
      bestAlternativeAccountName: bestCard.accountEmail ?? bestCard.displayName,
    };
  });
}
