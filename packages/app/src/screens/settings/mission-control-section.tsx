import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";
import { Button } from "@/components/ui/button";
import { useClearViewPoint } from "@/mission-control/clear-view";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import { useAppSettings } from "@/hooks/use-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { AGENT_MODES } from "@getpaseo/protocol/agent-modes";
import type { RoutingConfig, RoutingSecretKey } from "@getpaseo/protocol/routing";
import { useFetchQuery } from "@/data/query";
import type { ResolvedMissionControlCentralConfig } from "@/mission-control/central-config-resolver";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
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

function hostMatchValue(
  host: HostProfile,
  hostname: string | null,
  hostAlias: string | null,
): string {
  return hostAlias ?? hostname ?? host.label;
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

function NumberRow({
  title,
  hint,
  value,
  onCommit,
  testID,
  isCompact,
  first = false,
  disabled = false,
}: {
  title: string;
  hint: string;
  value: number;
  onCommit: (next: number) => void;
  testID: string;
  isCompact: boolean;
  first?: boolean;
  disabled?: boolean;
}): ReactElement {
  const draftRef = useRef<string | null>(null);
  const handleChange = useCallback((text: string) => {
    draftRef.current = text.replace(/[^0-9]/g, "");
  }, []);
  const handleCommit = useCallback(() => {
    if (disabled) {
      return;
    }
    const raw = draftRef.current;
    draftRef.current = null;
    const parsed = parsePositiveInt(raw);
    if (parsed === null || parsed === value) {
      return;
    }
    onCommit(parsed);
  }, [disabled, onCommit, value]);
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={[settingsStyles.rowTitle, disabled && styles.disabledText]}>{title}</Text>
        <Text style={[settingsStyles.rowHint, disabled && styles.disabledText]}>{hint}</Text>
      </View>
      <FormTextInput
        size={isCompact ? "md" : "sm"}
        initialValue={String(value)}
        onChangeText={handleChange}
        onBlur={handleCommit}
        keyboardType="number-pad"
        inputMode="numeric"
        editable={!disabled}
        accessibilityLabel={title}
        accessibilityState={accessibilityState}
        testID={testID}
        style={styles.numberInput}
      />
    </View>
  );
}

/**
 * Central-config free-text row (same commit flow as NumberRow). Empty input
 * commits null for nullable keys (e.g. hindsightUrl: empty = memory disabled)
 * and skips the patch for non-nullable keys (write bank keeps its default).
 */
function TextRow({
  title,
  hint,
  value,
  onCommit,
  testID,
  isCompact,
  first = false,
  nullable = false,
}: {
  title: string;
  hint: string;
  value: string | null;
  onCommit: (next: string | null) => void;
  testID: string;
  isCompact: boolean;
  first?: boolean;
  nullable?: boolean;
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
    if (trimmed === (value ?? "")) {
      return;
    }
    onCommit(trimmed === "" && nullable ? null : trimmed);
  }, [nullable, onCommit, value]);
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
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={title}
        testID={testID}
        style={styles.textInput}
      />
    </View>
  );
}

interface VerboseRowProps {
  value: boolean;
  onChange: () => void;
}

function VerboseRow({ value, onChange }: VerboseRowProps) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.missionControl.verbose")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.missionControl.verboseHint")}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel="Verbose mode"
        testID="mission-control-settings-verbose"
      />
    </View>
  );
}

interface ActionRowProps {
  title: string;
  hint: string;
  buttonLabel: string;
  onPress: () => void;
  variant?: "default" | "secondary" | "destructive" | "outline" | "ghost";
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  testID: string;
  first?: boolean;
}

function ActionRow({
  title,
  hint,
  buttonLabel,
  onPress,
  variant = "secondary",
  destructive = false,
  disabled = false,
  loading = false,
  testID,
  first = false,
}: ActionRowProps) {
  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <Button
        variant={destructive ? "destructive" : variant}
        size="sm"
        onPress={onPress}
        disabled={disabled || loading}
        loading={loading}
        testID={testID}
      >
        {buttonLabel}
      </Button>
    </View>
  );
}

/**
 * Central Mission Control settings: fleet policy stored on the commander
 * host. The host-page card keeps only per-host keys (enabled, alias); every
 * central key is edited here.
 */
export function MissionControlSection(): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);
  const { hostServerId, resolvingHost, config, isLoading, patchConfig } =
    useMissionControlCentralConfig();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { updateSettings } = useAppSettings();
  const [verbose, toggleVerbose] = useMissionControlVerbose();
  const { setClearViewPoint } = useClearViewPoint();

  const hostnameByServerId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [serverId, session] of Object.entries(sessions)) {
      map.set(serverId, session.serverInfo?.hostname ?? null);
    }
    return map;
  }, [sessions]);

  const hostAliasByServerId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [serverId, session] of Object.entries(sessions)) {
      map.set(serverId, session.serverInfo?.missionControlHostAlias ?? null);
    }
    return map;
  }, [sessions]);

  const hostOptions = useMemo(
    () =>
      hosts.map((host) => ({
        value: hostMatchValue(
          host,
          hostnameByServerId.get(host.serverId) ?? null,
          hostAliasByServerId.get(host.serverId) ?? null,
        ),
        label: host.label,
      })),
    [hostAliasByServerId, hostnameByServerId, hosts],
  );
  const routingHosts = useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        label: hostAliasByServerId.get(host.serverId) ?? host.label,
      })),
    [hostAliasByServerId, hosts],
  );

  const namingThemeOptions = useMemo(
    () =>
      MISSION_CONTROL_NAMING_THEMES.map((theme) => ({
        value: theme,
        label: theme,
      })),
    [],
  );

  const patch = useCallback(
    async (updates: Partial<MissionControlCentralConfig>) => {
      try {
        await patchConfig(updates);
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        // Never silent: a failed central-config write (commander host
        // unreachable after forwarding, or a rejected patch) must surface as
        // a toast AND the inline error above.
        toast.error(message);
      }
    },
    [patchConfig, toast],
  );

  const handleToggleVerbose = useCallback(() => {
    toggleVerbose();
    void updateSettings({ missionControlVerbose: !verbose });
  }, [toggleVerbose, updateSettings, verbose]);

  const handleClearView = useCallback(() => {
    setClearViewPoint(Date.now());
    toast.show("View cleared", { testID: "mission-control-clear-view-toast" });
  }, [setClearViewPoint, toast]);

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
  const handleTrackSubagentsChange = useCallback(
    (next: boolean) => void patch({ trackSubagents: next }),
    [patch],
  );
  const handleDefaultDispatchHostSelect = useCallback(
    (next: string) => void patch({ defaultDispatchHost: next }),
    [patch],
  );
  const handleStatusNudgeSecondsCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ statusNudgeSeconds: next });
      }
    },
    [patch],
  );
  const handleSilenceNudgeSecondsCommit = useCallback(
    (next: number | null) => {
      if (next !== null) {
        void patch({ silenceNudgeSeconds: next });
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
  const handleDormantTurnSecondsCommit = useCallback(
    (next: number) => {
      if (next !== null) {
        void patch({ dormantTurnSeconds: next });
      }
    },
    [patch],
  );
  const handleStallDetectionEnabledChange = useCallback(
    (next: boolean) => void patch({ stallDetectionEnabled: next }),
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

      <SettingsSection title="Display">
        <View style={settingsStyles.card}>
          <VerboseRow value={verbose} onChange={handleToggleVerbose} />
        </View>
      </SettingsSection>

      <SettingsSection title="Actions">
        <View style={settingsStyles.card}>
          <ActionRow
            title={t("settings.missionControl.clearView")}
            hint={t("settings.missionControl.clearViewHint")}
            buttonLabel={t("settings.missionControl.clearView")}
            onPress={handleClearView}
            testID="mission-control-settings-clear-view"
            first
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
            hint="Host new work goes to when the ask names no host."
            value={config.defaultDispatchHost}
            options={hostOptions}
            onSelect={handleDefaultDispatchHostSelect}
            testID="mission-control-settings-default-dispatch-host"
          />
        </View>
      </SettingsSection>

      <RoutingSettings config={config} hosts={routingHosts} patch={patch} isCompact={isCompact} />

      <SettingsSection title="Lifecycle tracking">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Subagents</Text>
              <Text style={settingsStyles.rowHint}>
                Lifecycle cards for agents spawned by other agents.
              </Text>
            </View>
            <Switch
              value={config.trackSubagents}
              onValueChange={handleTrackSubagentsChange}
              accessibilityLabel="Track subagents"
              testID="mission-control-settings-track-subagents"
            />
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Stall detection">
        <View style={settingsStyles.card}>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Enabled</Text>
              <Text style={settingsStyles.rowHint}>
                When off, Mission Control never asks agents for status updates.
              </Text>
            </View>
            <Switch
              value={config.stallDetectionEnabled}
              onValueChange={handleStallDetectionEnabledChange}
              accessibilityLabel="Stall detection enabled"
              testID="mission-control-settings-stall-detection-enabled"
            />
          </View>
          <NumberRow
            title="Silence nudge"
            hint="Seconds of total silence (no output) before the agent is asked for a status."
            value={config.silenceNudgeSeconds}
            onCommit={handleSilenceNudgeSecondsCommit}
            testID="mission-control-settings-silence-nudge-seconds"
            isCompact={isCompact}
            disabled={!config.stallDetectionEnabled}
          />
          <NumberRow
            title="Status nudge"
            hint="Seconds without a status update before the agent is asked for one."
            value={config.statusNudgeSeconds}
            onCommit={handleStatusNudgeSecondsCommit}
            testID="mission-control-settings-status-nudge-seconds"
            isCompact={isCompact}
            disabled={!config.stallDetectionEnabled}
          />
          <NumberRow
            title="Escalate after"
            hint="Seconds after a nudge with no response before recovery."
            value={config.escalateSeconds}
            onCommit={handleEscalateSecondsCommit}
            testID="mission-control-settings-escalate-seconds"
            isCompact={isCompact}
            disabled={!config.stallDetectionEnabled}
          />
          <NumberRow
            title="Dormant turn"
            hint="Seconds a running agent may sit with no output AND no tool in flight before its turn is treated as wedged and recovered. Healthy agents respond in 5-90s; the slowest legitimate model call observed was 178.6s (max of 8242 samples — one 727k-token call took 48s TTFT + 54s), and Paseo cannot see a model request in flight (it lives inside omp), so values under ~4 min risk false positives."
            value={config.dormantTurnSeconds}
            onCommit={handleDormantTurnSecondsCommit}
            testID="mission-control-settings-dormant-turn-seconds"
            isCompact={isCompact}
            disabled={!config.stallDetectionEnabled}
          />
        </View>
      </SettingsSection>
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
  modelSelectorSlot: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  modelSelectorField: {
    width: 200,
    flexShrink: 1,
    minWidth: 0,
  },
  modelClearButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  numberInput: {
    width: 88,
  },
  textInput: {
    width: 220,
  },
  instructionsInput: {
    marginTop: theme.spacing[3],
  },
  rowNotice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  rowWarning: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  disabledText: {
    opacity: 0.45,
  },
  routingCard: {
    marginTop: theme.spacing[3],
  },
}));

interface RoutingSettingsHost {
  serverId: string;
  label: string;
}

const ROUTING_SECRET_ROWS: ReadonlyArray<{
  key: RoutingSecretKey;
  titleKey: string;
  hintKey: string;
}> = [
  {
    key: "typesafeApiKey",
    titleKey: "settings.routing.typesafeKey",
    hintKey: "settings.routing.typesafeKeyHint",
  },
  {
    key: "nameModelApiKey",
    titleKey: "settings.routing.nameModelKey",
    hintKey: "settings.routing.nameModelKeyHint",
  },
  {
    key: "metadataModelApiKey",
    titleKey: "settings.routing.metadataModelKey",
    hintKey: "settings.routing.metadataModelKeyHint",
  },
];

/**
 * One routing setting, addressed by a field key the parent applies:
 * "defaultHost", "rules", "<record>:<key>" (per-host roots, per-mode models),
 * "<endpoint>.<part>" (naming endpoints), or "secret:<key>".
 */
type RoutingFieldApply = (fieldKey: string, value: string | null) => void;

function RoutingTextField({
  fieldKey,
  onApply,
  ...row
}: {
  fieldKey: string;
  onApply: RoutingFieldApply;
  title: string;
  hint: string;
  value: string | null;
  testID: string;
  isCompact: boolean;
  first?: boolean;
}) {
  const handleCommit = useCallback(
    (value: string | null) => onApply(fieldKey, value),
    [fieldKey, onApply],
  );
  return <TextRow {...row} onCommit={handleCommit} nullable />;
}

function RoutingDropdownField({
  fieldKey,
  onApply,
  ...row
}: {
  fieldKey: string;
  onApply: RoutingFieldApply;
  title: string;
  hint: string;
  value: string | null;
  options: readonly DropdownRowOption<string>[];
  testID: string;
  first?: boolean;
}) {
  const handleSelect = useCallback(
    (value: string) => onApply(fieldKey, value || null),
    [fieldKey, onApply],
  );
  return <DropdownRow {...row} onSelect={handleSelect} />;
}

function RoutingWorkHostRow({
  host,
  isWork,
  onToggle,
}: {
  host: RoutingSettingsHost;
  isWork: boolean;
  onToggle: (serverId: string, isWork: boolean) => void;
}) {
  const { t } = useTranslation();
  const handleChange = useCallback(
    (next: boolean) => onToggle(host.serverId, next),
    [host.serverId, onToggle],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{host.label}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.routing.workHostHint")}</Text>
      </View>
      <Switch
        value={isWork}
        onValueChange={handleChange}
        accessibilityLabel={t("settings.routing.workHost")}
        testID={`routing-settings-work-${host.serverId}`}
      />
    </View>
  );
}

/**
 * Models every connected host has ticked (daemon visibleModels): the agent
 * model for a mode must exist on whichever host routing picks.
 */
function useCommonVisibleModels(serverIds: readonly string[]): string[] {
  const query = useFetchQuery({
    queryKey: ["routing-common-visible-models", ...serverIds],
    dataShape: "list",
    staleTimeMs: 60_000,
    queryFn: async () => {
      const lists = await Promise.all(
        serverIds.map(async (serverId) => {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client?.isConnected) return null;
          return (await client.getDaemonConfig()).config.visibleModels ?? null;
        }),
      );
      let common: string[] | null = null;
      for (const visible of lists) {
        if (!visible || visible.length === 0) continue;
        common = common ? common.filter((model) => visible.includes(model)) : [...visible];
      }
      return (common ?? []).sort();
    },
  });
  return query.data ?? [];
}

const ROUTING_RECORD_FIELDS = [
  "projectRootByHost",
  "scratchRootByHost",
  "modelByMode",
  "workModelByMode",
] as const;
type RoutingRecordField = (typeof ROUTING_RECORD_FIELDS)[number];

function applyRoutingField(
  routing: RoutingConfig,
  fieldKey: string,
  value: string | null,
): Partial<RoutingConfig> | null {
  if (fieldKey === "defaultHost") return { defaultHost: value };
  if (fieldKey === "rules") return { rules: value ?? "" };
  const [record, recordKey] = fieldKey.split(":");
  if (recordKey && (ROUTING_RECORD_FIELDS as readonly string[]).includes(record!)) {
    const field = record as RoutingRecordField;
    const next = { ...routing[field] };
    if (value) {
      next[recordKey] = value;
    } else {
      delete next[recordKey];
    }
    return { [field]: next };
  }
  const [endpoint, part] = fieldKey.split(".");
  if ((endpoint === "nameModel" || endpoint === "metadataModel") && part) {
    const next = { ...(routing[endpoint] ?? { baseUrl: "", model: "" }), [part]: value ?? "" };
    return { [endpoint]: next.baseUrl || next.model ? next : null };
  }
  return null;
}

/**
 * Placement routing settings (central config `routing` + `routingSecrets`):
 * where new projects and scratch work land per host, which hosts are work,
 * the agent model per mode, and the naming models. API keys are write-only.
 */
function RoutingSettings({
  config,
  hosts,
  patch,
  isCompact,
}: {
  config: ResolvedMissionControlCentralConfig;
  hosts: readonly RoutingSettingsHost[];
  patch: (updates: Partial<MissionControlCentralConfig>) => Promise<void>;
  isCompact: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const routing = config.routing;
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const commonModels = useCommonVisibleModels(serverIds);
  const hostOptions = useMemo(
    () => hosts.map((host) => ({ value: host.serverId, label: host.label })),
    [hosts],
  );
  const modelOptions = useMemo<DropdownRowOption<string>[]>(
    () => [
      { value: "", label: t("settings.routing.modelNone") },
      ...commonModels.map((model) => ({ value: model, label: model })),
    ],
    [commonModels, t],
  );
  const workModelOptions = useMemo<DropdownRowOption<string>[]>(
    () => [
      { value: "", label: t("settings.routing.modelSameAsPersonal") },
      ...commonModels.map((model) => ({ value: model, label: model })),
    ],
    [commonModels, t],
  );
  const modeRows = useMemo(
    () => [{ id: "default", label: t("settings.routing.modelDefault") }, ...AGENT_MODES],
    [t],
  );
  const handleApply = useCallback<RoutingFieldApply>(
    (fieldKey, value) => {
      if (fieldKey.startsWith("secret:")) {
        if (value) void patch({ routingSecrets: { [fieldKey.slice(7)]: value } });
        return;
      }
      const updates = applyRoutingField(routing, fieldKey, value);
      if (updates) void patch({ routing: { ...routing, ...updates } });
    },
    [patch, routing],
  );
  const handleToggleWorkHost = useCallback(
    (serverId: string, isWork: boolean) => {
      const others = (routing.workHosts ?? []).filter((id) => id !== serverId);
      void patch({ routing: { ...routing, workHosts: isWork ? [...others, serverId] : others } });
    },
    [patch, routing],
  );

  return (
    <SettingsSection title={t("settings.routing.title")}>
      <View style={settingsStyles.card}>
        <RoutingDropdownField
          fieldKey="defaultHost"
          onApply={handleApply}
          title={t("settings.routing.defaultHost")}
          hint={t("settings.routing.defaultHostHint")}
          value={routing.defaultHost ?? null}
          options={hostOptions}
          testID="routing-settings-default-host"
          first
        />
        <RoutingTextField
          fieldKey="rules"
          onApply={handleApply}
          title={t("settings.routing.rules")}
          hint={t("settings.routing.rulesHint")}
          value={routing.rules ?? null}
          testID="routing-settings-rules"
          isCompact={isCompact}
        />
      </View>
      {hosts.map((host) => (
        <View key={host.serverId} style={styles.routingCard}>
          <View style={settingsStyles.card}>
            <RoutingWorkHostRow
              host={host}
              isWork={(routing.workHosts ?? []).includes(host.serverId)}
              onToggle={handleToggleWorkHost}
            />
            <RoutingTextField
              fieldKey={`projectRootByHost:${host.serverId}`}
              onApply={handleApply}
              title={t("settings.routing.projectRoot")}
              hint={t("settings.routing.projectRootHint")}
              value={routing.projectRootByHost?.[host.serverId] ?? null}
              testID={`routing-settings-project-root-${host.serverId}`}
              isCompact={isCompact}
            />
            <RoutingTextField
              fieldKey={`scratchRootByHost:${host.serverId}`}
              onApply={handleApply}
              title={t("settings.routing.scratchRoot")}
              hint={t("settings.routing.scratchRootHint")}
              value={routing.scratchRootByHost?.[host.serverId] ?? null}
              testID={`routing-settings-scratch-root-${host.serverId}`}
              isCompact={isCompact}
            />
          </View>
        </View>
      ))}
      <View style={styles.routingCard}>
        <View style={settingsStyles.card}>
          {modeRows.map((mode, index) => (
            <View key={mode.id}>
              <RoutingDropdownField
                fieldKey={`modelByMode:${mode.id}`}
                onApply={handleApply}
                title={mode.label}
                hint={t("settings.routing.modelHint")}
                value={routing.modelByMode?.[mode.id] ?? ""}
                options={modelOptions}
                testID={`routing-settings-model-${mode.id}`}
                first={index === 0}
              />
              <RoutingDropdownField
                fieldKey={`workModelByMode:${mode.id}`}
                onApply={handleApply}
                title={t("settings.routing.workModel", { mode: mode.label })}
                hint={t("settings.routing.workModelHint")}
                value={routing.workModelByMode?.[mode.id] ?? ""}
                options={workModelOptions}
                testID={`routing-settings-work-model-${mode.id}`}
              />
            </View>
          ))}
        </View>
      </View>
      <View style={styles.routingCard}>
        <View style={settingsStyles.card}>
          <RoutingTextField
            fieldKey="nameModel.baseUrl"
            onApply={handleApply}
            title={t("settings.routing.nameModelUrl")}
            hint={t("settings.routing.nameModelUrlHint")}
            value={routing.nameModel?.baseUrl ?? null}
            testID="routing-settings-name-model-url"
            isCompact={isCompact}
            first
          />
          <RoutingTextField
            fieldKey="nameModel.model"
            onApply={handleApply}
            title={t("settings.routing.nameModelId")}
            hint={t("settings.routing.nameModelIdHint")}
            value={routing.nameModel?.model ?? null}
            testID="routing-settings-name-model-id"
            isCompact={isCompact}
          />
          <RoutingTextField
            fieldKey="metadataModel.baseUrl"
            onApply={handleApply}
            title={t("settings.routing.metadataModelUrl")}
            hint={t("settings.routing.metadataModelUrlHint")}
            value={routing.metadataModel?.baseUrl ?? null}
            testID="routing-settings-metadata-model-url"
            isCompact={isCompact}
          />
          <RoutingTextField
            fieldKey="metadataModel.model"
            onApply={handleApply}
            title={t("settings.routing.metadataModelId")}
            hint={t("settings.routing.metadataModelIdHint")}
            value={routing.metadataModel?.model ?? null}
            testID="routing-settings-metadata-model-id"
            isCompact={isCompact}
          />
        </View>
      </View>
      <View style={styles.routingCard}>
        <View style={settingsStyles.card}>
          {ROUTING_SECRET_ROWS.map((row, index) => (
            <RoutingTextField
              key={row.key}
              fieldKey={`secret:${row.key}`}
              onApply={handleApply}
              title={t(row.titleKey)}
              hint={`${t(row.hintKey)} ${t(
                config.routingSecretsSet.includes(row.key)
                  ? "settings.routing.keySaved"
                  : "settings.routing.keyMissing",
              )}`}
              value={null}
              testID={`routing-settings-secret-${row.key}`}
              isCompact={isCompact}
              first={index === 0}
            />
          ))}
        </View>
      </View>
    </SettingsSection>
  );
}
