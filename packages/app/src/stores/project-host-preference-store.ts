import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Sticky last-used host for a multi-host project (ADR 0001: multi-host projects open the
// sticky last-used host's base workspace). Keyed by project view key — the same identity
// the sidebar groups a project's per-host placements under (see workspace-structure.ts). Follows
// the FormPreferences `byProject` precedent (create-agent-preferences/preferences.ts): a flat
// record scoped by project, persisted client-side only. Purely a navigation convenience, so
// unlike FormPreferences it is never mirrored to the daemon.
interface ProjectHostPreferenceStoreState {
  lastUsedHostByProject: Record<string, string>;
  getLastUsedHost: (projectViewKey: string) => string | null;
  setLastUsedHost: (projectViewKey: string, serverId: string) => void;
}

const ProjectHostPreferencePersistedStateSchema = z.strictObject({
  lastUsedHostByProject: z.record(z.string(), z.string()).optional(),
});

export const useProjectHostPreferenceStore = create<ProjectHostPreferenceStoreState>()(
  persist(
    (set, get) => ({
      lastUsedHostByProject: {},
      getLastUsedHost: (projectViewKey) => {
        const scope = projectViewKey.trim();
        if (!scope) return null;
        return get().lastUsedHostByProject[scope] ?? null;
      },
      setLastUsedHost: (projectViewKey, serverId) => {
        const scope = projectViewKey.trim();
        const host = serverId.trim();
        if (!scope || !host) return;
        set((state) => {
          if (state.lastUsedHostByProject[scope] === host) {
            return state;
          }
          return {
            lastUsedHostByProject: {
              ...state.lastUsedHostByProject,
              [scope]: host,
            },
          };
        });
      },
    }),
    {
      name: "sidebar-project-host-preference",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        ProjectHostPreferencePersistedStateSchema,
      ),
      partialize: (state) => ({ lastUsedHostByProject: state.lastUsedHostByProject }),
      version: 1,
    },
  ),
);
