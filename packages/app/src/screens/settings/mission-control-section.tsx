import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";
import { SettingsTextArea } from "@/components/settings-textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const MISSION_CONTROL_NAMING_THEMES = [
  "mixed",
  "indian",
  "cartoon",
  "scientists",
  "astronauts",
  "mythology",
  "nature",
] as const;

const ThemedChevronDown = withUnistyles(ChevronDown);

const chevronMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.dropdownTrigger, pressed && styles.dropdownTriggerPressed];
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function hostMatchValue(host: HostProfile, hostname: string | null): string {
  return hostname ?? host.label;
}

interface DropdownRowOption<T extends string> {
  value: T;
  label: string;
}

function DropdownRow<T extends string>({
  title,
  hint,
  value,
  options,
  onSelect,
  testID,
  first = false,
}: {
  title: string;
  hint: string;
  value: T | null;
  options: readonly DropdownRowOption<T>[];
  onSelect: (value: T) => void;
  testID: string;
  first?: boolean;
}) {
  const selected = options.find((option) => option.value === value) ?? null;
  const handlers = useMemo(() => {
    const map: Record<string, () => void> = {};
    for (const option of options) {
      map[option.value] = () => onSelect(option.value);
    }
    return map;
  }, [onSelect, options]);
  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          testID={testID}
          style={dropdownTriggerStyle}
          accessibilityRole="button"
          accessibilityLabel={title}
        >
          <Text style={styles.dropdownTriggerText} numberOfLines={1}>
            {selected?.label ?? "None"}
          </Text>
          <ThemedChevronDown size={14} uniProps={chevronMutedMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220} scrollable maxHeight={320}>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              selected={option.value === value}
              onSelect={handlers[option.value]}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function TextRow({
  title,
  hint,
  value,
  onCommit,
  testID,
  isCompact,
  placeholder,
  first = false,
}: {
  title: string;
  hint: string;
  value: string | null;
  onCommit: (next: string | null) => void;
  testID: string;
  isCompact: boolean;
  placeholder?: string;
  first?: boolean;
}) {
  const draftRef = useRef<string | null>(null);
  const handleChange = useCallback((text: string) => {
    draftRef.current = text;
  }, []);
  const handleCommit = useCallback(() => {
    const draft = draftRef.current;
    draftRef.current = null;
    if (draft === null) {
      return;
    }
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === value) {
      return;
    }
    onCommit(next);
  }, [onCommit, value]);
  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <FormTextInput
        size={isCompact ? "md" : "sm"}
        initialValue={value ?? ""}
        resetKey={value ?? ""}
        onChangeText={handleChange}
        onSubmitEditing={handleCommit}
        onBlur={handleCommit}
        placeholder={placeholder}
        accessibilityLabel={title}
        testID={testID}
        style={styles.textInput}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function NumberRow({
  title,
  hint,
  value,
  onCommit,
  testID,
  isCompact,
  first = false,
}: {
  title: string;
  hint: string;
  value: number;
  onCommit: (next: number) => void;
  testID: string;
  isCompact: boolean;
  first?: boolean;
}) {
  const draftRef = useRef<string | null>(null);
  const handleChange = useCallback((text: string) => {
    draftRef.current = text.replace(/[^0-9]/g, "");
  }, []);
  const handleCommit = useCallback(() => {
    const raw = draftRef.current;
    draftRef.current = null;
    const parsed = parsePositiveInt(raw);
    if (parsed === null || parsed === value) {
      return;
    }
    onCommit(parsed);
  }, [onCommit, value]);
  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <FormTextInput
        size={isCompact ? "md" : "sm"}
        initialValue={String(value)}
        resetKey={String(value)}
        onChangeText={handleChange}
        onSubmitEditing={handleCommit}
        onBlur={handleCommit}
        keyboardType="number-pad"
        inputMode="numeric"
        accessibilityLabel={title}
        testID={testID}
        style={styles.numberInput}
      />
    </View>
  );
}

/** Ask/Auto is toggled in the Mission Control header; settings mirrors it read-only. */
function ModeRow({ mode }: { mode: MissionControlMode }) {
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Approval mode</Text>
        <Text style={settingsStyles.rowHint}>
          Set in the Mission Control header. Auto mode sends proposals immediately; destructive
          actions always ask.
        </Text>
      </View>
      <StatusBadge label={mode === "auto" ? "Auto" : "Ask"} />
    </View>
  );
}

/**
 * Central Mission Control settings: fleet policy stored on the commander
 * host. The host-page card keeps only per-host keys (enabled, alias); every
 * central key is edited here.
 */
export function MissionControlSection(): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);
  const { hostServerId, resolvingHost, config, isLoading, patchConfig } =
    useMissionControlCentralConfig();
  const [error, setError] = useState<string | null>(null);

  const hostnameByServerId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [serverId, session] of Object.entries(sessions)) {
      map.set(serverId, session.serverInfo?.hostname ?? null);
    }
    return map;
  }, [sessions]);

  const hostOptions = useMemo(
    () =>
      hosts.map((host) => ({
        value: hostMatchValue(host, hostnameByServerId.get(host.serverId) ?? null),
        label: host.label,
      })),
    [hostnameByServerId, hosts],
  );
  const namingThemeOptions = useMemo(
    () =>
      MISSION_CONTROL_NAMING_THEMES.map((theme) => ({
        value: theme,
        label: theme,
      })),
    [],
  );

  const evaluationScopeOptions = useMemo<DropdownRowOption<"commander" | "all">[]>(
    () => [
      { value: "commander", label: "Commander-spawned only" },
      { value: "all", label: "All agents" },
    ],
    [],
  );

  const patch = useCallback(
    async (updates: Partial<MissionControlCentralConfig>) => {
      try {
        await patchConfig(updates);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [patchConfig],
  );

  const handleCommanderHostSelect = useCallback(
    (next: string) => void patch({ commanderHost: next }),
    [patch],
  );
  const handleCommanderModelCommit = useCallback(
    (next: string | null) => void patch({ commanderModel: next }),
    [patch],
  );
  const handleCommanderInstructionsChange = useCallback(
    (next: string) => void patch({ commanderInstructions: next }),
    [patch],
  );
  const handleVerifierModelCommit = useCallback(
    (next: string | null) => void patch({ verifierModel: next }),
    [patch],
  );
  const handleVerifierConcurrencyCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ verifierConcurrency: next });
      }
    },
    [patch],
  );
  const handleEvaluationScopeSelect = useCallback(
    (next: "commander" | "all") => void patch({ evaluationScope: next }),
    [patch],
  );
  const handleRetentionCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ retentionDays: next });
      }
    },
    [patch],
  );
  const handleNamingThemeSelect = useCallback(
    (next: string) => void patch({ namingTheme: next }),
    [patch],
  );
  const handleHideAgentNamesChange = useCallback(
    (next: boolean) => void patch({ hideAgentNames: next }),
    [patch],
  );
  const handleDefaultDispatchHostSelect = useCallback(
    (next: string) => void patch({ defaultDispatchHost: next }),
    [patch],
  );
  const handleNudgeSecondsCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ nudgeSeconds: next });
      }
    },
    [patch],
  );
  const handleEscalateSecondsCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ escalateSeconds: next });
      }
    },
    [patch],
  );

  if (resolvingHost || isLoading) {
    return (
      <View style={styles.centerState} testID="mission-control-settings-loading">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  if (!config || !hostServerId) {
    return (
      <View style={styles.centerState} testID="mission-control-settings-no-host">
        <Text style={styles.centerStateTitle}>No host connected</Text>
        <Text style={styles.centerStateHint}>
          Connect a host to edit fleet Mission Control settings.
        </Text>
      </View>
    );
  }

  return (
    <View testID="mission-control-settings">
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <SettingsSection title="Approval">
        <View style={settingsStyles.card}>
          <ModeRow mode={config.mode} />
        </View>
      </SettingsSection>

      <SettingsSection title="Commander">
        <View style={settingsStyles.card}>
          <DropdownRow
            title="Commander host"
            hint="The host that runs the fleet Commander. None lets the current host designate itself."
            value={config.commanderHost}
            options={hostOptions}
            onSelect={handleCommanderHostSelect}
            testID="mission-control-settings-commander-host"
            first
          />
          <TextRow
            title="Commander model"
            hint="Provider/model override; empty uses the host default model."
            value={config.commanderModel}
            onCommit={handleCommanderModelCommit}
            testID="mission-control-settings-commander-model"
            isCompact={isCompact}
            placeholder="Host default"
          />
        </View>
        <SettingsTextArea
          accessibilityLabel="Commander instructions"
          value={config.commanderInstructions}
          onChangeText={handleCommanderInstructionsChange}
          placeholder="The Commander contract..."
          testID="mission-control-settings-commander-instructions"
          style={styles.instructionsInput}
        />
      </SettingsSection>

      <SettingsSection title="Verifier">
        <View style={settingsStyles.card}>
          <TextRow
            title="Verifier model"
            hint="Provider/model override; empty resolves to the task model role."
            value={config.verifierModel}
            onCommit={handleVerifierModelCommit}
            testID="mission-control-settings-verifier-model"
            isCompact={isCompact}
            placeholder="Task model"
            first
          />
          <NumberRow
            title="Verifier concurrency"
            hint="Concurrent verifier agents per host."
            value={config.verifierConcurrency}
            onCommit={handleVerifierConcurrencyCommit}
            testID="mission-control-settings-verifier-concurrency"
            isCompact={isCompact}
          />
          <DropdownRow
            title="Evaluation scope"
            hint="Which agents the verifier audits."
            value={config.evaluationScope}
            options={evaluationScopeOptions}
            onSelect={handleEvaluationScopeSelect}
            testID="mission-control-settings-evaluation-scope"
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Fleet">
        <View style={settingsStyles.card}>
          <NumberRow
            title="Feed retention"
            hint="Days the Mission Control feed keeps events."
            value={config.retentionDays}
            onCommit={handleRetentionCommit}
            testID="mission-control-settings-retention"
            isCompact={isCompact}
            first
          />
          <DropdownRow
            title="Agent naming theme"
            hint="Name pool the daemon draws agent names from."
            value={config.namingTheme}
            options={namingThemeOptions}
            onSelect={handleNamingThemeSelect}
            testID="mission-control-settings-naming-theme"
          />
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Hide agent names</Text>
              <Text style={settingsStyles.rowHint}>Show titles only; name chips stay hidden.</Text>
            </View>
            <Switch
              value={config.hideAgentNames}
              onValueChange={handleHideAgentNamesChange}
              accessibilityLabel="Hide agent names"
              testID="mission-control-settings-hide-agent-names"
            />
          </View>
          <DropdownRow
            title="Default dispatch host"
            hint="Host the Commander routes new work to when no host is named."
            value={config.defaultDispatchHost}
            options={hostOptions}
            onSelect={handleDefaultDispatchHostSelect}
            testID="mission-control-settings-default-dispatch-host"
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Stall detection">
        <View style={settingsStyles.card}>
          <NumberRow
            title="Nudge after"
            hint="Seconds of silence before the agent is nudged to report."
            value={config.nudgeSeconds}
            onCommit={handleNudgeSecondsCommit}
            testID="mission-control-settings-nudge-seconds"
            isCompact={isCompact}
            first
          />
          <NumberRow
            title="Escalate after"
            hint="Seconds of silence before the run escalates to Needs you."
            value={config.escalateSeconds}
            onCommit={handleEscalateSecondsCommit}
            testID="mission-control-settings-escalate-seconds"
            isCompact={isCompact}
          />
        </View>
      </SettingsSection>

      {!hostOptions.some((option) => option.value === config.commanderHost) &&
      config.commanderHost !== null ? (
        <Text style={styles.staleValue}>
          Commander host “{config.commanderHost}” is not one of the connected hosts.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  centerStateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  centerStateHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[3],
  },
  staleValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[4],
  },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    maxWidth: 220,
  },
  dropdownTriggerPressed: {
    opacity: 0.85,
  },
  dropdownTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  textInput: {
    width: 180,
  },
  numberInput: {
    width: 88,
  },
  instructionsInput: {
    marginTop: theme.spacing[3],
  },
}));
