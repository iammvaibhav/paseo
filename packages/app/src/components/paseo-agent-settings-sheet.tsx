import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { RedactedPaseoAgentProviderConfig } from "@getpaseo/protocol/messages";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { usePaseoAgentProviders } from "@/hooks/use-paseo-agent-providers";
import {
  createOpenRouterProviderInput,
  parsePaseoAgentModelIds,
  paseoAgentAuthLabel,
} from "./paseo-agent-settings-sheet-model";

interface PaseoAgentSettingsSheetProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}

const MAIN_SNAP_POINTS = ["65%", "92%"];
const ADD_SNAP_POINTS = ["70%", "92%"];
const HEADER: SheetHeader = { title: "Paseo Agent" };
const ADD_HEADER: SheetHeader = { title: "Add OpenRouter provider" };
const DEFAULT_PROVIDER_NAME = "openrouter";

function ProviderRow({ provider }: { provider: RedactedPaseoAgentProviderConfig }) {
  const modelCount = provider.models.length;
  const modelLabel = modelCount === 1 ? "1 model" : `${modelCount} models`;
  const auth = paseoAgentAuthLabel(provider.auth);
  return (
    <View
      style={styles.providerRow}
      accessible
      role="listitem"
      accessibilityLabel={`${provider.name}, ${provider.providerType}, ${modelLabel}, ${auth}`}
    >
      <View style={provider.available ? styles.dotAvailable : styles.dotMuted} />
      <View style={styles.providerText}>
        <Text style={styles.providerName} numberOfLines={1}>
          {provider.name}
        </Text>
        <Text style={styles.providerMeta} numberOfLines={1}>
          {provider.providerType} · {modelLabel} · {auth}
        </Text>
      </View>
    </View>
  );
}

function AddOpenRouterSubSheet({
  serverId,
  visible,
  onClose,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { setProvider } = usePaseoAgentProviders(serverId);
  const [name, setName] = useState(DEFAULT_PROVIDER_NAME);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetKey, bumpResetKey] = useReducer((key: number) => key + 1, 0);

  useEffect(() => {
    if (!visible) {
      setName(DEFAULT_PROVIDER_NAME);
      setApiKey("");
      setModels("");
      setError(null);
      setSaving(false);
      bumpResetKey();
    }
  }, [visible]);

  const trimmedName = name.trim();
  const modelIds = useMemo(() => parsePaseoAgentModelIds(models), [models]);
  const canSubmit = trimmedName.length > 0 && modelIds.length > 0 && !saving;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    void setProvider(createOpenRouterProviderInput({ name: trimmedName, apiKey, modelIds }))
      .then(() => {
        setApiKey("");
        onClose();
        return undefined;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to save provider");
      })
      .finally(() => setSaving(false));
  }, [apiKey, canSubmit, modelIds, onClose, setProvider, trimmedName]);

  return (
    <AdaptiveModalSheet
      header={ADD_HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={480}
      snapPoints={ADD_SNAP_POINTS}
      testID="paseo-openrouter-sheet"
    >
      <View style={styles.formGroup}>
        <Text style={styles.formLabel}>Provider name</Text>
        <AdaptiveTextInput
          testID="paseo-openrouter-name"
          accessibilityLabel="Provider name"
          initialValue={name}
          resetKey={`paseo-openrouter-name-${resetKey}`}
          value={name}
          onChangeText={setName}
          placeholder={DEFAULT_PROVIDER_NAME}
          autoCapitalize="none"
          autoCorrect={false}
          // @ts-expect-error - outlineStyle is web-only
          style={FORM_INPUT_STYLE}
        />

        <Text style={styles.formLabel}>API key</Text>
        <AdaptiveTextInput
          testID="paseo-openrouter-api-key"
          accessibilityLabel="OpenRouter API key"
          initialValue={apiKey}
          resetKey={`paseo-openrouter-api-key-${resetKey}`}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="sk-or-…"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          // @ts-expect-error - outlineStyle is web-only
          style={FORM_INPUT_STYLE}
        />
        <Text style={styles.formHint}>
          Stored on the host and never shown again. Leave blank to use OPENROUTER_API_KEY on the
          host.
        </Text>

        <Text style={styles.formLabel}>Models</Text>
        <AdaptiveTextInput
          testID="paseo-openrouter-models"
          accessibilityLabel="OpenRouter models"
          initialValue={models}
          resetKey={`paseo-openrouter-models-${resetKey}`}
          value={models}
          onChangeText={setModels}
          placeholder={"anthropic/claude-3.7-sonnet\nopenai/gpt-4o"}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          // @ts-expect-error - outlineStyle is web-only
          style={MODELS_INPUT_STYLE}
        />
        <Text style={styles.formHint}>One model id per line, or comma-separated.</Text>

        {error ? (
          <Text style={styles.errorText} testID="paseo-openrouter-error">
            {error}
          </Text>
        ) : null}

        <View style={styles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleSubmit}
            disabled={!canSubmit}
            testID="paseo-openrouter-submit"
          >
            {saving ? "Saving…" : "Save provider"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

export function PaseoAgentSettingsSheet({
  serverId,
  visible,
  onClose,
}: PaseoAgentSettingsSheetProps) {
  const { supported, providers, isLoading, error } = usePaseoAgentProviders(serverId);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!visible) {
      setAddOpen(false);
    }
  }, [visible]);

  const handleOpenAdd = useCallback(() => setAddOpen(true), []);
  const handleCloseAdd = useCallback(() => setAddOpen(false), []);

  const footer = useMemo(() => {
    if (!supported) {
      return undefined;
    }
    return (
      <View style={styles.footerActions}>
        <Button
          variant="default"
          size="sm"
          leftIcon={Plus}
          onPress={handleOpenAdd}
          testID="paseo-agent-add-openrouter"
        >
          Add OpenRouter
        </Button>
      </View>
    );
  }, [supported, handleOpenAdd]);

  let body: React.ReactNode;
  if (!supported) {
    body = (
      <View style={styles.stateBox} testID="paseo-agent-unsupported">
        <Text style={styles.stateText}>Update the host to configure Paseo Agent.</Text>
      </View>
    );
  } else if (error) {
    body = (
      <View style={styles.stateBox}>
        <Text style={styles.stateText}>{error}</Text>
      </View>
    );
  } else if (isLoading) {
    body = (
      <View style={styles.stateBox}>
        <Text style={styles.stateText}>Loading…</Text>
      </View>
    );
  } else if (providers.length === 0) {
    body = (
      <View style={styles.stateBox}>
        <Text style={styles.stateText}>No inference providers configured yet.</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.list} accessibilityRole="list">
        {providers.map((provider) => (
          <ProviderRow key={provider.name} provider={provider} />
        ))}
      </View>
    );
  }

  return (
    <>
      <AdaptiveModalSheet
        header={HEADER}
        visible={visible}
        onClose={onClose}
        footer={footer}
        snapPoints={MAIN_SNAP_POINTS}
        testID="paseo-agent-settings-sheet"
      >
        {body}
      </AdaptiveModalSheet>
      {supported ? (
        <AddOpenRouterSubSheet serverId={serverId} visible={addOpen} onClose={handleCloseAdd} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  providerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  providerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  providerName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  providerMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  dotAvailable: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotMuted: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  stateBox: {
    minHeight: 96,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  footerActions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  formGroup: {
    gap: theme.spacing[2],
  },
  formLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    marginTop: theme.spacing[2],
  },
  formHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
  },
  modelsInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
}));

const FORM_INPUT_STYLE = [styles.formInput, isWeb && { outlineStyle: "none" }];
const MODELS_INPUT_STYLE = [
  styles.formInput,
  styles.modelsInput,
  isWeb && { outlineStyle: "none" },
];
