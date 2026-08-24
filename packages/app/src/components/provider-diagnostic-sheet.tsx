import * as Clipboard from "expo-clipboard";
import { AlertTriangle, Check, Copy, FileText, Plus, RotateCw, Trash2 } from "lucide-react-native";
import type { TFunction } from "i18next";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatTimeAgo } from "@/utils/time";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import {
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<ReturnType<typeof scoreTextFields>> } =>
        entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

function ModelCheckbox({
  checked,
  onToggle,
  disabled,
  accessibilityLabel,
  testID,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const checkboxStyle = useMemo(
    () => [
      sheetStyles.checkbox,
      checked ? sheetStyles.checkboxChecked : null,
      disabled ? sheetStyles.disabled : null,
    ],
    [checked, disabled],
  );

  const accessibilityState = useMemo(
    () => ({ checked, disabled: Boolean(disabled) }),
    [checked, disabled],
  );

  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      testID={testID}
      style={sheetStyles.checkboxPressable}
    >
      <View style={checkboxStyle}>
        {checked ? <Check size={14} color={theme.colors.accentForeground} /> : null}
      </View>
    </Pressable>
  );
}

function DiscoveredModelRow({
  model,
  hidden,
  disabled,
  onToggleHidden,
}: {
  model: AgentModelDefinition;
  hidden: boolean;
  disabled?: boolean;
  onToggleHidden: (modelId: string, nextHidden: boolean) => void;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => {
    onToggleHidden(model.id, !hidden);
  }, [model.id, hidden, onToggleHidden]);

  return (
    <View style={sheetStyles.modelRow}>
      <ModelCheckbox
        checked={!hidden}
        onToggle={handleToggle}
        disabled={disabled}
        accessibilityLabel={t(
          hidden ? "settings.providers.models.showModel" : "settings.providers.models.hideModel",
          { name: model.label },
        )}
        testID={`model-toggle-${model.id}`}
      />
      <Text
        style={[sheetStyles.modelTitle, hidden ? sheetStyles.modelTitleHidden : null]}
        numberOfLines={1}
      >
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      {model.description ? (
        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
          {model.description}
        </Text>
      ) : null}
    </View>
  );
}

function CustomModelRow({
  model,
  hidden,
  deleting,
  disabled,
  onToggleHidden,
  onDelete,
}: {
  model: ProviderProfileModel;
  hidden: boolean;
  deleting: boolean;
  disabled?: boolean;
  onToggleHidden: (modelId: string, nextHidden: boolean) => void;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const handleToggle = useCallback(() => {
    onToggleHidden(model.id, !hidden);
  }, [model.id, hidden, onToggleHidden]);
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );

  return (
    <View style={sheetStyles.modelRow}>
      <ModelCheckbox
        checked={!hidden}
        onToggle={handleToggle}
        disabled={disabled || deleting}
        accessibilityLabel={t(
          hidden ? "settings.providers.models.showModel" : "settings.providers.models.hideModel",
          { name: model.label },
        )}
        testID={`custom-model-toggle-${model.id}`}
      />
      <Text
        style={[sheetStyles.modelTitle, hidden ? sheetStyles.modelTitleHidden : null]}
        numberOfLines={1}
      >
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      <View style={sheetStyles.modelRowFiller} />
      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        hitSlop={8}
        style={deleteButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.models.removeModel", { id: model.id })}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
      </Pressable>
    </View>
  );
}

function AddCustomModelSubSheet({
  provider,
  serverId,
  visible,
  onClose,
  refresh,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const trimmed = input.trim();
  const canAdd = trimmed.length > 0 && !additionalModels.some((model) => model.id === trimmed);

  useEffect(() => {
    if (!visible) {
      setInput("");
      setError(null);
    }
  }, [visible]);

  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    setError(null);
    setSaving(true);
    void patchConfig({
      providers: {
        [provider]: {
          additionalModels: [...additionalModels, { id: trimmed, label: trimmed }],
        },
      },
    })
      .then(() => refresh([provider]))
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("settings.providers.models.failedToSave"));
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, onClose, patchConfig, provider, refresh, t, trimmed]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.providers.models.addCustomTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={420}
      snapPoints={ADD_SNAP_POINTS}
      testID="add-custom-model-sheet"
    >
      <View style={sheetStyles.formGroup}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.modelId")}</Text>
        <AdaptiveTextInput
          initialValue={input}
          resetKey={`add-custom-${visible}`}
          onChangeText={setInput}
          onSubmitEditing={handleAdd}
          placeholder={t("settings.providers.models.modelIdPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        <View style={sheetStyles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleAdd} disabled={!canAdd || saving}>
            {saving ? t("settings.providers.models.adding") : t("settings.providers.models.add")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function DiagnosticSubSheet({
  provider,
  serverId,
  visible,
  onClose,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiagnostic = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.getProviderDiagnostic(provider);
      setDiagnostic(result.diagnostic);
    } catch (err) {
      setDiagnostic(
        err instanceof Error ? err.message : t("settings.providers.diagnostic.failedToFetch"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, provider, t]);

  useEffect(() => {
    if (visible) {
      void fetchDiagnostic();
    } else {
      setDiagnostic(null);
    }
  }, [visible, fetchDiagnostic]);

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      loading ? sheetStyles.disabled : null,
    ],
    [loading],
  );

  const handleRefreshPress = useCallback(() => {
    void fetchDiagnostic();
  }, [fetchDiagnostic]);

  const copyButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && Boolean(diagnostic) && sheetStyles.iconButtonHovered,
      diagnostic ? null : sheetStyles.disabled,
    ],
    [diagnostic],
  );

  const handleCopyPress = useCallback(() => {
    if (!diagnostic) return;
    void Clipboard.setStringAsync(diagnostic)
      .then(() => toast.copied(t("settings.providers.diagnostic.copyLabel")))
      .catch(() => toast.error(t("settings.providers.diagnostic.copyFailed")));
  }, [diagnostic, t, toast]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.diagnostic.title"),
      actions: (
        <View style={sheetStyles.headerActions}>
          <Pressable
            onPress={handleCopyPress}
            disabled={!diagnostic}
            hitSlop={8}
            style={copyButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.providers.diagnostic.copyAccessibility")}
          >
            <Copy size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={handleRefreshPress}
            disabled={loading}
            hitSlop={8}
            style={refreshButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={
              loading
                ? t("settings.providers.diagnostic.refreshingAccessibility")
                : t("settings.providers.diagnostic.refreshAccessibility")
            }
          >
            {loading ? (
              <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      ),
    }),
    [
      copyButtonStyle,
      diagnostic,
      handleCopyPress,
      handleRefreshPress,
      loading,
      refreshButtonStyle,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  let body: React.ReactNode;
  if (loading && !diagnostic) {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.running")}</Text>
        </View>
      </SurfaceCard>
    );
  } else if (diagnostic) {
    body = (
      <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={480}>
        {diagnostic}
      </ScrollableCodeSurface>
    );
  } else {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.none")}</Text>
        </View>
      </SurfaceCard>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SNAP_POINTS}
      scrollable={false}
      testID="provider-diagnostic-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

interface ProviderModalBodyProps {
  discoveredCount: number;
  additionalCount: number;
  providerSnapshotRefreshing: boolean;
  providerErrorMessage: string | null;
  modelsRefreshing: boolean;
  searchActive: boolean;
  filteredDiscovered: AgentModelDefinition[];
  filteredCustom: ProviderProfileModel[];
  hiddenModels: readonly string[];
  togglingModelId: string | null;
  isTogglingBulk: boolean;
  deletingModelId: string | null;
  onRefresh: () => void;
  onToggleModelHidden: (modelId: string, nextHidden: boolean) => void;
  onCheckAllDiscovered: () => void;
  onUncheckAllDiscovered: () => void;
  onCheckAllCustom: () => void;
  onUncheckAllCustom: () => void;
  onDeleteCustom: (modelId: string) => void;
  theme: { iconSize: { md: number }; colors: { foregroundMuted: string } };
}

interface ProviderSheetFooterInput {
  fetchedAtLabel: string | null;
  isCompact: boolean;
  modelsRefreshing: boolean;
  t: TFunction;
  onOpenAddSheet: () => void;
  onOpenDiagSheet: () => void;
  onRefreshModels: () => void;
}

function renderProviderSheetFooter({
  fetchedAtLabel,
  isCompact,
  modelsRefreshing,
  t,
  onOpenAddSheet,
  onOpenDiagSheet,
  onRefreshModels,
}: ProviderSheetFooterInput) {
  const contentStyle = isCompact ? sheetStyles.compactFooterContent : sheetStyles.footerContent;
  const actionsStyle = isCompact ? sheetStyles.compactFooterActions : sheetStyles.footerActions;
  const buttonStyle = isCompact ? sheetStyles.compactFooterButton : null;
  const metaStyle = isCompact
    ? [sheetStyles.footerMeta, sheetStyles.compactFooterMeta]
    : sheetStyles.footerMeta;

  return (
    <View style={contentStyle}>
      {fetchedAtLabel || !isCompact ? (
        <Text style={metaStyle} numberOfLines={1}>
          {fetchedAtLabel ? t("settings.providers.models.updated", { time: fetchedAtLabel }) : ""}
        </Text>
      ) : null}
      <View style={actionsStyle}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          onPress={onOpenAddSheet}
          style={buttonStyle}
        >
          {t("settings.providers.models.addModel")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={FileText}
          onPress={onOpenDiagSheet}
          style={buttonStyle}
        >
          {t("settings.providers.diagnostic.button")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={modelsRefreshing ? undefined : RotateCw}
          onPress={onRefreshModels}
          disabled={modelsRefreshing}
          style={buttonStyle}
        >
          {modelsRefreshing
            ? t("settings.providers.diagnostic.refreshing")
            : t("settings.providers.diagnostic.refresh")}
        </Button>
      </View>
    </View>
  );
}

interface DiscoveredModelsSectionProps {
  models: AgentModelDefinition[];
  hiddenModels: readonly string[];
  togglingModelId: string | null;
  isTogglingBulk: boolean;
  onToggleModelHidden: (modelId: string, nextHidden: boolean) => void;
  onCheckAll: () => void;
  onUncheckAll: () => void;
}

function DiscoveredModelsSection({
  models,
  hiddenModels,
  togglingModelId,
  isTogglingBulk,
  onToggleModelHidden,
  onCheckAll,
  onUncheckAll,
}: DiscoveredModelsSectionProps) {
  const { t } = useTranslation();
  const allChecked = models.length > 0 && models.every((model) => !hiddenModels.includes(model.id));
  const allUnchecked =
    models.length > 0 && models.every((model) => hiddenModels.includes(model.id));

  const checkAllDisabled = isTogglingBulk || allChecked;
  const uncheckAllDisabled = isTogglingBulk || allUnchecked;

  return (
    <View style={sheetStyles.section}>
      <View style={sheetStyles.sectionHeader}>
        <View style={sheetStyles.sectionHeaderTitleGroup}>
          <Text style={settingsStyles.sectionHeaderTitle}>
            {t("settings.providers.models.discovered")}
          </Text>
          <View style={sheetStyles.sectionHeaderMeta}>
            <Text style={settingsStyles.sectionHeaderTitle}>{models.length}</Text>
          </View>
        </View>
        <View style={sheetStyles.bulkActionButtons}>
          <Button
            variant="ghost"
            size="xs"
            onPress={onCheckAll}
            disabled={checkAllDisabled}
            accessibilityLabel={t("settings.providers.models.checkAll")}
            testID="models-check-all-discovered"
          >
            {t("settings.providers.models.checkAll")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={onUncheckAll}
            disabled={uncheckAllDisabled}
            accessibilityLabel={t("settings.providers.models.uncheckAll")}
            testID="models-uncheck-all-discovered"
          >
            {t("settings.providers.models.uncheckAll")}
          </Button>
        </View>
      </View>
      <View style={settingsStyles.card}>
        {models.map((model) => (
          <DiscoveredModelRow
            key={model.id}
            model={model}
            hidden={hiddenModels.includes(model.id)}
            disabled={togglingModelId === model.id || isTogglingBulk}
            onToggleHidden={onToggleModelHidden}
          />
        ))}
      </View>
    </View>
  );
}

interface CustomModelsSectionProps {
  models: ProviderProfileModel[];
  hiddenModels: readonly string[];
  togglingModelId: string | null;
  isTogglingBulk: boolean;
  deletingModelId: string | null;
  onToggleModelHidden: (modelId: string, nextHidden: boolean) => void;
  onCheckAll: () => void;
  onUncheckAll: () => void;
  onDeleteCustom: (modelId: string) => void;
}

function CustomModelsSection({
  models,
  hiddenModels,
  togglingModelId,
  isTogglingBulk,
  deletingModelId,
  onToggleModelHidden,
  onCheckAll,
  onUncheckAll,
  onDeleteCustom,
}: CustomModelsSectionProps) {
  const { t } = useTranslation();
  const allChecked = models.length > 0 && models.every((model) => !hiddenModels.includes(model.id));
  const allUnchecked =
    models.length > 0 && models.every((model) => hiddenModels.includes(model.id));

  const checkAllDisabled = isTogglingBulk || allChecked;
  const uncheckAllDisabled = isTogglingBulk || allUnchecked;

  return (
    <View style={sheetStyles.section}>
      <View style={sheetStyles.sectionHeader}>
        <View style={sheetStyles.sectionHeaderTitleGroup}>
          <Text style={settingsStyles.sectionHeaderTitle}>
            {t("settings.providers.models.custom")}
          </Text>
          <View style={sheetStyles.sectionHeaderMeta}>
            <Text style={settingsStyles.sectionHeaderTitle}>{models.length}</Text>
          </View>
        </View>
        <View style={sheetStyles.bulkActionButtons}>
          <Button
            variant="ghost"
            size="xs"
            onPress={onCheckAll}
            disabled={checkAllDisabled}
            accessibilityLabel={t("settings.providers.models.checkAll")}
            testID="models-check-all-custom"
          >
            {t("settings.providers.models.checkAll")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={onUncheckAll}
            disabled={uncheckAllDisabled}
            accessibilityLabel={t("settings.providers.models.uncheckAll")}
            testID="models-uncheck-all-custom"
          >
            {t("settings.providers.models.uncheckAll")}
          </Button>
        </View>
      </View>
      <View style={settingsStyles.card}>
        {models.map((model) => (
          <CustomModelRow
            key={model.id}
            model={model}
            hidden={hiddenModels.includes(model.id)}
            deleting={deletingModelId === model.id}
            disabled={togglingModelId === model.id || isTogglingBulk}
            onToggleHidden={onToggleModelHidden}
            onDelete={onDeleteCustom}
          />
        ))}
      </View>
    </View>
  );
}

function ProviderModalBody(props: ProviderModalBodyProps) {
  const { t } = useTranslation();
  const {
    discoveredCount,
    additionalCount,
    providerSnapshotRefreshing,
    providerErrorMessage,
    modelsRefreshing,
    searchActive,
    filteredDiscovered,
    filteredCustom,
    hiddenModels,
    togglingModelId,
    isTogglingBulk,
    deletingModelId,
    onRefresh,
    onToggleModelHidden,
    onCheckAllDiscovered,
    onUncheckAllDiscovered,
    onCheckAllCustom,
    onUncheckAllCustom,
    onDeleteCustom,
    theme,
  } = props;

  if (discoveredCount === 0 && additionalCount === 0 && providerSnapshotRefreshing) {
    return (
      <View style={sheetStyles.emptyState}>
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.loading")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0 && providerErrorMessage) {
    return (
      <View style={sheetStyles.emptyState}>
        <AlertTriangle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        <Button variant="default" size="sm" onPress={onRefresh} disabled={modelsRefreshing}>
          {modelsRefreshing
            ? t("settings.providers.models.retrying")
            : t("settings.providers.models.retry")}
        </Button>
      </View>
    );
  }
  if (filteredDiscovered.length === 0 && filteredCustom.length === 0 && searchActive) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noSearchMatches")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noneDetected")}</Text>
      </View>
    );
  }
  return (
    <>
      {filteredDiscovered.length > 0 ? (
        <DiscoveredModelsSection
          models={filteredDiscovered}
          hiddenModels={hiddenModels}
          togglingModelId={togglingModelId}
          isTogglingBulk={isTogglingBulk}
          onToggleModelHidden={onToggleModelHidden}
          onCheckAll={onCheckAllDiscovered}
          onUncheckAll={onUncheckAllDiscovered}
        />
      ) : null}
      {filteredCustom.length > 0 ? (
        <CustomModelsSection
          models={filteredCustom}
          hiddenModels={hiddenModels}
          togglingModelId={togglingModelId}
          isTogglingBulk={isTogglingBulk}
          deletingModelId={deletingModelId}
          onToggleModelHidden={onToggleModelHidden}
          onCheckAll={onCheckAllCustom}
          onUncheckAll={onUncheckAllCustom}
          onDeleteCustom={onDeleteCustom}
        />
      ) : null}
    </>
  );
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
}: ProviderDiagnosticSheetProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [query, setQuery] = useState("");
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [diagSheetOpen, setDiagSheetOpen] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);
  const [isTogglingBulk, setIsTogglingBulk] = useState(false);
  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const hiddenModels = useMemo(
    () => config?.providers?.[provider]?.hiddenModels ?? [],
    [config?.providers, provider],
  );
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error"
      ? (providerEntry.error ?? t("settings.providers.diagnostic.unknownError"))
      : null;
  const modelsRefreshing = isRefreshing || providerSnapshotRefreshing;

  const stableDiscoveredRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const currentModels = providerEntry?.models;
  const { models: discoveredModels, cache: nextDiscoveredCache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    currentModels,
    hiddenModels,
    providerSnapshotRefreshing,
    previousCache: stableDiscoveredRef.current,
  });
  stableDiscoveredRef.current = nextDiscoveredCache;

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
  }, [providerEntry?.fetchedAt, clockTick]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setAddSheetOpen(false);
      setDiagSheetOpen(false);
    }
  }, [visible]);

  const q = query.trim();
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );
  const filteredCustom = useMemo(
    () => rankModels(additionalModels, q, (m) => [m.label, m.id]),
    [additionalModels, q],
  );

  const handleRefreshModels = useCallback(() => {
    void refresh([provider]);
  }, [provider, refresh]);

  const handleOpenAddSheet = useCallback(() => setAddSheetOpen(true), []);
  const handleCloseAddSheet = useCallback(() => setAddSheetOpen(false), []);
  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);
  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);

  const handleToggleModelHidden = useCallback(
    (modelId: string, nextHidden: boolean) => {
      setTogglingModelId(modelId);
      const nextHiddenModels = nextHidden
        ? Array.from(new Set([...hiddenModels, modelId]))
        : hiddenModels.filter((id) => id !== modelId);

      void patchConfig({
        providers: {
          [provider]: {
            hiddenModels: nextHiddenModels,
          },
        },
      })
        .then(() => refresh([provider]))
        .finally(() => {
          setTogglingModelId((current) => (current === modelId ? null : current));
        });
    },
    [hiddenModels, patchConfig, provider, refresh],
  );

  const handleCheckAllDiscovered = useCallback(() => {
    setIsTogglingBulk(true);
    const discoveredIds = new Set(discoveredModels.map((m) => m.id));
    const nextHiddenModels = hiddenModels.filter((id) => !discoveredIds.has(id));
    void patchConfig({
      providers: {
        [provider]: {
          hiddenModels: nextHiddenModels,
        },
      },
    })
      .then(() => refresh([provider]))
      .finally(() => setIsTogglingBulk(false));
  }, [discoveredModels, hiddenModels, patchConfig, provider, refresh]);

  const handleUncheckAllDiscovered = useCallback(() => {
    setIsTogglingBulk(true);
    const allDiscoveredIds = discoveredModels.map((m) => m.id);
    const nextHiddenModels = Array.from(new Set([...hiddenModels, ...allDiscoveredIds]));
    void patchConfig({
      providers: {
        [provider]: {
          hiddenModels: nextHiddenModels,
        },
      },
    })
      .then(() => refresh([provider]))
      .finally(() => setIsTogglingBulk(false));
  }, [discoveredModels, hiddenModels, patchConfig, provider, refresh]);

  const handleCheckAllCustom = useCallback(() => {
    setIsTogglingBulk(true);
    const customIds = new Set(additionalModels.map((m) => m.id));
    const nextHiddenModels = hiddenModels.filter((id) => !customIds.has(id));
    void patchConfig({
      providers: {
        [provider]: {
          hiddenModels: nextHiddenModels,
        },
      },
    })
      .then(() => refresh([provider]))
      .finally(() => setIsTogglingBulk(false));
  }, [additionalModels, hiddenModels, patchConfig, provider, refresh]);

  const handleUncheckAllCustom = useCallback(() => {
    setIsTogglingBulk(true);
    const allCustomIds = additionalModels.map((m) => m.id);
    const nextHiddenModels = Array.from(new Set([...hiddenModels, ...allCustomIds]));
    void patchConfig({
      providers: {
        [provider]: {
          hiddenModels: nextHiddenModels,
        },
      },
    })
      .then(() => refresh([provider]))
      .finally(() => setIsTogglingBulk(false));
  }, [additionalModels, hiddenModels, patchConfig, provider, refresh]);
  const handleDeleteCustom = useCallback(
    (modelId: string) => {
      setDeletingModelId(modelId);
      void patchConfig({
        providers: {
          [provider]: {
            additionalModels: additionalModels.filter((model) => model.id !== modelId),
          },
        },
      })
        .then(() => refresh([provider]))
        .finally(() => {
          setDeletingModelId((current) => (current === modelId ? null : current));
        });
    },
    [additionalModels, patchConfig, provider, refresh],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: providerLabel,
      search: {
        onChange: setQuery,
        placeholder: t("settings.providers.models.searchPlaceholder"),
        testID: "provider-settings-search",
      },
    }),
    [providerLabel, t],
  );

  return (
    <>
      <AdaptiveModalSheet
        header={sheetHeader}
        visible={visible}
        onClose={onClose}
        testID="provider-settings-sheet"
        footer={renderProviderSheetFooter({
          fetchedAtLabel,
          isCompact,
          modelsRefreshing,
          t,
          onOpenAddSheet: handleOpenAddSheet,
          onOpenDiagSheet: handleOpenDiagSheet,
          onRefreshModels: handleRefreshModels,
        })}
        snapPoints={MAIN_SNAP_POINTS}
      >
        <ProviderModalBody
          discoveredCount={discoveredModels.length}
          additionalCount={additionalModels.length}
          providerSnapshotRefreshing={providerSnapshotRefreshing}
          providerErrorMessage={providerErrorMessage}
          modelsRefreshing={modelsRefreshing}
          searchActive={Boolean(q)}
          filteredDiscovered={filteredDiscovered}
          filteredCustom={filteredCustom}
          hiddenModels={hiddenModels}
          togglingModelId={togglingModelId}
          isTogglingBulk={isTogglingBulk}
          deletingModelId={deletingModelId}
          onRefresh={handleRefreshModels}
          onToggleModelHidden={handleToggleModelHidden}
          onCheckAllDiscovered={handleCheckAllDiscovered}
          onUncheckAllDiscovered={handleUncheckAllDiscovered}
          onCheckAllCustom={handleCheckAllCustom}
          onUncheckAllCustom={handleUncheckAllCustom}
          onDeleteCustom={handleDeleteCustom}
          theme={theme}
        />
      </AdaptiveModalSheet>
      <AddCustomModelSubSheet
        provider={provider}
        serverId={serverId}
        visible={addSheetOpen}
        onClose={handleCloseAddSheet}
        refresh={refresh}
      />
      <DiagnosticSubSheet
        provider={provider}
        serverId={serverId}
        visible={diagSheetOpen}
        onClose={handleCloseDiagSheet}
      />
    </>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  descriptionInline: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  disabled: {
    opacity: 0.5,
  },
  section: {
    marginBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  sectionHeaderTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sectionHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  bulkActionButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  sectionHeaderMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  checkboxPressable: {
    padding: theme.spacing[0.5] ?? 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  modelTitleHidden: {
    color: theme.colors.foregroundMuted,
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  emptyState: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  compactFooterContent: {
    flex: 1,
    gap: theme.spacing[2],
  },
  footerMeta: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  compactFooterMeta: {
    flex: 0,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  compactFooterActions: {
    gap: theme.spacing[2],
  },
  compactFooterButton: {
    alignSelf: "stretch",
  },
  formGroup: {
    gap: theme.spacing[3],
  },
  formLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const MAIN_SNAP_POINTS = ["65%", "92%"];
const ADD_SNAP_POINTS = ["40%"];
const DIAGNOSTIC_SNAP_POINTS = ["50%", "85%"];
