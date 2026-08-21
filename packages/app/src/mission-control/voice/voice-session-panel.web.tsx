import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import {
  CommanderVoiceClient,
  type CommanderVoiceClientState,
  type CommanderVoiceInitOptions,
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

const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

/** Live voices verified against the API (Asteria is rejected with close 1007). */
const VOICE_OPTIONS = [
  "Puck",
  "Charon",
  "Kore",
  "Zephyr",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Nova",
] as const;

const THINKING_OPTIONS = ["minimal", "low", "medium", "high"] as const;

function OptionChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

export function CommanderVoicePanel({ url, onClose }: CommanderVoicePanelProps): ReactElement {
  const clientRef = useRef<CommanderVoiceClient | null>(null);
  const audioRef = useRef<VoiceAudioSession | null>(null);
  const isSuppressedRef = useRef(false);
  const nextIdRef = useRef(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [clientState, setClientState] = useState<CommanderVoiceClientState>("idle");
  const [statusText, setStatusText] = useState(STATUS_LABELS.connecting);
  const [isMicOn, setIsMicOn] = useState(false);
  const [inputText, setInputText] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);
  // Mission Control verbose is the debug gate: the advanced session options
  // below are visible only while it is ON (per-device flag, same as the feed).
  const [verbose] = useMissionControlVerbose();
  // Advanced session options (verbose-only): voice, thinking level, VAD.
  // Applied at client construction — they take effect on the next session.
  const [voiceName, setVoiceName] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<
    CommanderVoiceInitOptions["thinkingLevel"] | ""
  >("");
  const [vadStart, setVadStart] = useState<"START_SENSITIVITY_HIGH" | "START_SENSITIVITY_LOW" | "">(
    "",
  );
  const [vadEnd, setVadEnd] = useState<"END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | "">("");
  const [vadSilence, setVadSilence] = useState("");
  const sessionOptionsRef = useRef<CommanderVoiceInitOptions>({});
  sessionOptionsRef.current = {
    ...(voiceName ? { voiceName } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    vad: {
      ...(vadStart ? { startOfSpeechSensitivity: vadStart } : {}),
      ...(vadEnd ? { endOfSpeechSensitivity: vadEnd } : {}),
      ...(vadSilence.trim() ? { silenceDurationMs: Number(vadSilence) } : {}),
    },
  };
  // Chip lists are memoized so every onPress is a stable identity (the
  // eslint react-perf rule rejects inline closures in JSX props).
  const voiceChips = useMemo(
    () => [
      { label: "Default", selected: voiceName === "", onPress: () => setVoiceName("") },
      ...VOICE_OPTIONS.map((voice) => ({
        label: voice,
        selected: voiceName === voice,
        onPress: () => setVoiceName(voice),
      })),
    ],
    [voiceName],
  );
  const thinkingChips = useMemo(
    () => [
      { label: "Default", selected: thinkingLevel === "", onPress: () => setThinkingLevel("") },
      ...THINKING_OPTIONS.map((level) => ({
        label: level,
        selected: thinkingLevel === level,
        onPress: () => setThinkingLevel(level),
      })),
    ],
    [thinkingLevel],
  );
  const vadStartChips = useMemo(
    () =>
      (["", "START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"] as const).map((sensitivity) => ({
        label:
          sensitivity === ""
            ? "Start: default"
            : `Start: ${sensitivity.endsWith("HIGH") ? "high" : "low"}`,
        selected: vadStart === sensitivity,
        onPress: () => setVadStart(sensitivity),
      })),
    [vadStart],
  );
  const vadEndChips = useMemo(
    () =>
      (["", "END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"] as const).map((sensitivity) => ({
        label:
          sensitivity === ""
            ? "End: default"
            : `End: ${sensitivity.endsWith("HIGH") ? "high" : "low"}`,
        selected: vadEnd === sensitivity,
        onPress: () => setVadEnd(sensitivity),
      })),
    [vadEnd],
  );
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
          if (frame.type === "interrupt") {
            audioRef.current?.flushPlayback();
          } else if (frame.type === "turnComplete") {
            isSuppressedRef.current = false;
          }
          const entry = frameToTranscript(frame);
          if (entry) {
            pushEntry(entry.kind, entry.text);
          }
        },
        onAudio: (pcm16) => {
          if (!isSuppressedRef.current) {
            audio.playPcm(pcm16);
          }
        },
        onError: (message) => {
          setStatusText(message);
          pushEntry("system", message);
        },
      },
      sessionOptions: sessionOptionsRef.current,
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

  const handleStop = useCallback(() => {
    isSuppressedRef.current = true;
    audioRef.current?.flushPlayback();
  }, []);

  const handleSendInput = useCallback(() => {
    const trimmed = inputText.trim();
    if (!trimmed) {
      return;
    }
    if (clientRef.current?.sendText(trimmed)) {
      pushEntry("heard", trimmed);
      setInputText("");
    }
  }, [inputText, pushEntry]);

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
  const stopButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      styles.buttonStop,
      !isReady && styles.buttonDisabled,
      pressed && styles.buttonPressed,
    ],
    [isReady],
  );

  const sendButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      (!isReady || !inputText.trim()) && styles.buttonDisabled,
      pressed && styles.buttonPressed,
    ],
    [isReady, inputText],
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
    <View
      style={[styles.container, verbose ? styles.containerAdvanced : null]}
      testID="commander-voice-panel"
    >
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
      <View style={styles.inputRow}>
        <ThemedTextInput
          style={styles.input}
          placeholder="Type context, a UID, or an instruction…"
          value={inputText}
          onChangeText={setInputText}
          onSubmitEditing={handleSendInput}
          editable={isReady}
          returnKeyType="send"
          accessibilityLabel="Type context, a UID, or an instruction"
          testID="commander-voice-input"
        />
        <Pressable
          onPress={handleSendInput}
          disabled={!isReady || !inputText.trim()}
          style={sendButtonStyle}
          accessibilityRole="button"
          accessibilityLabel="Send text"
          testID="commander-voice-send"
        >
          <Text style={styles.buttonLabel}>Send</Text>
        </Pressable>
      </View>
      {verbose ? (
        <View style={styles.advanced} testID="commander-voice-advanced">
          <Text style={styles.advancedTitle}>Advanced (applies next session)</Text>
          <Text style={styles.advancedLabel}>Voice</Text>
          <View style={styles.chipRow}>
            {voiceChips.map((chip) => (
              <OptionChip
                key={chip.label}
                label={chip.label}
                selected={chip.selected}
                onPress={chip.onPress}
              />
            ))}
          </View>
          <Text style={styles.advancedLabel}>Thinking level</Text>
          <View style={styles.chipRow}>
            {thinkingChips.map((chip) => (
              <OptionChip
                key={chip.label}
                label={chip.label}
                selected={chip.selected}
                onPress={chip.onPress}
              />
            ))}
          </View>
          <Text style={styles.advancedLabel}>VAD</Text>
          <View style={styles.chipRow}>
            {vadStartChips.map((chip) => (
              <OptionChip
                key={chip.label}
                label={chip.label}
                selected={chip.selected}
                onPress={chip.onPress}
              />
            ))}
            {vadEndChips.map((chip) => (
              <OptionChip
                key={chip.label}
                label={chip.label}
                selected={chip.selected}
                onPress={chip.onPress}
              />
            ))}
          </View>
          <View style={styles.chipRow}>
            <Text style={styles.advancedLabel}>Silence (ms)</Text>
            <ThemedTextInput
              style={styles.silenceInput}
              value={vadSilence}
              onChangeText={setVadSilence}
              placeholder="default"
              keyboardType="numeric"
              accessibilityLabel="VAD silence duration in milliseconds"
              testID="commander-voice-vad-silence"
            />
          </View>
        </View>
      ) : null}
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
          onPress={handleStop}
          disabled={!isReady}
          style={stopButtonStyle}
          accessibilityRole="button"
          accessibilityLabel="Stop playback"
          testID="commander-voice-stop"
        >
          <Text style={[styles.buttonLabel, styles.buttonStopLabel]}>Stop</Text>
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
    height: 260,
    flexShrink: 0,
  },
  containerAdvanced: {
    height: 520,
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
  inputRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  input: {
    flex: 1,
    height: 32,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
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
  buttonStop: {
    borderColor: theme.colors.destructive,
  },
  buttonStopLabel: {
    color: theme.colors.destructive,
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
  advanced: {
    gap: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
  advancedTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  advancedLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    alignSelf: "center",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    alignItems: "center",
  },
  chip: {
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  chipSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  chipLabelSelected: {
    color: theme.colors.background,
  },
  silenceInput: {
    width: 96,
    height: 26,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
