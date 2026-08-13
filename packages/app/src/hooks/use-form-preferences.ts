import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_FORM_PREFERENCES,
  buildFavoriteModelKey,
  isFavoriteModel,
  mergeProviderPreferences,
  mergeProviderPreferencesWithScope,
  normalizeFormPreferenceScope,
  resolveEffectiveFormPreferences,
  resolveFavoriteModels,
  toggleFavoriteModel,
  type FavoriteModelPreference,
  type FavoriteModelRow,
  type FormPreferenceScope,
  type FormPreferences,
  type ProviderPreferences,
} from "@/create-agent-preferences/preferences";
import {
  createAgentPreferencesService,
  type FormPreferenceUpdate,
} from "@/create-agent-preferences/service";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const FORM_PREFERENCES_QUERY_KEY = ["form-preferences"];

export type {
  FavoriteModelPreference,
  FavoriteModelRow,
  FormPreferenceScope,
  FormPreferences,
  ProviderPreferences,
};

export {
  buildFavoriteModelKey,
  isFavoriteModel,
  mergeProviderPreferences,
  mergeProviderPreferencesWithScope,
  normalizeFormPreferenceScope,
  resolveEffectiveFormPreferences,
  resolveFavoriteModels,
  toggleFavoriteModel,
};

async function loadFormPreferences(): Promise<FormPreferences> {
  return createAgentPreferencesService.load();
}

/** A composer-preferences blob with any data in it — empty is `{}`/undefined. */
function hasPreferencesData(preferences: FormPreferences | undefined): boolean {
  return Boolean(preferences && Object.keys(preferences).length > 0);
}

export interface UseFormPreferencesReturn {
  preferences: FormPreferences;
  isLoading: boolean;
  updatePreferences: (updates: FormPreferenceUpdate) => Promise<FormPreferences>;
}

/**
 * The create-agent form's remembered provider/model preferences.
 *
 * Pass the host the composer targets (`serverId`) to sync the blob with that
 * daemon's `composerPreferences` (config.json): on connect / daemon change the
 * daemon's blob wins and hydrates local storage, and when the daemon has none
 * while local storage has data the local blob is uploaded once. Every
 * `updatePreferences` writes AsyncStorage and mirrors the result to the daemon.
 * Omit `serverId` for a purely device-local store (no daemon sync).
 */
export function useFormPreferences(serverId?: string | null): UseFormPreferencesReturn {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const daemonConfigQuery = useDaemonConfig(serverId ?? null);
  const { data, isPending } = useQuery({
    queryKey: FORM_PREFERENCES_QUERY_KEY,
    queryFn: loadFormPreferences,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const preferences = data ?? DEFAULT_FORM_PREFERENCES;

  // Update-time host snapshot: the sync effect and updatePreferences read the
  // latest host/client without recreating callbacks on every connect change.
  const serverIdRef = useRef(serverId ?? null);
  serverIdRef.current = serverId ?? null;
  const clientRef = useRef(client);
  clientRef.current = client;
  const lastHydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!serverIdRef.current || !isConnected || !clientRef.current) {
      return;
    }

    const daemonPrefs = daemonConfigQuery.config?.composerPreferences;
    if (hasPreferencesData(daemonPrefs)) {
      // Daemon wins: hydrate the service (memory + AsyncStorage) and the query.
      const key = JSON.stringify(daemonPrefs);
      if (key === lastHydratedKeyRef.current) {
        return;
      }
      lastHydratedKeyRef.current = key;
      let cancelled = false;
      void createAgentPreferencesService.hydrate(daemonPrefs).then((hydrated) => {
        if (!cancelled) {
          queryClient.setQueryData<FormPreferences>(FORM_PREFERENCES_QUERY_KEY, hydrated);
        }
        return undefined;
      });
      return () => {
        cancelled = true;
      };
    }

    // Daemon has no composer preferences: upload the local blob once so a
    // device that used the form before ever connecting keeps its pick.
    let cancelled = false;
    void createAgentPreferencesService.load().then((local) => {
      if (cancelled || !clientRef.current) {
        return undefined;
      }
      if (hasPreferencesData(local)) {
        void clientRef.current.patchDaemonConfig({ composerPreferences: local });
      }
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [daemonConfigQuery.config?.composerPreferences, isConnected, queryClient, serverId]);

  const updatePreferences = useCallback(
    async (updates: FormPreferenceUpdate) => {
      const next = await createAgentPreferencesService.update(updates);
      queryClient.setQueryData<FormPreferences>(FORM_PREFERENCES_QUERY_KEY, next);
      const currentClient = clientRef.current;
      if (serverIdRef.current && currentClient) {
        try {
          await currentClient.patchDaemonConfig({ composerPreferences: next });
        } catch (error) {
          // Local write already succeeded and the UI is committed to `next`;
          // the daemon mirror is best-effort and re-syncs on the next connect.
          console.warn("Failed to mirror composer preferences to the host", error);
        }
      }
      return next;
    },
    [queryClient],
  );

  return {
    preferences,
    isLoading: isPending,
    updatePreferences,
  };
}
