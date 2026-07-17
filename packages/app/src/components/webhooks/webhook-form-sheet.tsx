import equal from "fast-deep-equal";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import { Brain, Copy, Folder, GitBranch } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { WebhookSummary } from "@getpaseo/protocol/webhook/types";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { createControlGeometry, type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { getProviderIcon } from "@/components/provider-icons";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { formatThinkingOptionLabel } from "@/composer/agent-controls/utils";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useWebhookMutations } from "@/hooks/use-webhook-mutations";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useFetchQuery } from "@/data/query";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildScheduleProjectTargets } from "@/schedules/schedule-project-targets";
import { useWebhookFormModel } from "@/webhooks/use-webhook-form-model";
import { useWebhookFormProviderSnapshot } from "@/webhooks/use-webhook-form-provider-snapshot";
import {
  buildWebhookAuth,
  type WebhookFormDisplay,
  type WebhookFormHost,
  type WebhookFormModel,
  type WebhookFormSnapshot,
  type WebhookFormState,
  type WebhookHmacPresetOption,
} from "@/webhooks/webhook-form-model";
import { buildHookUrl } from "@/webhooks/webhook-derivation";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";

export interface WebhookFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  webhook?: WebhookSummary;
}

const HMAC_PRESET_OPTIONS: { value: WebhookHmacPresetOption; label: string; testID: string }[] = [
  { value: "none", label: "None", testID: "webhook-hmac-none" },
  { value: "github", label: "GitHub", testID: "webhook-hmac-github" },
  { value: "linear", label: "Linear", testID: "webhook-hmac-linear" },
  { value: "custom", label: "Custom", testID: "webhook-hmac-custom" },
];

function resolveCreateServerId(input: {
  mode: "create" | "edit";
  serverId: string | null | undefined;
  hosts: readonly WebhookFormHost[];
}): string | null {
  if (input.mode === "edit") {
    return input.serverId ?? null;
  }
  if (input.serverId !== undefined) {
    return input.serverId;
  }
  if (input.hosts.length === 1) {
    return input.hosts[0]?.serverId ?? null;
  }
  return null;
}

function buildWebhookHostOptionTestId(serverId: string): string {
  return `webhook-host-option-${serverId}`;
}

function buildThinkingOptionTestId(optionId: string): string {
  return `webhook-thinking-option-${optionId}`;
}

function openKey(props: WebhookFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId ?? ""}:${props.webhook?.id ?? ""}`;
  }
  return `create:${props.serverId ?? ""}`;
}

function selectWebhookHosts(
  hosts: readonly { serverId: string; label: string }[],
): (state: ReturnType<typeof useSessionStore.getState>) => WebhookFormHost[] {
  return (state) =>
    hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      supportsWorkspaceMultiplicity:
        state.sessions[host.serverId]?.serverInfo?.features?.workspaceMultiplicity === true,
    }));
}

function buildSnapshot(input: {
  mode: "create" | "edit";
  serverId: string | undefined;
  webhook: WebhookSummary | undefined;
  hosts: readonly WebhookFormHost[];
  projectTargets: ReturnType<typeof buildScheduleProjectTargets>;
  preferences: FormPreferences;
}): WebhookFormSnapshot {
  const webhook = input.webhook
    ? { ...input.webhook, serverId: input.serverId, serverName: undefined }
    : undefined;
  return {
    mode: input.mode,
    webhook,
    hosts: input.hosts,
    defaults: {
      serverId: resolveCreateServerId({
        mode: input.mode,
        serverId: input.serverId,
        hosts: input.hosts,
      }),
      projectTargets: input.projectTargets,
      preferences: input.preferences,
    },
  };
}

function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        model: model || undefined,
        mode: mode || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    isolation: input.isolation,
  };
}

export function WebhookFormSheet(props: WebhookFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<WebhookFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenWebhookFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenWebhookFormSheet({
  serverId,
  visible,
  onClose,
  onDismiss,
  mode,
  webhook,
}: WebhookFormSheetProps & { onDismiss: () => void }): ReactElement {
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useStoreWithEqualityFn(
    useSessionStore,
    useMemo(() => selectWebhookHosts(hostProfiles), [hostProfiles]),
    equal,
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildScheduleProjectTargets(projects), [projects]);
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        mode,
        serverId,
        webhook,
        hosts,
        projectTargets,
        preferences,
      }),
    [hosts, mode, preferences, projectTargets, webhook, serverId],
  );
  const model = useWebhookFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providerSnapshot = useWebhookFormProviderSnapshot(model, state);
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const mutationServerId = state.selectedServerId ?? serverId ?? "";
  const { createWebhook, updateWebhook, testWebhook, isCreating, isUpdating, isTesting } =
    useWebhookMutations({
      serverId: mutationServerId,
    });

  const isSubmitting = isCreating || isUpdating;
  const canSubmit = state.canSubmit && !isSubmitting;
  const agentTargetLabel = useMemo(() => {
    if (!webhook || webhook.target.type !== "agent") {
      return null;
    }
    const { agentId } = webhook.target;
    const agent = agents.find(
      (entry) => entry.serverId === (state.selectedServerId ?? serverId) && entry.id === agentId,
    );
    if (!agent) {
      return "Agent unavailable";
    }
    return agent.title?.trim() || "Untitled agent";
  }, [agents, webhook, serverId, state.selectedServerId]);

  const persistPreferences = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) {
      return;
    }
    await updatePreferences((current) =>
      updateSelectionPreferences({
        preferences: current,
        provider,
        model: state.selectedModel,
        mode: state.selectedMode,
        thinkingOptionId: state.selectedThinkingOptionId,
        isolation: state.isolation,
      }),
    );
  }, [
    state.isolation,
    state.selectedMode,
    state.selectedModel,
    state.selectedProvider,
    state.selectedThinkingOptionId,
    updatePreferences,
  ]);

  const submitAgentTarget = useCallback(async (): Promise<boolean> => {
    if (!webhook) {
      return false;
    }
    await updateWebhook({
      id: webhook.id,
      name: state.name.trim() || null,
      enabled: state.enabled,
      promptTemplate: state.promptTemplate.trim(),
      auth: buildWebhookAuth(state),
    });
    return true;
  }, [webhook, state, updateWebhook]);

  const submitNewAgent = useCallback(async (): Promise<boolean> => {
    const provider = state.selectedProvider;
    const cwd = state.workingDir.trim();
    if (!provider || !cwd) {
      return false;
    }

    await persistPreferences();
    const config = {
      provider,
      cwd,
      model: state.selectedModel || undefined,
      modeId: state.selectedMode || undefined,
      thinkingOptionId: state.selectedThinkingOptionId || undefined,
      ...(state.submitArchiveOnFinish !== undefined
        ? { archiveOnFinish: state.submitArchiveOnFinish }
        : {}),
      ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}),
      title: state.name.trim() || undefined,
    };
    const auth = buildWebhookAuth(state);

    if (mode === "edit" && webhook) {
      await updateWebhook({
        id: webhook.id,
        name: state.name.trim() || null,
        enabled: state.enabled,
        promptTemplate: state.promptTemplate.trim(),
        target: { type: "new-agent", config },
        auth,
      });
      return true;
    }

    await createWebhook({
      target: { type: "new-agent", config },
      promptTemplate: state.promptTemplate.trim(),
      name: state.name.trim() || undefined,
      enabled: state.enabled,
      auth,
    });
    return true;
  }, [createWebhook, mode, persistPreferences, webhook, state, updateWebhook]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      const submitted =
        state.targetKind === "agent" ? await submitAgentTarget() : await submitNewAgent();
      if (submitted) {
        onClose();
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, model, onClose, state.targetKind, submitAgentTarget, submitNewAgent]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: mode === "edit" ? "Edit webhook" : "New webhook" }),
    [mode],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="webhook-form-submit"
        >
          {mode === "edit" ? "Save changes" : "Create webhook"}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="webhook-form-sheet"
    >
      <WebhookFormFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />
      {mode === "edit" && webhook ? (
        <WebhookEditExtras
          serverId={mutationServerId}
          webhookId={webhook.id}
          onTest={testWebhook}
          isTesting={isTesting}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

interface WebhookFormFieldsProps {
  model: WebhookFormModel;
  state: WebhookFormState;
  providerSnapshot: ReturnType<typeof useWebhookFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  mutationServerId: string;
}

function WebhookFormFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  mutationServerId,
}: WebhookFormFieldsProps): ReactElement {
  return (
    <>
      <Field label="Name">
        <FormTextInput
          size={controlSize}
          testID="webhook-name-input"
          accessibilityLabel="Webhook name"
          initialValue={state.name}
          value={state.name}
          onChangeText={model.setName}
          placeholder="Optional"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label="Enabled">
        <Switch
          value={state.enabled}
          onValueChange={model.setEnabled}
          accessibilityLabel="Enabled"
          testID="webhook-enabled-switch"
        />
      </Field>

      <Field label="Prompt template">
        <FormTextInput
          size={controlSize}
          testID="webhook-prompt-input"
          accessibilityLabel="Prompt template"
          initialValue={state.promptTemplate}
          value={state.promptTemplate}
          onChangeText={model.setPromptTemplate}
          placeholder="Use {{payload.path}} to interpolate incoming fields"
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>

      <WebhookTargetFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />

      <WebhookAuthFields model={model} state={state} controlSize={controlSize} />

      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </>
  );
}

function WebhookAuthFields({
  model,
  state,
  controlSize,
}: {
  model: WebhookFormModel;
  state: WebhookFormState;
  controlSize: FieldControlSize;
}): ReactElement {
  return (
    <>
      <Field label="Signature verification">
        <SegmentedControl
          size="sm"
          value={state.hmacPreset}
          onValueChange={model.setHmacPreset}
          options={HMAC_PRESET_OPTIONS}
          testID="webhook-hmac-preset"
        />
      </Field>

      {state.hmacPreset !== "none" ? (
        <Field label="Signing secret">
          <FormTextInput
            size={controlSize}
            testID="webhook-hmac-secret-input"
            accessibilityLabel="Signing secret"
            initialValue={state.hmacSecret}
            value={state.hmacSecret}
            onChangeText={model.setHmacSecret}
            placeholder="Shared HMAC secret"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </Field>
      ) : null}
    </>
  );
}

interface WebhookTargetFieldsProps {
  model: WebhookFormModel;
  state: WebhookFormState;
  providerSnapshot: ReturnType<typeof useWebhookFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  mutationServerId: string;
}

function WebhookTargetFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  mutationServerId,
}: WebhookTargetFieldsProps): ReactElement {
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: buildWebhookHostOptionTestId(host.serverId),
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId) ?? null;
  const selectedHostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (selectedHost) {
      return { label: selectedHost.label };
    }
    if (state.selectedServerId) {
      return { label: state.selectedServerId };
    }
    return null;
  }, [selectedHost, state.selectedServerId]);
  const projectOptions = state.projectOptions;
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.modeOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    [state.modeOptions],
  );
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.availableThinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: buildThinkingOptionTestId(option.id),
      })),
    [state.availableThinkingOptions],
  );
  const handleSelectHost = useCallback(
    (nextServerId: string) => {
      model.setHost(nextServerId);
    },
    [model],
  );
  const handleSelectProject = useCallback(
    (optionId: string, display: WebhookFormDisplay) => {
      model.setProject(optionId, display);
    },
    [model],
  );
  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModel(provider, modelId);
    },
    [model],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      model.setSessionMode(modeId);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (thinkingOptionId: string) => {
      model.setThinking(thinkingOptionId);
    },
    [model],
  );
  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(state.selectedProvider);
  }, [providerSnapshot, state.selectedProvider]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  const modelTriggerLeading = useMemo(
    () => <ProviderGlyph provider={state.selectedProvider} />,
    [state.selectedProvider],
  );
  const renderModelTrigger = useCallback(
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
    }): ReactNode => {
      const displayLabel = state.selectedModelDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.selectedModel}
          placeholder={displayLabel}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="webhook-model-trigger"
        />
      );
    },
    [controlSize, modelTriggerLeading, state.selectedModel, state.selectedModelDisplay],
  );

  if (state.targetKind === "agent") {
    return <WebhookAgentTargetField label={agentTargetLabel} size={controlSize} />;
  }

  return (
    <>
      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label="Host"
          value={state.selectedServerId}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={handleSelectHost}
          placeholder="Select host"
          emptyText="No hosts found"
          disabled={state.mode === "edit"}
          searchable={false}
          title="Host"
          size={controlSize}
          triggerTestID="webhook-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}

      {state.disclosure.showProjectField ? (
        <SelectField
          label="Project"
          value={state.selectedProjectOptionId || null}
          selectedDisplay={state.projectDisplay}
          options={projectOptions}
          onChange={handleSelectProject}
          placeholder="Select project"
          emptyText="No projects found"
          disabled={!state.selectedServerId}
          hint={!state.selectedServerId ? "Choose a host first." : undefined}
          searchable
          searchPlaceholder="Search projects..."
          title="Select project"
          size={controlSize}
          triggerTestID="webhook-project-trigger"
          renderOption={renderProjectOption}
        />
      ) : null}

      {state.disclosure.showModelField ? (
        <Field label="Model">
          <CombinedModelSelector
            providers={state.modelSelectorProviders}
            selectedProvider={state.selectedProvider ?? ""}
            selectedModel={state.selectedModel}
            onSelect={handleSelectModel}
            isLoading={providerSnapshot.isLoading || providerSnapshot.isFetching}
            renderTrigger={renderModelTrigger}
            triggerFill
            serverId={mutationServerId}
            disabled={!state.selectedServerId}
            onOpen={handleModelOpen}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={providerSnapshot.isRefreshing}
          />
        </Field>
      ) : null}

      {state.disclosure.showThinkingField ? (
        <SelectField
          label="Thinking"
          value={state.selectedThinkingOptionId || null}
          selectedDisplay={state.selectedThinkingDisplay}
          options={thinkingOptions}
          onChange={handleSelectThinking}
          placeholder="Select thinking"
          emptyText="No thinking options found"
          searchable={thinkingOptions.length > 6}
          title="Select thinking"
          size={controlSize}
          triggerTestID="webhook-thinking-trigger"
          renderOption={renderThinkingOption}
        />
      ) : null}

      {state.disclosure.showModeField ? (
        <SelectField
          label="Mode"
          value={state.selectedMode || null}
          selectedDisplay={state.selectedModeDisplay}
          options={modeOptions}
          onChange={handleSelectMode}
          placeholder="Default mode"
          emptyText="No modes found"
          disabled={modeOptions.length === 0}
          hint={modeOptions.length === 0 ? "No modes are available for this model." : undefined}
          searchable={modeOptions.length > 6}
          title="Select mode"
          size={controlSize}
          triggerTestID="webhook-mode-trigger"
        />
      ) : null}

      {state.disclosure.showIsolationField ? (
        <WebhookIsolationField model={model} state={state} size={controlSize} />
      ) : null}

      {state.disclosure.showArchiveOnFinishField ? (
        <Field label="Archive on finish">
          <Switch
            value={state.archiveOnFinish}
            onValueChange={model.setArchiveOnFinish}
            accessibilityLabel="Archive on finish"
            testID="webhook-archive-on-finish-switch"
          />
        </Field>
      ) : null}
    </>
  );
}

function WebhookIsolationField({
  model,
  state,
  size,
}: {
  model: WebhookFormModel;
  state: WebhookFormState;
  size: FieldControlSize;
}): ReactElement {
  const options = useMemo<SelectFieldOption<"local" | "worktree">[]>(
    () => [
      {
        id: "local",
        value: "local",
        label: "Local",
        testID: "webhook-isolation-local",
      },
      {
        id: "worktree",
        value: "worktree",
        label: "Worktree",
        testID: "webhook-isolation-worktree",
      },
    ],
    [],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: state.effectiveIsolation === "worktree" ? "Worktree" : "Local" }),
    [state.effectiveIsolation],
  );
  const triggerLeading = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {state.effectiveIsolation === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [state.effectiveIsolation],
  );
  const handleSelectIsolation = useCallback(
    (value: "local" | "worktree") => {
      model.setIsolation(value);
    },
    [model],
  );
  const renderIsolationOption = useCallback(
    (input: SelectFieldRenderOptionInput<"local" | "worktree">) => (
      <IsolationOptionItem {...input} />
    ),
    [],
  );

  return (
    <SelectField
      label="Isolation"
      value={state.effectiveIsolation}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleSelectIsolation}
      placeholder="Select isolation"
      emptyText="No isolation options found"
      searchable={false}
      title="Isolation"
      size={size}
      testID="webhook-isolation"
      triggerTestID="webhook-isolation-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderIsolationOption}
    />
  );
}

function WebhookAgentTargetField({
  label,
  size,
}: {
  label: string | null;
  size: FieldControlSize;
}): ReactElement {
  const fieldStyle = useMemo(
    () => [styles.readonlyField, size === "sm" ? styles.readonlyFieldSm : styles.readonlyFieldMd],
    [size],
  );
  const textStyle = useMemo(
    () => [styles.readonlyText, size === "sm" ? styles.readonlyTextSm : styles.readonlyTextMd],
    [size],
  );

  return (
    <Field label="Target">
      <View style={fieldStyle} testID="webhook-agent-target">
        <Text style={textStyle} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Field>
  );
}

interface WebhookEditExtrasProps {
  serverId: string;
  webhookId: string;
  onTest: (input: { id: string }) => Promise<{ renderedPrompt: string | null }>;
  isTesting: boolean;
}

function WebhookEditExtras({
  serverId,
  webhookId,
  onTest,
  isTesting,
}: WebhookEditExtrasProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const query = useFetchQuery({
    queryKey: ["webhook-inspect", serverId, webhookId],
    queryFn: async () => {
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.webhookInspect({ id: webhookId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { webhook: payload.webhook, publicBaseUrl: payload.publicBaseUrl };
    },
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: Boolean(serverId && webhookId),
  });

  const inspected = query.data?.webhook ?? null;
  const hookUrl = inspected
    ? buildHookUrl(query.data?.publicBaseUrl ?? null, {
        id: inspected.id,
        secret: inspected.secret,
      })
    : null;
  const deliveries = inspected?.deliveries ?? [];

  const handleCopy = useCallback(() => {
    if (!hookUrl) {
      return;
    }
    void (async () => {
      await copyToClipboard(hookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    })();
  }, [hookUrl]);

  const handleTest = useCallback(() => {
    setTestError(null);
    void (async () => {
      try {
        const result = await onTest({ id: webhookId });
        setTestResult(result.renderedPrompt ?? "Delivered.");
      } catch (error) {
        setTestError(toErrorMessage(error));
      }
    })();
  }, [onTest, webhookId]);

  return (
    <View style={styles.extras}>
      <Field label="Hook URL">
        {hookUrl ? (
          <Pressable
            style={styles.hookUrlBox}
            onPress={handleCopy}
            accessibilityRole="button"
            accessibilityLabel="Copy hook URL"
            testID="webhook-copy-url"
          >
            <Text style={styles.hookUrlText} numberOfLines={1}>
              {hookUrl}
            </Text>
            <Copy size={16} color={styles.providerIcon.color} />
          </Pressable>
        ) : (
          <Text style={styles.hint}>
            Configure a tunnel on this host to expose a public hook URL.
          </Text>
        )}
        {copied ? <Text style={styles.hint}>Copied.</Text> : null}
      </Field>

      <Button
        variant="outline"
        size="sm"
        onPress={handleTest}
        loading={isTesting}
        testID="webhook-test"
      >
        Send test event
      </Button>
      {testResult ? <Text style={styles.testResult}>{testResult}</Text> : null}
      {testError ? <Text style={styles.submitError}>{testError}</Text> : null}

      <Field label="Recent deliveries">
        {deliveries.length === 0 ? (
          <Text style={styles.hint}>No deliveries yet.</Text>
        ) : (
          <View style={styles.deliveryList}>
            {deliveries.slice(0, 10).map((delivery) => (
              <View key={delivery.id} style={styles.deliveryRow} testID="webhook-delivery">
                <Text style={styles.deliveryStatus} numberOfLines={1}>
                  {delivery.status}
                  {delivery.matched ? "" : " · unmatched"}
                </Text>
                <Text style={styles.deliveryMeta} numberOfLines={1}>
                  {formatTimeAgo(new Date(delivery.receivedAt))}
                  {delivery.error ? ` · ${delivery.error}` : ""}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Field>
    </View>
  );
}

function IsolationOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<"local" | "worktree">): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {option.value === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [option.value],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ThinkingOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Brain size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    multilineInput: {
      minHeight: 96,
    },
    readonlyField: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    readonlyFieldSm: {
      ...geometry.formTextInputSm,
    },
    readonlyFieldMd: {
      ...geometry.formTextInputMd,
    },
    readonlyText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
    },
    readonlyTextSm: {
      fontSize: theme.fontSize.sm,
    },
    readonlyTextMd: {
      fontSize: theme.fontSize.base,
    },
    optionIconBox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      flex: 1,
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    footerButton: {
      flex: 1,
    },
    submitError: {
      color: theme.colors.palette.red[300],
      fontSize: theme.fontSize.xs,
    },
    providerIcon: {
      color: theme.colors.foregroundMuted,
    },
    extras: {
      gap: theme.spacing[4],
      marginTop: theme.spacing[2],
      paddingTop: theme.spacing[4],
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    hookUrlBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      paddingVertical: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
    },
    hookUrlText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      fontFamily: theme.fontFamily.mono,
    },
    hint: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
    },
    testResult: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      fontFamily: theme.fontFamily.mono,
    },
    deliveryList: {
      gap: theme.spacing[2],
    },
    deliveryRow: {
      gap: theme.spacing[1],
    },
    deliveryStatus: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
    },
    deliveryMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
    },
  };
});
