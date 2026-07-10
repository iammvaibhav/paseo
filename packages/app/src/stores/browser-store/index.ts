import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  applyBrowserPatch,
  type BrowserIndexState,
  type BrowserRecord,
  type BrowserRecordPatch,
  createBrowserRecord,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export type { BrowserRecord } from "./state";

export interface BrowserNavigationRequest {
  url: string;
  requestId: number;
}

interface BrowserStoreState extends BrowserIndexState {
  navigationRequestByBrowserId: Record<string, BrowserNavigationRequest>;
  createBrowser: (input?: { initialUrl?: string }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  removeBrowser: (browserId: string) => void;
  requestNavigation: (browserId: string, url: string) => void;
  clearNavigationRequest: (browserId: string, requestId: number) => void;
}

function createBrowserId(): string {
  let browserId: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    browserId = globalThis.crypto.randomUUID();
  } else {
    const randomSuffix = Math.random().toString(16).slice(2) || "0";
    browserId = `${Date.now()}-${randomSuffix}`;
  }
  return BrowserAutomationBrowserIdSchema.parse(browserId);
}

export const useBrowserStore = create<BrowserStoreState>()(
  persist(
    (set) => ({
      browsersById: {},
      navigationRequestByBrowserId: {},
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl,
          now: Date.now(),
        });

        set((state) => ({
          browsersById: {
            ...state.browsersById,
            [browserId]: record,
          },
        }));

        return browserId;
      },
      updateBrowser: (browserId, patch) => {
        set((state) => applyBrowserPatch(state, browserId, patch));
      },
      removeBrowser: (browserId) => {
        set((state) => {
          const nextRequests = { ...state.navigationRequestByBrowserId };
          delete nextRequests[browserId];
          return {
            ...removeBrowserFromIndex(state, browserId),
            navigationRequestByBrowserId: nextRequests,
          };
        });
      },
      requestNavigation: (browserId, url) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        const normalizedUrl = normalizeBrowserUrl(url);
        if (!normalizedBrowserId) {
          return;
        }
        set((state) => {
          const previous = state.navigationRequestByBrowserId[normalizedBrowserId];
          return {
            navigationRequestByBrowserId: {
              ...state.navigationRequestByBrowserId,
              [normalizedBrowserId]: {
                url: normalizedUrl,
                requestId: (previous?.requestId ?? 0) + 1,
              },
            },
          };
        });
      },
      clearNavigationRequest: (browserId, requestId) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        if (!normalizedBrowserId) {
          return;
        }
        set((state) => {
          const current = state.navigationRequestByBrowserId[normalizedBrowserId];
          if (!current || current.requestId !== requestId) {
            return state;
          }
          const nextRequests = { ...state.navigationRequestByBrowserId };
          delete nextRequests[normalizedBrowserId];
          return { navigationRequestByBrowserId: nextRequests };
        });
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => sanitizeBrowsersForPersist(state),
    },
  ),
);

export function getBrowserRecord(browserId: string): BrowserRecord | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  return useBrowserStore.getState().browsersById[normalizedBrowserId] ?? null;
}

export function createWorkspaceBrowser(input?: { initialUrl?: string }): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url: record?.url ?? normalizeBrowserUrl(input?.initialUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
