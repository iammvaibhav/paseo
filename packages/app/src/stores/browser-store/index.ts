import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  applyBrowserPatch,
  type BrowserIndexState,
  type BrowserChromeMode,
  type BrowserRecord,
  type BrowserRecordPatch,
  createBrowserRecord,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export type { BrowserChromeMode, BrowserRecord } from "./state";
export { resolveBrowserChromeMode } from "./state";

export interface BrowserNavigationRequest {
  url: string;
  requestId: number;
}

/**
 * A request to open a file in place inside an already-loaded VS Code Web
 * (code-server) webview, via the paseo-bridge extension — no full reload.
 * Consumed by the Electron browser pane, which relays it to the guest page.
 */
export interface BrowserBridgeOpenRequest {
  path: string;
  line: number | null;
  column: number | null;
  /**
   * URL to fall back to (via a normal reload) when the bridge is unreachable —
   * e.g. the code-server window is still cold or the extension has not started.
   */
  fallbackUrl: string | null;
  requestId: number;
}

interface BrowserStoreState extends BrowserIndexState {
  navigationRequestByBrowserId: Record<string, BrowserNavigationRequest>;
  bridgeOpenRequestByBrowserId: Record<string, BrowserBridgeOpenRequest>;
  createBrowser: (input?: {
    browserId?: string;
    initialUrl?: string;
    chrome?: BrowserChromeMode;
  }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  removeBrowser: (browserId: string) => void;
  requestNavigation: (browserId: string, url: string) => void;
  clearNavigationRequest: (browserId: string, requestId: number) => void;
  requestBridgeOpen: (
    browserId: string,
    input: {
      path: string;
      line?: number | null;
      column?: number | null;
      fallbackUrl?: string | null;
    },
  ) => void;
  clearBridgeOpenRequest: (browserId: string, requestId: number) => void;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function createBrowserId(): string {
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
      bridgeOpenRequestByBrowserId: {},
      createBrowser: (input) => {
        const browserId = input?.browserId
          ? BrowserAutomationBrowserIdSchema.parse(input.browserId)
          : createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl,
          chrome: input?.chrome,
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
          const nextBridgeRequests = { ...state.bridgeOpenRequestByBrowserId };
          delete nextBridgeRequests[browserId];
          return {
            ...removeBrowserFromIndex(state, browserId),
            navigationRequestByBrowserId: nextRequests,
            bridgeOpenRequestByBrowserId: nextBridgeRequests,
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
      requestBridgeOpen: (browserId, input) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        const path = trimNonEmpty(input.path);
        if (!normalizedBrowserId || !path) {
          return;
        }
        set((state) => {
          const previous = state.bridgeOpenRequestByBrowserId[normalizedBrowserId];
          return {
            bridgeOpenRequestByBrowserId: {
              ...state.bridgeOpenRequestByBrowserId,
              [normalizedBrowserId]: {
                path,
                line: normalizePositiveInteger(input.line),
                column: normalizePositiveInteger(input.column),
                fallbackUrl: trimNonEmpty(input.fallbackUrl),
                requestId: (previous?.requestId ?? 0) + 1,
              },
            },
          };
        });
      },
      clearBridgeOpenRequest: (browserId, requestId) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        if (!normalizedBrowserId) {
          return;
        }
        set((state) => {
          const current = state.bridgeOpenRequestByBrowserId[normalizedBrowserId];
          if (!current || current.requestId !== requestId) {
            return state;
          }
          const nextRequests = { ...state.bridgeOpenRequestByBrowserId };
          delete nextRequests[normalizedBrowserId];
          return { bridgeOpenRequestByBrowserId: nextRequests };
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

export function createWorkspaceBrowser(input?: {
  browserId?: string;
  initialUrl?: string;
  chrome?: BrowserChromeMode;
}): {
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
