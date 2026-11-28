import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import {
  arrangeUsageCards,
  arrangeUsageReports,
  isUsageCardOn,
  setUsageCardOn,
  setUsageDisplayAs,
  type UsageCardDrop,
  type UsageDisplayAs,
  type UsagePreferences,
} from "./preferences";
import type { UsageReportEntry } from "./types";

/** What usage views need from the preferences: how to read percents, and the cards. */
export interface UsageDisplay {
  displayAs: UsageDisplayAs;
  setDisplayAs: (displayAs: UsageDisplayAs) => void;
  /** Reports in the order their cards show. */
  arrange: (reports: readonly UsageReportEntry[]) => UsageReportEntry[];
  /** Saves the order of the shown cards after the user drops one. */
  arrangeCards: (drop: UsageCardDrop) => void;
  isCardOn: (entry: Pick<UsageReportEntry, "id" | "defaultEnabled">) => boolean;
  setCardOn: (reportId: string, on: boolean) => void;
}

interface UsagePreferencesState {
  preferences: UsagePreferences;
  display: UsageDisplay;
}

/** The device's usage preferences. */
export function useUsageDisplay(): UsagePreferencesState {
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.usage;
  const setDisplayAs = useCallback(
    (displayAs: UsageDisplayAs) => {
      void updateSettings((current) => ({ usage: setUsageDisplayAs(current.usage, displayAs) }));
    },
    [updateSettings],
  );
  const arrangeCards = useCallback(
    (drop: UsageCardDrop) => {
      void updateSettings((current) => ({ usage: arrangeUsageCards(current.usage, drop) }));
    },
    [updateSettings],
  );
  const setCardOn = useCallback(
    (reportId: string, on: boolean) => {
      void updateSettings((current) => ({ usage: setUsageCardOn(current.usage, reportId, on) }));
    },
    [updateSettings],
  );
  const display = useMemo<UsageDisplay>(
    () => ({
      displayAs: preferences.displayAs,
      setDisplayAs,
      arrange: (shown) => arrangeUsageReports(shown, preferences),
      arrangeCards,
      isCardOn: (entry) => isUsageCardOn(preferences, entry),
      setCardOn,
    }),
    [arrangeCards, preferences, setCardOn, setDisplayAs],
  );
  return { preferences, display };
}
