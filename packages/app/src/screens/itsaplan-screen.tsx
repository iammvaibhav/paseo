import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { RefreshCw, SquareKanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useAppSettings } from "@/hooks/use-settings";
import { resolveItsaplanEmbedOrigin } from "@/itsaplan/itsaplan-origin";
import { ItsaplanEmbed } from "@/itsaplan/itsaplan-webview";
import { useHosts } from "@/runtime/host-runtime";

type LoadStatus = "loading" | "ready" | "error";

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

  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<LoadStatus>("loading");

  // itsaplan is a per-machine service: prefer the local daemon's machine, else
  // the first registered host.
  const targetHost = useMemo(
    () => hosts.find((host) => host.serverId === localServerId) ?? hosts[0] ?? null,
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
          })
        : null,
    [targetHost, isLocalDaemon, settings.itsaplanOrigin],
  );

  const markLoaded = useCallback(() => setStatus("ready"), []);
  const markFailed = useCallback(() => setStatus("error"), []);
  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

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
