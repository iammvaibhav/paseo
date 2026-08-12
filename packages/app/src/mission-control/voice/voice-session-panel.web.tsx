import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  CommanderVoiceClient,
  type CommanderVoiceClientState,
  type CommanderVoiceServerFrame,
} from "./commander-voice-client";
import { createVoiceAudioSession, type VoiceAudioSession } from "./voice-audio";
import {
  appendTranscript,
  frameToTranscript,
  type TranscriptEntry,
  type TranscriptKind,
} from "./voice-transcript";

export interface CommanderVoicePanelProps {
  /** Normalized voice node URL (ws://host:port/ws). */
  url: string;
  onClose: () => void;
}

const STATUS_LABELS: Record<CommanderVoiceClientState | "mic", string> = {
  idle: "Disconnected",
  connecting: "Connecting to voice node…",
  ready: "Connected — speak to the Commander",
  closed: "Session ended",
  error: "Connection error",
  mic: "Microphone unavailable",
};

type StyleKey = Exclude<keyof typeof styles, "useVariants">;

const ENTRY_STYLE_BY_KIND: Record<TranscriptKind, StyleKey> = {
  heard: "entryHeard",
  spoken: "entrySpoken",
  announcement: "entryAnnouncement",
  system: "entrySystem",
};

const DOT_TONE_BY_STATE: Record<
  CommanderVoiceClientState,
  "dotConnecting" | "dotReady" | "dotError"
> = {
  idle: "dotConnecting",
  connecting: "dotConnecting",
  ready: "dotReady",
  closed: "dotConnecting",
  error: "dotError",
};

export function CommanderVoicePanel({ url, onClose }: CommanderVoicePanelProps): ReactElement {
  const clientRef = useRef<CommanderVoiceClient | null>(null);
  const audioRef = useRef<VoiceAudioSession | null>(null);
  const nextIdRef = useRef(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [clientState, setClientState] = useState<CommanderVoiceClientState>("idle");
  const [statusText, setStatusText] = useState(STATUS_LABELS.connecting);
  const [isMicOn, setIsMicOn] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  const pushEntry = useCallback((kind: TranscriptKind, text: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setTranscript((current) => appendTranscript(current, id, kind, text).entries);
  }, []);

  const handleStateChange = useCallback((state: CommanderVoiceClientState) => {
    setClientState(state);
    setStatusText(STATUS_LABELS[state]);
    if (state === "closed") {
      setIsMicOn(false);
    }
  }, []);

  useEffect(() => {
    const audio = createVoiceAudioSession();
    audioRef.current = audio;
    const client = new CommanderVoiceClient({
      url,
      handlers: {
        onFrame: (frame: CommanderVoiceServerFrame) => {
          const entry = frameToTranscript(frame);
          if (entry) {
            pushEntry(entry.kind, entry.text);
          }
        },
        onAudio: (pcm16) => audio.playPcm(pcm16),
        onStateChange: handleStateChange,
        onError: (message) => {
          setStatusText(message);
          pushEntry("system", message);
        },
      },
    });
    clientRef.current = client;
    client.connect();
    void audio
      .startMic((pcm16) => {
        client.sendAudio(pcm16);
      })
      .then(() => setIsMicOn(true))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatusText(STATUS_LABELS.mic);
        pushEntry("system", message);
      });
    return () => {
      client.close();
      audio.stop();
      clientRef.current = null;
      audioRef.current = null;
    };
  }, [handleStateChange, pushEntry, url]);

  const handleToggleMic = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (isMicOn) {
      audio.stopMic();
      setIsMicOn(false);
    } else {
      void audio
        .startMic((pcm16) => clientRef.current?.sendAudio(pcm16))
        .then(() => setIsMicOn(true))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatusText(STATUS_LABELS.mic);
          pushEntry("system", message);
        });
    }
  }, [isMicOn, pushEntry]);

  const handleAskUpdates = useCallback(() => {
    if (clientRef.current?.sendText("Any updates?")) {
      pushEntry("heard", "Any updates?");
    }
  }, [pushEntry]);

  const handleEnd = useCallback(() => {
    clientRef.current?.close();
    audioRef.current?.stop();
    setIsMicOn(false);
    onClose();
  }, [onClose]);

  const isReady = clientState === "ready";
  const dotTone: StyleProp<ViewStyle> = styles[DOT_TONE_BY_STATE[clientState]];

  const scrollTranscriptToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  const micButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      isMicOn && styles.buttonActive,
      pressed && styles.buttonPressed,
    ],
    [isMicOn],
  );

  const updatesButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      !isReady && styles.buttonDisabled,
      pressed && styles.buttonPressed,
    ],
    [isReady],
  );

  const endButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      styles.buttonEnd,
      pressed && styles.buttonPressed,
    ],
    [],
  );

  return (
    <View style={styles.container} testID="commander-voice-panel">
      <View style={styles.header}>
        <View style={[styles.dot, dotTone]} />
        <Text style={styles.title} numberOfLines={1}>
          Commander Voice
        </Text>
        <Text style={styles.statusText} numberOfLines={1}>
          {statusText}
        </Text>
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        onContentSizeChange={scrollTranscriptToEnd}
      >
        {transcript.map((entry) => (
          <Text key={entry.id} style={[styles.entry, styles[ENTRY_STYLE_BY_KIND[entry.kind]]]}>
            {entry.text}
          </Text>
        ))}
        {transcript.length === 0 ? (
          <Text style={styles.entryPlaceholder}>
            Talk to the Commander. It dispatches; the fleet works.
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.controls}>
        <Pressable
          onPress={handleToggleMic}
          style={micButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={isMicOn ? "Mute microphone" : "Unmute microphone"}
          testID="commander-voice-mic-toggle"
        >
          <Text style={styles.buttonLabel}>{isMicOn ? "Mute mic" : "Unmute mic"}</Text>
        </Pressable>
        <Pressable
          onPress={handleAskUpdates}
          disabled={!isReady}
          style={updatesButtonStyle}
          accessibilityRole="button"
          accessibilityLabel="Any updates?"
          testID="commander-voice-updates"
        >
          <Text style={styles.buttonLabel}>Any updates?</Text>
        </Pressable>
        <Pressable
          onPress={handleEnd}
          style={endButtonStyle}
          accessibilityRole="button"
          accessibilityLabel="End Commander Voice session"
          testID="commander-voice-end"
        >
          <Text style={styles.buttonLabel}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    backgroundColor: theme.colors.surface1,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    height: 220,
    flexShrink: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.foregroundMuted,
  },
  dotReady: {
    backgroundColor: theme.colors.success,
  },
  dotConnecting: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  dotError: {
    backgroundColor: theme.colors.destructive,
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
  statusText: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  transcript: {
    flexGrow: 0,
    maxHeight: 150,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  entry: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  entryHeard: {
    color: theme.colors.foreground,
  },
  entrySpoken: {
    color: theme.colors.accent,
  },
  entryAnnouncement: {
    color: theme.colors.success,
  },
  entrySystem: {
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    fontSize: theme.fontSize.xs,
  },
  entryPlaceholder: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  controls: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  button: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  buttonActive: {
    backgroundColor: theme.colors.accent,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonEnd: {
    marginLeft: "auto",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
