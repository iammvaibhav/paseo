import { z } from "zod";
import type { UsageReportEntry } from "./types";

/** Whether percentages read as the share used or the share left. */
export type UsageDisplayAs = "used" | "remaining";

/** Device-local. */
export interface UsagePreferences {
  displayAs: UsageDisplayAs;
  /** The host the user picked to show usage for; null until they pick one. */
  serverId: string | null;
  /** Report IDs the user arranged, in their order. Shared by every host. */
  cardOrder: string[];
  /** Explicit per-report visibility overrides; absent IDs follow the host's `defaultEnabled` hint. */
  cardVisibility: Record<string, boolean>;
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  displayAs: "used",
  serverId: null,
  cardOrder: [],
  cardVisibility: {},
};

const reportIdsSchema = z.array(z.string()).optional().catch(undefined);
const cardVisibilitySchema = z.record(z.string(), z.boolean()).optional().catch(undefined);

export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    serverId: z.string().nullable().catch(null),
    cardOrder: reportIdsSchema,
    cardVisibility: cardVisibilitySchema,
    // COMPAT(usageCardsOff): replaced by cardVisibility in v0.18, remove after 2027-05-22.
    cardsOff: reportIdsSchema,
  })
  .transform(({ displayAs, serverId, cardOrder, cardVisibility, cardsOff }): UsagePreferences => {
    const legacyVisibility =
      cardsOff && cardsOff.length > 0
        ? Object.fromEntries(cardsOff.map((id) => [id, false] as const))
        : {};
    return {
      displayAs,
      serverId,
      cardOrder: cardOrder ?? [],
      cardVisibility: cardVisibility ?? legacyVisibility,
    };
  })
  .catch(DEFAULT_USAGE_PREFERENCES);

export function setUsageDisplayAs(
  preferences: UsagePreferences,
  displayAs: UsageDisplayAs,
): UsagePreferences {
  return { ...preferences, displayAs };
}

export function setUsageHost(preferences: UsagePreferences, serverId: string): UsagePreferences {
  return { ...preferences, serverId };
}

/** Reports the user has not arranged: by provider, then account, then ID. */
function compareByDefaultOrder(a: UsageReportEntry, b: UsageReportEntry): number {
  return (
    a.sourceLabel.localeCompare(b.sourceLabel) ||
    (a.account.label ?? "").localeCompare(b.account.label ?? "") ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Reports in the order their cards show: the ones the user arranged first, in their order, then
 * the rest in the default order. Arrival order never matters, so a report that streams in late or
 * appears for a new login lands in its own slot.
 */
export function arrangeUsageReports(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): UsageReportEntry[] {
  const rank = new Map(preferences.cardOrder.map((id, index) => [id, index]));
  return [...reports].sort((a, b) => {
    const rankA = rank.get(a.id);
    const rankB = rank.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return compareByDefaultOrder(a, b);
  });
}

/** A drop as the list reports it: the card the user moved and the shown cards' order after it. */
export interface UsageCardDrop {
  moved: string;
  after: readonly string[];
}

/**
 * The order after the user drops a card. Only the moved card changes place: it goes just before
 * its new successor among the shown cards, or just after its new predecessor when it lands last.
 * Shown cards not yet arranged are added at the end, in their shown order. Other arranged cards
 * keep their places relative to each other. The order is shared by every host, so a drop that
 * arranges a card another host also shows ranks it ahead of that host's unarranged cards.
 */
export function arrangeUsageCards(
  preferences: UsagePreferences,
  { moved, after }: UsageCardDrop,
): UsagePreferences {
  const arranged = new Set([...preferences.cardOrder, moved]);
  const rest = [
    ...preferences.cardOrder.filter((id) => id !== moved),
    ...after.filter((id) => !arranged.has(id)),
  ];
  const index = after.indexOf(moved);
  const successor = after[index + 1];
  const at = successor === undefined ? rest.indexOf(after[index - 1]) + 1 : rest.indexOf(successor);
  rest.splice(at, 0, moved);
  return { ...preferences, cardOrder: rest };
}

/** Whether a report card is shown, honoring an explicit user override before the host's default hint. */
export function isUsageCardOn(
  preferences: UsagePreferences,
  entry: Pick<UsageReportEntry, "id" | "defaultEnabled">,
): boolean {
  const explicit = preferences.cardVisibility[entry.id];
  if (explicit !== undefined) return explicit;
  return entry.defaultEnabled !== false;
}

export function setUsageCardOn(
  preferences: UsagePreferences,
  reportId: string,
  on: boolean,
): UsagePreferences {
  return {
    ...preferences,
    cardVisibility: { ...preferences.cardVisibility, [reportId]: on },
  };
}
