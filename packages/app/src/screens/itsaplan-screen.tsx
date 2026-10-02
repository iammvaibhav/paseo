import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { RefreshCw, SquareKanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getDesktopHost } from "@/desktop/host";
import { useAppSettings } from "@/hooks/use-settings";
import { pickItsaplanEmbedHost, resolveItsaplanEmbedOrigin } from "@/itsaplan/itsaplan-origin";
import {
  getItsaplanSelectedProject,
  setItsaplanSelectedProject,
  subscribeItsaplanSelectedProject,
} from "@/itsaplan/itsaplan-selected-project";
import { ItsaplanEmbed } from "@/itsaplan/itsaplan-webview";
import { useHosts } from "@/runtime/host-runtime";

type LoadStatus = "loading" | "ready" | "error";

/** How long the pre-flight reachability probe waits before declaring the origin dead. */
const REACHABILITY_TIMEOUT_MS = 8_000;

/**
 * Full-screen embed of itsaplan. The tool runs next to the Paseo daemon, so the
 * origin resolves exactly like a Plannotator embed: loopback for a local daemon,
 * host-profile hostname for a remote one, and an explicit Settings override on
 * top of both. When no address can be resolved at all the screen explains
 * itself instead of rendering a dead frame.
 */
export function ItsaplanScreen(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const { settings } = useAppSettings();
  const params = useLocalSearchParams<{ project?: string; projectKey?: string }>();
  const rawParam = typeof params.project === "string" ? params.project : params.projectKey;
  const routeProject = typeof rawParam === "string" ? rawParam.trim() : "";
  const storedProject = useSyncExternalStore(
    subscribeItsaplanSelectedProject,
    getItsaplanSelectedProject,
    getItsaplanSelectedProject,
  );
  const projectParam = storedProject || routeProject;
  useEffect(() => {
    if (routeProject && getItsaplanSelectedProject().length === 0) {
      setItsaplanSelectedProject(routeProject);
    }
  }, [routeProject]);

  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<LoadStatus>("loading");

  // Inside the Electron shell, subframes cannot trust itsaplan's self-signed
  // TLS certificate — the frame silently stays white. The desktop embed loads
  // plain HTTP instead and counts on Chromium's insecure-origin allowlist
  // (syncInsecureOrigins) for a secure context. Only enable that transport
  // when the bridge that maintains the allowlist actually exists; elsewhere
  // keep speaking HTTPS to the resolved origin.
  const useDesktopEmbed = useMemo(
    () => typeof getDesktopHost()?.browserEditor?.setInsecureOrigins === "function",
    [],
  );

  // itsaplan is a per-machine service: prefer the local daemon's machine, else
  // the first registered host.
  const targetHost = useMemo(
    () => pickItsaplanEmbedHost(hosts, localServerId),
    [hosts, localServerId],
  );
  const isLocalDaemon = useIsLocalDaemon(targetHost?.serverId ?? "");

  const resolved = useMemo(
    () =>
      targetHost
        ? resolveItsaplanEmbedOrigin({
            isLocalDaemon,
            configuredOrigin: settings.itsaplanOrigin,
            browserEditorUrl: targetHost.browserEditorUrl ?? null,
            hostProfile: targetHost,
            insecureHttp: useDesktopEmbed,
          })
        : null,
    [targetHost, isLocalDaemon, settings.itsaplanOrigin, useDesktopEmbed],
  );
  const markLoaded = useCallback(() => setStatus("ready"), []);
  const markFailed = useCallback(() => setStatus("error"), []);
  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

  // Pre-flight reachability probe. The web iframe fires onLoad even for
  // certificate failures and error pages, so without this a dead origin would
  // flip straight to "ready" over an empty white frame. An opaque no-cors
  // request resolves on any HTTP response and rejects only when the connection
  // itself fails (refused, DNS, TLS).
  useEffect(() => {
    const origin = resolved?.origin;
    if (!origin) {
      return undefined;
    }
    let cancelled = false;
    setStatus("loading");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    fetch(origin, { mode: "no-cors", cache: "no-store", signal: controller.signal }).catch(() => {
      if (!cancelled) {
        setStatus("error");
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [resolved, attempt]);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sidebar.sections.itsaplan")} />
      {resolved === null ? (
        <View style={styles.centered}>
          <SquareKanban size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>{t("itsaplan.notConfigured.title")}</Text>
          <Text style={styles.emptyDescription}>{t("itsaplan.notConfigured.description")}</Text>
        </View>
      ) : (
        <View style={styles.embedContainer}>
          <ItsaplanEmbed
            origin={resolved.origin}
            project={projectParam}
            attempt={attempt}
            onLoaded={markLoaded}
            onFailed={markFailed}
            testID="itsaplan-embed"
          />
          {status !== "ready" ? (
            <View style={styles.overlay} pointerEvents={status === "error" ? "auto" : "none"}>
              {status === "loading" ? (
                <LoadingSpinner size="large" color={styles.spinner.color} />
              ) : (
                <>
                  <Text style={styles.emptyTitle}>{t("itsaplan.unreachable.title")}</Text>
                  <Text style={styles.emptyDescription}>
                    {t("itsaplan.unreachable.description", { origin: resolved.origin })}
                  </Text>
                  <Button
                    variant="outline"
                    leftIcon={RefreshCw}
                    onPress={retry}
                    testID="itsaplan-retry"
                  >
                    {t("itsaplan.retry")}
                  </Button>
                </>
              )}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  embedContainer: {
    flex: 1,
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surfaceSidebar,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    maxWidth: 420,
    alignSelf: "center",
    padding: theme.spacing[6],
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
