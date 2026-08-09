import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type TextStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, X } from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type {
  MissionControlCentralConfig,
  MissionControlMode,
} from "@getpaseo/protocol/mission-control/types";
import { SettingsTextArea } from "@/components/settings-textarea";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SelectFieldTrigger } from "@/components/ui/select-field";
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
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import {
  buildInvocableProviderModelStrings,
  resolveCommanderHostServerId,
} from "@/mission-control/model-options";
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
const ThemedX = withUnistyles(X);

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
 * Split a stored "provider/model" override (the wire format the daemon parses)
 * into selector state; a bare model resolves on the host default provider.
 */
function splitModelOverride(value: string | null): { provider: string; model: string } {
  if (!value) {
    return { provider: "", model: "" };
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: value.slice(0, slashIndex).trim(),
      model: value.slice(slashIndex + 1).trim(),
    };
  }
  return { provider: "", model: value.trim() };
}

/**
 * Availability notice under a model override row. A host that cannot serve a
 * model list, and a stored value that host cannot run, are both surfaced —
 * silently showing a broken override as normal is what let an unspawnable
 * Commander model look fine.
 */
function renderAvailabilityNotice(input: {
  isHostUnavailable: boolean;
  isModelListUnavailable: boolean;
  invalidValue: string | null;
  hostLabel: string | null | undefined;
  styles: { rowNotice: TextStyle; rowWarning: TextStyle };
}): ReactElement | null {
  const host = input.hostLabel ? `“${input.hostLabel}”` : "this host";
  if (input.isHostUnavailable) {
    return (
      <Text style={input.styles.rowNotice}>
        Host {input.hostLabel ? `“${input.hostLabel}” ` : ""}is unreachable or model list is
        unavailable.
      </Text>
    );
  }
  if (input.isModelListUnavailable) {
    return <Text style={input.styles.rowNotice}>No models available for {host}.</Text>;
  }
  if (input.invalidValue) {
    return (
      <Text style={input.styles.rowWarning}>
        Model “{input.invalidValue}” is not configured or available on {host}.
      </Text>
    );
  }
  return null;
}

/**
 * Central-config model override row: the app's CombinedModelSelector (spec —
 * never free-text). Empty = no override (the daemon falls back to the host
 * default / omp modelRoles); the clear button restores that empty state.
 */
function ModelOverrideRow({
  title,
  hint,
  value,
  onCommit,
  serverId,
  hostLabel,
  testID,
  isCompact,
  first = false,
}: {
  title: string;
  hint: string;
  value: string | null;
  onCommit: (next: string | null) => void;
  serverId: string | null;
  hostLabel?: string;
  testID: string;
  isCompact: boolean;
  first?: boolean;
}) {
  const {
    entries: snapshotEntries,
    isLoading,
    error: snapshotError,
  } = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => (snapshotEntries ? buildSelectableProviderSelectorProviders(snapshotEntries) : []),
    [snapshotEntries],
  );
  const invocableModels = useMemo(
    () => buildInvocableProviderModelStrings(snapshotEntries),
    [snapshotEntries],
  );
  const { provider, model } = splitModelOverride(value);

  const isHostUnavailable = !serverId || Boolean(snapshotError);
  const isModelListUnavailable =
    !isLoading && !isHostUnavailable && (!snapshotEntries || snapshotEntries.length === 0);

  const isValid = useMemo(() => {
    if (!value || isHostUnavailable || isModelListUnavailable) {
      return true;
    }
    if (provider) {
      if (model) {
        return invocableModels.has(`${provider}/${model}`);
      }
      return snapshotEntries?.some((e) => e.enabled && e.provider === provider) ?? false;
    }
    if (model) {
      return Array.from(invocableModels).some((k) => k.endsWith(`/${model}`));
    }
    return true;
  }, [
    value,
    isHostUnavailable,
    isModelListUnavailable,
    provider,
    model,
    invocableModels,
    snapshotEntries,
  ]);

  const handleSelect = useCallback(
    (nextProvider: AgentProvider, nextModel: string) => {
      onCommit(`${nextProvider}/${nextModel}`);
    },
    [onCommit],
  );
  const handleClear = useCallback(() => {
    onCommit(null);
  }, [onCommit]);

  const renderTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }) => {
      let label = "Host default";
      let isPlaceholder = true;

      if (isHostUnavailable) {
        label = !serverId ? "No host selected" : "Host unreachable";
        isPlaceholder = true;
      } else if (isModelListUnavailable) {
        label = "Model list unavailable";
        isPlaceholder = true;
      } else if (value) {
        if (!isValid) {
          label = `${value} (invalid)`;
          isPlaceholder = false;
        } else if (provider) {
          label = selectedModelLabel;
          isPlaceholder = false;
        } else {
          label = value;
          isPlaceholder = false;
        }
      }

      return (
        <SelectFieldTrigger
          label={label}
          isPlaceholder={isPlaceholder}
          placeholder="Host default"
          active={hovered || pressed || isOpen}
          disabled={disabled || isHostUnavailable || isModelListUnavailable}
          loading={isLoading}
          size={isCompact ? "md" : "sm"}
          testID={`${testID}-trigger`}
        />
      );
    },
    [
      isCompact,
      isLoading,
      isHostUnavailable,
      isModelListUnavailable,
      isValid,
      provider,
      serverId,
      testID,
      value,
    ],
  );

  return (
    <View style={[settingsStyles.row, first ? null : settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
        {renderAvailabilityNotice({
          isHostUnavailable: isHostUnavailable && Boolean(serverId),
          isModelListUnavailable,
          invalidValue: !isValid && value ? value : null,
          hostLabel,
          styles,
        })}
      </View>
      <View style={styles.modelSelectorSlot}>
        <View style={styles.modelSelectorField}>
          <CombinedModelSelector
            providers={providers}
            selectedProvider={provider}
            selectedModel={model}
            onSelect={handleSelect}
            isLoading={isLoading}
            disabled={isHostUnavailable || isModelListUnavailable}
            triggerFill
            serverId={serverId}
            renderTrigger={renderTrigger}
          />
        </View>
        {value ? (
          <Pressable
            onPress={handleClear}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${title}`}
            testID={`${testID}-clear`}
            style={styles.modelClearButton}
          >
            <ThemedX size={14} uniProps={chevronMutedMapping} />
          </Pressable>
        ) : null}
      </View>
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
  const localServerId = useLocalDaemonServerId();

  const hostnameByServerId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [serverId, session] of Object.entries(sessions)) {
      map.set(serverId, session.serverInfo?.hostname ?? null);
    }
    return map;
  }, [sessions]);

  const commanderHostServerId = useMemo(
    () =>
      resolveCommanderHostServerId({
        commanderHost: config?.commanderHost ?? null,
        hosts,
        hostnameByServerId,
        localServerId,
      }),
    [config?.commanderHost, hostnameByServerId, hosts, localServerId],
  );

  const commanderHostLabel = useMemo(() => {
    const rawHost = config?.commanderHost;
    if (!rawHost) {
      return null;
    }
    const host = hosts.find(
      (h) =>
        h.serverId === commanderHostServerId ||
        h.label === rawHost ||
        hostnameByServerId.get(h.serverId) === rawHost,
    );
    return host?.label ?? rawHost;
  }, [config?.commanderHost, commanderHostServerId, hostnameByServerId, hosts]);

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

  const deliveryModeOptions = useMemo<DropdownRowOption<"steer" | "interrupt" | "queue">[]>(
    () => [
      { value: "steer", label: "Steer" },
      { value: "interrupt", label: "Interrupt" },
      { value: "queue", label: "Queue" },
    ],
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
    (next: number | null) => {
      if (next !== null) {
        void patch({ dormantTurnSeconds: next });
      }
    },
    [patch],
  );
  const handleCommanderToWorkerModeSelect = useCallback(
    (next: "steer" | "interrupt" | "queue") => void patch({ commanderToWorkerMode: next }),
    [patch],
  );
  const handleVerifierToWorkerModeSelect = useCallback(
    (next: "steer" | "interrupt" | "queue") => void patch({ verifierToWorkerMode: next }),
    [patch],
  );
  const handleHindsightUrlCommit = useCallback(
    (next: string | null) => void patch({ hindsightUrl: next }),
    [patch],
  );
  const handleHindsightBankCommit = useCallback(
    (next: string | null) => {
      if (next !== null && next !== "") {
        void patch({ hindsightBank: next });
      }
    },
    [patch],
  );
  const handleHindsightSecondaryBankCommit = useCallback(
    (next: string | null) => void patch({ hindsightSecondaryBank: next }),
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

      <SettingsSection title="Delivery">
        <View style={settingsStyles.card}>
          <DropdownRow
            title="Commander → worker"
            hint="How the Commander's fleet_send_prompt reaches a busy worker by default. Steer = additive, non-urgent instructions (injects without cancelling; a busy non-OMP worker is interrupted so it still lands); interrupt = immediate direction change (cancels and replaces); queue = waits for idle. An explicit mode in the tool call overrides this."
            value={config.commanderToWorkerMode}
            options={deliveryModeOptions}
            onSelect={handleCommanderToWorkerModeSelect}
            testID="mission-control-settings-commander-to-worker-mode"
            first
          />
          <DropdownRow
            title="Verifier → worker"
            hint="How verifier proof demands reach the worker. Steer = additive clarification request; interrupt = takes over immediately; queue = waits for idle."
            value={config.verifierToWorkerMode}
            options={deliveryModeOptions}
            onSelect={handleVerifierToWorkerModeSelect}
            testID="mission-control-settings-verifier-to-worker-mode"
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Commander">
        <View style={settingsStyles.card}>
          <DropdownRow
            title="Commander host"
            hint="The host that runs the fleet Commander. Only this designated host ensures it; None means no host does until you pick one."
            value={config.commanderHost}
            options={hostOptions}
            onSelect={handleCommanderHostSelect}
            testID="mission-control-settings-commander-host"
            first
          />
          <ModelOverrideRow
            title="Commander model"
            hint="Override; empty uses the host default model."
            value={config.commanderModel}
            onCommit={handleCommanderModelCommit}
            serverId={commanderHostServerId}
            hostLabel={commanderHostLabel ?? undefined}
            testID="mission-control-settings-commander-model"
            isCompact={isCompact}
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
          <ModelOverrideRow
            title="Verifier model"
            hint="Overrides omp modelRoles.verifier; empty = omp config."
            value={config.verifierModel}
            onCommit={handleVerifierModelCommit}
            serverId={hostServerId}
            testID="mission-control-settings-verifier-model"
            isCompact={isCompact}
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
            hint="Which agents the verifier audits. 'All agents' audits an agent only when it declared completion or was dispatched with a brief and reported progress — a finished chat turn alone never triggers an audit."
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

      <SettingsSection title={t("settings.missionControl.memory")}>
        <View style={settingsStyles.card}>
          <TextRow
            title={t("settings.missionControl.hindsightUrl")}
            hint={t("settings.missionControl.hindsightUrlHint")}
            value={config.hindsightUrl}
            onCommit={handleHindsightUrlCommit}
            testID="mission-control-settings-hindsight-url"
            isCompact={isCompact}
            first
            nullable
          />
          <TextRow
            title={t("settings.missionControl.hindsightBank")}
            hint={t("settings.missionControl.hindsightBankHint")}
            value={config.hindsightBank}
            onCommit={handleHindsightBankCommit}
            testID="mission-control-settings-hindsight-bank"
            isCompact={isCompact}
          />
          <TextRow
            title={t("settings.missionControl.hindsightSecondaryBank")}
            hint={t("settings.missionControl.hindsightSecondaryBankHint")}
            value={config.hindsightSecondaryBank}
            onCommit={handleHindsightSecondaryBankCommit}
            testID="mission-control-settings-hindsight-secondary-bank"
            isCompact={isCompact}
            nullable
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Stall detection">
        <View style={settingsStyles.card}>
          <NumberRow
            title="Silence nudge"
            hint="Seconds of total silence (no output) before the agent is asked for a status."
            value={config.silenceNudgeSeconds}
            onCommit={handleSilenceNudgeSecondsCommit}
            testID="mission-control-settings-silence-nudge-seconds"
            isCompact={isCompact}
            first
          />
          <NumberRow
            title="Status nudge"
            hint="Seconds without a status update before the agent is asked for one."
            value={config.statusNudgeSeconds}
            onCommit={handleStatusNudgeSecondsCommit}
            testID="mission-control-settings-status-nudge-seconds"
            isCompact={isCompact}
          />
          <NumberRow
            title="Escalate after"
            hint="Seconds after a nudge with no response before recovery."
            value={config.escalateSeconds}
            onCommit={handleEscalateSecondsCommit}
            testID="mission-control-settings-escalate-seconds"
            isCompact={isCompact}
          />
          <NumberRow
            title="Dormant turn"
            hint="Seconds a running agent may sit with no output AND no tool in flight before its turn is treated as wedged and recovered. Healthy agents respond in 5-90s; the slowest legitimate model call observed was 178.6s (max of 8242 samples — one 727k-token call took 48s TTFT + 54s), and Paseo cannot see a model request in flight (it lives inside omp), so values under ~4 min risk false positives."
            value={config.dormantTurnSeconds}
            onCommit={handleDormantTurnSecondsCommit}
            testID="mission-control-settings-dormant-turn-seconds"
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
}));
