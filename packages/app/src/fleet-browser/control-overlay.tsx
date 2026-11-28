import { useCallback, useMemo, useRef, useState } from "react";
import { Modal, Text, View } from "react-native";
import { Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FleetBrowserWindow } from "@getpaseo/protocol/fleet-browser/types";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { useGlobalOverlayLayer } from "@/lib/overlay-root";
import { SPACING, type Theme } from "@/styles/theme";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { describeFleetBrowserWindowStatus } from "./window-status";
import { FleetBrowserLiveView } from "./live-view";
import { fleetBrowserLiveViewUrl } from "./live-view/types";
import type { FleetBrowserActions } from "./use-fleet-browser-actions";

// The live view at window size. Watching keeps the view-only stream; while the
// user has control the stream takes their mouse and keyboard, and the footer
// hands the window back. Minimize keeps control with the user.

const ThemedMinimize = withUnistyles(Minimize2, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedNoteInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export function FleetBrowserControlOverlay({
  window,
  mode,
  actions,
  onClose,
}: {
  window: FleetBrowserWindow;
  mode: "watch" | "control";
  actions: FleetBrowserActions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const modalLayer = useGlobalOverlayLayer("modal", isWeb);
  const [pending, setPending] = useState<"take" | "release" | "resume" | null>(null);
  const note = useRef("");
  const status = describeFleetBrowserWindowStatus(window, t);
  const url = window.liveViewUrl ? fleetBrowserLiveViewUrl(window.liveViewUrl, mode) : null;

  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  // Escape with focus in Paseo; with focus in the live view, keys go to the remote browser.
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape"],
    active: isWeb,
    layer: modalLayer,
    onKeyDown: handleKeyDown,
  });

  const run = useCallback(
    async (action: "take" | "release" | "resume") => {
      setPending(action);
      try {
        const result = await actions.control(
          window.id,
          action,
          action === "resume" ? note.current : undefined,
        );
        if (action === "take") {
          if (result.delivery !== "none") toast.show(t("panels.fleetBrowser.agentPaused"));
          return;
        }
        toast.show(
          action === "resume"
            ? t("panels.fleetBrowser.agentResumed")
            : t("panels.fleetBrowser.controlReturned"),
        );
        onClose();
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
    [actions, onClose, t, toast, window.id],
  );
  const takeControl = useCallback(() => void run("take"), [run]);
  const handBack = useCallback(() => void run("resume"), [run]);
  const release = useCallback(() => void run("release"), [run]);
  const updateNote = useCallback((text: string) => {
    note.current = text;
  }, []);

  const layerStyle = useMemo(
    () => [
      styles.layer,
      {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
      },
    ],
    [insets.bottom, insets.left, insets.right, insets.top],
  );

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <WindowChromeRootRegion corners="top-left">
        <View ref={setOverlayScope} style={styles.root} testID="fleet-browser-overlay">
          <View style={styles.backdrop} />
          <View style={layerStyle}>
            <OverlayHeader
              label={window.label}
              statusLabel={status.label}
              statusVariant={status.variant}
              minimizeLabel={t("panels.fleetBrowser.minimize")}
              onMinimize={onClose}
            />
            <View style={styles.body}>
              <View style={styles.frame} testID="fleet-browser-overlay-frame">
                {url ? (
                  <FleetBrowserLiveView
                    key={mode}
                    url={url}
                    title={window.label}
                    testID={
                      mode === "control"
                        ? "fleet-browser-control-frame"
                        : "fleet-browser-watch-frame-expanded"
                    }
                  />
                ) : null}
                {mode === "watch" ? <View style={styles.shield} /> : null}
              </View>
              {mode === "control" ? (
                <View style={styles.footer}>
                  <ThemedNoteInput
                    style={styles.noteInput}
                    placeholder={t("panels.fleetBrowser.notePlaceholder")}
                    onChangeText={updateNote}
                    testID="fleet-browser-overlay-note"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    loading={pending === "release"}
                    onPress={release}
                    testID="fleet-browser-overlay-release"
                  >
                    {t("panels.fleetBrowser.release")}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    loading={pending === "resume"}
                    onPress={handBack}
                    testID="fleet-browser-overlay-hand-back"
                  >
                    {t("panels.fleetBrowser.handBack")}
                  </Button>
                </View>
              ) : (
                <View style={styles.footer}>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={!window.reachable}
                    loading={pending === "take"}
                    onPress={takeControl}
                    testID="fleet-browser-overlay-take-control"
                  >
                    {t("panels.fleetBrowser.takeControl")}
                  </Button>
                </View>
              )}
            </View>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
}

function OverlayHeader({
  label,
  statusLabel,
  statusVariant,
  minimizeLabel,
  onMinimize,
}: {
  label: string;
  statusLabel: string;
  statusVariant: StatusBadgeVariant;
  minimizeLabel: string;
  onMinimize: () => void;
}) {
  return (
    <WindowChromeSafeArea placement="inline" horizontalPadding={SPACING[4]} style={styles.header}>
      <TitlebarDragRegion />
      <Text style={styles.title} numberOfLines={1}>
        {label}
      </Text>
      <StatusBadge label={statusLabel} variant={statusVariant} size="xs" />
      <View style={styles.headerSpacer} />
      <View style={styles.headerAction}>
        <ToolbarButton
          label={minimizeLabel}
          onPress={onMinimize}
          testID="fleet-browser-overlay-minimize"
        >
          <ThemedMinimize size={16} />
        </ToolbarButton>
      </View>
    </WindowChromeSafeArea>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  backdrop: {
    position: "absolute",
    inset: 0,
    backgroundColor: theme.glass?.cover ?? theme.colors.surface0,
    ...(theme.glass ? { backdropFilter: theme.glass.floatingBackdropFilter } : null),
  },
  layer: {
    position: "absolute",
    inset: 0,
  },
  // As tall as the app's own header row, so it clears the traffic lights and the
  // drag strips of the headers underneath (an iframe gets no no-drag override).
  header: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerSpacer: {
    flex: 1,
  },
  // Above the absolute drag overlay, so Electron does not take its clicks.
  headerAction: {
    position: "relative",
    zIndex: 1,
  },
  body: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  frame: {
    flex: 1,
    minHeight: 0,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  shield: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  noteInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
