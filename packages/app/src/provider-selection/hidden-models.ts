import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * Which models the user does not want offered in a picker. This is a client-side
 * display preference and nothing else: the daemon keeps serving the full
 * catalog, so a provider that falls back onto a hidden model can still name it
 * in the composer. Filtering happens where a *choosable* list is built, never
 * where a selected model is labelled.
 *
 * Keys are `provider:modelId` — the same handle `ProviderSelectionModelRow`
 * carries as `favoriteKey`. The set is host-independent on purpose: a fleet runs
 * one model catalog, and per-host sets would silently diverge.
 */
export function buildHiddenModelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

const PersistedHiddenModelsSchema = z.object({
  hiddenKeys: z.array(z.string()),
});

type PersistedHiddenModels = z.infer<typeof PersistedHiddenModelsSchema>;

interface HiddenModelsState {
  hiddenKeys: ReadonlySet<string>;
  setModelHidden: (provider: string, modelId: string, hidden: boolean) => void;
  setModelsHidden: (
    models: readonly { provider: string; modelId: string }[],
    hidden: boolean,
  ) => void;
}

function nextHiddenKeys(
  current: ReadonlySet<string>,
  keys: readonly string[],
  hidden: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (hidden) next.add(key);
    else next.delete(key);
  }
  // Toggling a model that is already in the wanted state must not publish a new
  // reference: every picker derives memoized rows from this set.
  return next.size === current.size ? current : next;
}

export const useHiddenModelsStore = create<HiddenModelsState>()(
  persist<HiddenModelsState, [], [], PersistedHiddenModels>(
    (set) => ({
      hiddenKeys: new Set<string>(),
      setModelHidden: (provider, modelId, hidden) =>
        set((state) => ({
          hiddenKeys: nextHiddenKeys(
            state.hiddenKeys,
            [buildHiddenModelKey(provider, modelId)],
            hidden,
          ),
        })),
      setModelsHidden: (models, hidden) =>
        set((state) => ({
          hiddenKeys: nextHiddenKeys(
            state.hiddenKeys,
            models.map((model) => buildHiddenModelKey(model.provider, model.modelId)),
            hidden,
          ),
        })),
    }),
    {
      name: "hidden-models",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedHiddenModelsSchema),
      partialize: (state) => ({ hiddenKeys: [...state.hiddenKeys].sort() }),
      merge: (persistedState, currentState) => {
        const persisted = PersistedHiddenModelsSchema.safeParse(persistedState);
        return {
          ...currentState,
          hiddenKeys: new Set(persisted.success ? persisted.data.hiddenKeys : []),
        };
      },
    },
  ),
);

export function useHiddenModelKeys(): ReadonlySet<string> {
  return useHiddenModelsStore((state) => state.hiddenKeys);
}
