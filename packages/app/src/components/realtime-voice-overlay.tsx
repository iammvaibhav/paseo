import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Square } from "lucide-react-native";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { useVoiceTelemetry } from "@/contexts/voice-context";
import { VolumeMeter } from "./volume-meter";

type VoiceSendBehavior = "interrupt" | "queue";

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  sendBehavior: VoiceSendBehavior;
  onToggleMute: () => void;
  onSendBehaviorChange: (sendBehavior: VoiceSendBehavior) => void | Promise<void>;
  onStop: () => void;
}

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  sendBehavior,
  onToggleMute,
  onSendBehaviorChange,
  onStop,
}: RealtimeVoiceOverlayProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const muteButtonStyle = useMemo(
    () => [
      styles.actionButton,
      isMuted ? styles.muteButtonMuted : styles.muteButton,
      isSwitching ? styles.buttonDisabled : undefined,
    ],
    [isMuted, isSwitching],
  );
  const stopButtonStyle = useMemo(
    () => [styles.actionButton, styles.stopButton, isSwitching ? styles.buttonDisabled : undefined],
    [isSwitching],
  );
  const sendBehaviorOptions = useMemo(
    () => [
      {
        value: "interrupt" as const,
        label: t("settings.general.defaultSend.options.interrupt"),
      },
      {
        value: "queue" as const,
        label: t("settings.general.defaultSend.options.queue"),
      },
    ],
    [t],
  );

  return (
    <View style={styles.container}>
      <View style={styles.meterContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
        />
      </View>

      <View style={styles.modeContainer}>
        <SegmentedControl
          size="sm"
          value={sendBehavior}
          onValueChange={onSendBehaviorChange}
          options={sendBehaviorOptions}
        />
      </View>

      <View style={styles.actionsContainer}>
        <Pressable
          onPress={onToggleMute}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={
            isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute")
          }
          style={muteButtonStyle}
        >
          {isMuted ? (
            <MicOff size={theme.iconSize.lg} color={theme.colors.palette.white} strokeWidth={2.5} />
          ) : (
            <Mic size={theme.iconSize.lg} color={theme.colors.foreground} strokeWidth={2.5} />
          )}
        </Pressable>

        <Pressable
          onPress={onStop}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={t("realtimeVoice.actions.stop")}
          style={stopButtonStyle}
        >
          {isSwitching ? (
            <LoadingSpinner size="small" color={theme.colors.palette.white} />
          ) : (
            <Square
              size={theme.iconSize.lg}
              color={theme.colors.palette.white}
              fill={theme.colors.palette.white}
              strokeWidth={2.5}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    minHeight: FOOTER_HEIGHT,
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    gap: theme.spacing[2],
  },
  meterContainer: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  modeContainer: {
    flexShrink: 0,
  },
  actionsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: OVERLAY_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  muteButton: {
    backgroundColor: theme.colors.muted,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.destructive,
  },
  stopButton: {
    backgroundColor: theme.colors.destructive,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
