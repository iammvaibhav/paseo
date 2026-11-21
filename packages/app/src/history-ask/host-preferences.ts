import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";

export const HISTORY_ASK_HOST_PREFERENCES_KEY = "@paseo:history-ask-host-preferences";

const hostSelectionSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
});

const hostPreferencesSchema = z.object({
  byHost: z.record(z.string(), hostSelectionSchema).optional(),
});

export type HistoryAskHostSelection = z.infer<typeof hostSelectionSchema>;
export type HistoryAskHostPreferences = z.infer<typeof hostPreferencesSchema>;

export const DEFAULT_HISTORY_ASK_HOST_PREFERENCES: HistoryAskHostPreferences = {};

export function parseHistoryAskHostPreferences(value: unknown): HistoryAskHostPreferences {
  const result = hostPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_HISTORY_ASK_HOST_PREFERENCES;
}

export function resolveHistoryAskHostSelection(
  preferences: HistoryAskHostPreferences,
  serverId: string | null | undefined,
): HistoryAskHostSelection {
  const hostId = serverId?.trim() ?? "";
  if (!hostId) {
    return {};
  }
  return preferences.byHost?.[hostId] ?? {};
}

export function setHistoryAskHostSelection(
  preferences: HistoryAskHostPreferences,
  serverId: string,
  selection: HistoryAskHostSelection,
): HistoryAskHostPreferences {
  const hostId = serverId.trim();
  if (!hostId) {
    return preferences;
  }
  const provider = selection.provider?.trim() || undefined;
  const model = selection.model?.trim() || undefined;
  return {
    ...preferences,
    byHost: {
      ...preferences.byHost,
      [hostId]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  };
}

export async function loadHistoryAskHostPreferences(): Promise<HistoryAskHostPreferences> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_ASK_HOST_PREFERENCES_KEY);
    if (!raw) {
      return DEFAULT_HISTORY_ASK_HOST_PREFERENCES;
    }
    return parseHistoryAskHostPreferences(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_HISTORY_ASK_HOST_PREFERENCES;
  }
}

export async function saveHistoryAskHostPreferences(
  preferences: HistoryAskHostPreferences,
): Promise<void> {
  await AsyncStorage.setItem(HISTORY_ASK_HOST_PREFERENCES_KEY, JSON.stringify(preferences));
}

export async function updateHistoryAskHostSelection(
  serverId: string,
  selection: HistoryAskHostSelection,
): Promise<HistoryAskHostPreferences> {
  const current = await loadHistoryAskHostPreferences();
  const next = setHistoryAskHostSelection(current, serverId, selection);
  await saveHistoryAskHostPreferences(next);
  return next;
}
