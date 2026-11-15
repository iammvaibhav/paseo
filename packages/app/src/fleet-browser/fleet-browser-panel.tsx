import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { ExternalLink, Globe, Maximize2, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { FleetBrowserWindow } from "@getpaseo/protocol/fleet-browser/types";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { useIsExplorerSidebarOpen } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { FleetBrowserControlOverlay } from "./control-overlay";
import { FleetBrowserLiveView } from "./live-view";
import { fleetBrowserLiveViewUrl } from "./live-view/types";
import { useFleetBrowserActions, type FleetBrowserActions } from "./use-fleet-browser-actions";
import { useFleetBrowserThumbnail, useFleetBrowserWindows } from "./use-fleet-browser-windows";
import { describeFleetBrowserWindowStatus, fleetBrowserKindLabel } from "./window-status";

const ThemedGlobe = withUnistyles(Globe);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMaximize = withUnistyles(Maximize2, mutedIcon);
const ThemedExternalLink = withUnistyles(ExternalLink, mutedIcon);
const ThemedClose = withUnistyles(X, mutedIcon);
const ThemedNoteInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const fleetBrowserPanelPresentation = {
  label: (t) => t("panels.fleetBrowser.label"),
  subtitle: (t) => t("panels.fleetBrowser.subtitle"),
  tooltip: (t) => t("panels.fleetBrowser.tooltip"),
  icon: ThemedGlobe,
} satisfies PanelPresentation;

/**
 * Fleet desktops are a fixed 16:10 (flotilla's `browser.width` x `browser.height`), so the
 * stream fills this frame; a desktop of another shape letterboxes inside it.
 */
const LIVE_VIEW_ASPECT_RATIO = 16 / 10;

/** True while the panel is on screen: its tab is selected and, in the Explorer, the Explorer is open. */
function usePanelOnScreen(): boolean {
  const { serverId, workspaceId, host } = usePaneContext();
  const retainedActive = useRetainedPanelActive();
  const isCompact = useIsCompactFormFactor();
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const explorerOpen = useIsExplorerSidebarOpen({ isCompact, workspaceKey });
  return retainedActive && (host !== "explorer" || explorerOpen);
}

function FleetBrowserPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = usePaneContext();
  const onScreen = usePanelOnScreen();
  const { supported, windows, error, loading } = useFleetBrowserWindows({ serverId, workspaceId });
  const actions = useFleetBrowserActions({ serverId, workspaceId });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<{ windowId: string; mode: "watch" | "control" } | null>(
    null,
  );
  const selected =
    windows.find((window) => window.id === selectedId) ??
    windows.find((window) => window.handoff !== null) ??
    windows[0] ??
    null;
  const overlayWindow = overlay ? windows.find((window) => window.id === overlay.windowId) : null;
  const openOverlay = useCallback(
    (windowId: string, mode: "watch" | "control") => setOverlay({ windowId, mode }),
    [],
  );
  const closeOverlay = useCallback(() => setOverlay(null), []);

  // The live view shows whichever window is on top of the host's desktop, so the
  // window being watched is raised whenever it changes.
  const raisedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!onScreen || !selected || raisedFor.current === selected.id) return;
    raisedFor.current = selected.id;
    actions.show(selected.id).catch(() => undefined);
  }, [actions, onScreen, selected]);
  useEffect(() => {
    if (!onScreen) raisedFor.current = null;
  }, [onScreen]);

  if (!supported) {
    return (
      <View style={styles.centerState} testID="fleet-browser-unsupported">
        <Text style={styles.mutedText}>{t("panels.fleetBrowser.unsupported")}</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="large" uniProps={mutedIcon} />
      </View>
    );
  }
  return (
    <View style={styles.root} testID="fleet-browser-panel">
      {error ? (
        <Alert
          variant="error"
          size="sm"
          title={t("panels.fleetBrowser.loadFailed")}
          description={error}
        />
      ) : null}
      {windows.length === 0 ? (
        <View style={styles.centerState} testID="fleet-browser-empty">
          <Text style={styles.emptyTitle}>{t("panels.fleetBrowser.empty")}</Text>
          <Text style={styles.mutedText}>{t("panels.fleetBrowser.emptyHint")}</Text>
        </View>
      ) : (
        // Insets live on a View: a contentContainerStyle from StyleSheet is dropped on web
        // (docs/unistyles.md, "Main Gotcha").
        <ScrollView style={styles.scroll}>
          <View style={styles.content}>
            {windows.length > 1 ? (
              <WindowStrip
                serverId={serverId}
                windows={windows}
                selectedId={selected?.id ?? null}
                onScreen={onScreen}
                onSelect={setSelectedId}
              />
            ) : null}
            {selected ? (
              <WindowDetail
                key={selected.id}
                window={selected}
                onScreen={onScreen && overlay === null}
                actions={actions}
                onOpenOverlay={openOverlay}
              />
            ) : null}
          </View>
        </ScrollView>
      )}
      {overlay && overlayWindow ? (
        <FleetBrowserControlOverlay
          window={overlayWindow}
          mode={overlayWindow.control.owner === "user" ? "control" : overlay.mode}
          actions={actions}
          onClose={closeOverlay}
        />
      ) : null}
    </View>
  );
}

function WindowStrip({
  serverId,
  windows,
  selectedId,
  onScreen,
  onSelect,
}: {
  serverId: string;
  windows: FleetBrowserWindow[];
  selectedId: string | null;
  onScreen: boolean;
  onSelect: (windowId: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.strip}>
        {windows.map((window) => (
          <WindowCard
            key={window.id}
            serverId={serverId}
            window={window}
            selected={window.id === selectedId}
            onScreen={onScreen}
            onSelect={onSelect}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function WindowCard({
  serverId,
  window,
  selected,
  onScreen,
  onSelect,
}: {
  serverId: string;
  window: FleetBrowserWindow;
  selected: boolean;
  onScreen: boolean;
  onSelect: (windowId: string) => void;
}) {
  const { t } = useTranslation();
  const thumbnail = useFleetBrowserThumbnail({
    serverId,
    windowId: window.id,
    active: onScreen && window.reachable,
  });
  const status = describeFleetBrowserWindowStatus(window, t);
  const thumbnailSource = useMemo(
    () => (thumbnail ? { uri: `data:${thumbnail.mimeType};base64,${thumbnail.data}` } : null),
    [thumbnail],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const cardStyle = useMemo(
    () => (selected ? [styles.card, styles.cardSelected] : styles.card),
    [selected],
  );
  const handlePress = useCallback(() => onSelect(window.id), [onSelect, window.id]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={window.label}
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={cardStyle}
      testID={`fleet-browser-card-${window.id}`}
    >
      <View style={styles.cardThumbnail}>
        {thumbnailSource ? (
          <Image source={thumbnailSource} style={styles.cardImage} resizeMode="cover" />
        ) : null}
      </View>
      <Text style={styles.cardLabel} numberOfLines={1}>
        {window.label}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {status.variant === "success"
          ? `${window.host} · ${fleetBrowserKindLabel(window, t)}`
          : status.label}
      </Text>
    </PressHighlight>
  );
}

function WindowDetail({
  window,
  onScreen,
  actions,
  onOpenOverlay,
}: {
  window: FleetBrowserWindow;
  onScreen: boolean;
  actions: FleetBrowserActions;
  onOpenOverlay: (windowId: string, mode: "watch" | "control") => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [pending, setPending] = useState<"take" | "release" | "resume" | null>(null);
  const note = useRef("");
  const status = describeFleetBrowserWindowStatus(window, t);
  const userHasControl = window.control.owner === "user";
  const watchUrl = window.liveViewUrl ? fleetBrowserLiveViewUrl(window.liveViewUrl, "watch") : null;
  const page = [window.title, window.url].filter(Boolean).join(" — ");
  const windowId = window.id;
  const liveViewUrl = window.liveViewUrl;

  const run = useCallback(
    async (action: "take" | "release" | "resume") => {
      setPending(action);
      try {
        const result = await actions.control(
          windowId,
          action,
          action === "resume" ? note.current : undefined,
        );
        if (action === "take") {
          if (result.delivery !== "none") toast.show(t("panels.fleetBrowser.agentPaused"));
          onOpenOverlay(windowId, "control");
        } else {
          toast.show(
            action === "resume"
              ? t("panels.fleetBrowser.agentResumed")
              : t("panels.fleetBrowser.controlReturned"),
          );
        }
      } catch (error) {
        toast.error(
          t("panels.fleetBrowser.actionFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setPending(null);
      }
    },
    [actions, onOpenOverlay, t, toast, windowId],
  );
  const takeControl = useCallback(() => void run("take"), [run]);
  const handBack = useCallback(() => void run("resume"), [run]);
  const release = useCallback(() => void run("release"), [run]);
  const reopenControl = useCallback(
    () => onOpenOverlay(windowId, "control"),
    [onOpenOverlay, windowId],
  );
  const expand = useCallback(() => onOpenOverlay(windowId, "watch"), [onOpenOverlay, windowId]);
  const openLiveView = useCallback(() => {
    if (liveViewUrl) void openExternalUrl(liveViewUrl);
  }, [liveViewUrl]);
  const updateNote = useCallback((text: string) => {
    note.current = text;
  }, []);

  const closeWindow = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.fleetBrowser.closeConfirmTitle"),
        message: t("panels.fleetBrowser.closeConfirmMessage"),
        confirmLabel: t("panels.fleetBrowser.closeWindow"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await actions.close(windowId);
      } catch (error) {
        toast.error(
          t("panels.fleetBrowser.actionFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
  }, [actions, t, toast, windowId]);

  return (
    <View style={styles.detail} testID="fleet-browser-detail">
      <View style={styles.detailHeader}>
        <View style={styles.detailTitles}>
          <Text style={styles.detailLabel} numberOfLines={1}>
            {window.label}
          </Text>
          <Text style={styles.mutedSmall} numberOfLines={1}>
            {`${window.host} · ${fleetBrowserKindLabel(window, t)}${page ? ` · ${page}` : ""}`}
          </Text>
        </View>
        <StatusBadge
          label={status.label}
          variant={status.variant}
          size="xs"
          testID="fleet-browser-status"
        />
      </View>

      {/* Take control sits right below; the alert only says why. */}
      {window.handoff && !userHasControl ? (
        <Alert
          variant="warning"
          size="sm"
          title={t("panels.fleetBrowser.handoffTitle")}
          description={window.handoff.reason}
          testID="fleet-browser-handoff"
        />
      ) : null}

      <View style={styles.liveView} testID="fleet-browser-live-view">
        {watchUrl && onScreen ? (
          <FleetBrowserLiveView
            url={watchUrl}
            title={window.label}
            testID="fleet-browser-watch-frame"
          />
        ) : null}
        {watchUrl ? null : (
          <View style={styles.centerState}>
            <Text style={styles.mutedSmall}>{t("panels.fleetBrowser.liveViewUnavailable")}</Text>
          </View>
        )}
        {/* Watching never sends input: this layer keeps clicks and keys out of the stream. */}
        <View style={styles.liveViewShield} />
      </View>

      {userHasControl ? (
        <View style={styles.controlBox} testID="fleet-browser-user-control">
          <Text style={styles.bodyText}>{t("panels.fleetBrowser.youHaveControl")}</Text>
          <ThemedNoteInput
            style={styles.noteInput}
            placeholder={t("panels.fleetBrowser.notePlaceholder")}
            onChangeText={updateNote}
            multiline
            testID="fleet-browser-note"
          />
          <View style={styles.actionsRow}>
            <Button
              variant="default"
              size="sm"
              loading={pending === "resume"}
              onPress={handBack}
              testID="fleet-browser-hand-back"
            >
              {t("panels.fleetBrowser.handBack")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={pending === "release"}
              onPress={release}
              testID="fleet-browser-release"
            >
              {t("panels.fleetBrowser.release")}
            </Button>
            <Button variant="secondary" size="sm" onPress={reopenControl}>
              {t("panels.fleetBrowser.reopen")}
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.actionsRow}>
          <Button
            variant="default"
            size="sm"
            disabled={!window.reachable}
            loading={pending === "take"}
            onPress={takeControl}
            testID="fleet-browser-take-control"
          >
            {t("panels.fleetBrowser.takeControl")}
          </Button>
          <View style={styles.actionsSpacer} />
          <ToolbarButton
            label={t("panels.fleetBrowser.expand")}
            onPress={expand}
            disabled={!watchUrl}
            testID="fleet-browser-expand"
          >
            <ThemedMaximize size={16} />
          </ToolbarButton>
          {liveViewUrl ? (
            <ToolbarButton label={t("panels.fleetBrowser.openLiveView")} onPress={openLiveView}>
              <ThemedExternalLink size={16} />
            </ToolbarButton>
          ) : null}
          <ToolbarButton
            label={t("panels.fleetBrowser.closeWindow")}
            onPress={closeWindow}
            testID="fleet-browser-close"
          >
            <ThemedClose size={16} />
          </ToolbarButton>
        </View>
      )}
    </View>
  );
}

export const fleetBrowserPanelRegistration = definePanel("fleet_browser", {
  component: FleetBrowserPanel,
  presentation: fleetBrowserPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[4],
  },
  emptyTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  mutedSmall: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  strip: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  card: {
    width: 132,
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardSelected: {
    borderColor: theme.colors.accent,
  },
  cardThumbnail: {
    width: "100%",
    aspectRatio: LIVE_VIEW_ASPECT_RATIO,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  cardImage: {
    width: "100%",
    height: "100%",
  },
  cardLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  cardMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detail: {
    gap: theme.spacing[2],
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  detailTitles: {
    flex: 1,
    minWidth: 0,
  },
  detailLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  liveView: {
    width: "100%",
    aspectRatio: LIVE_VIEW_ASPECT_RATIO,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  liveViewShield: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  controlBox: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  noteInput: {
    minHeight: 56,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  actionsSpacer: {
    flex: 1,
  },
}));
