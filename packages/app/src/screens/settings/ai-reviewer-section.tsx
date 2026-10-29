import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsTextArea } from "@/components/settings-textarea";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

function resolveSelectedModel(
  providerValue?: string,
  modelValue?: string,
): { provider: string; model: string } {
  if (providerValue && modelValue) {
    const rawModel = modelValue.startsWith(`${providerValue}/`)
      ? modelValue.slice(providerValue.length + 1)
      : modelValue;
    return { provider: providerValue, model: rawModel };
  }
  if (!modelValue) return { provider: providerValue ?? "", model: "" };
  const separator = modelValue.indexOf("/");
  return separator > 0
    ? { provider: modelValue.slice(0, separator), model: modelValue.slice(separator + 1) }
    : { provider: providerValue ?? "", model: modelValue };
}

export function AiReviewerSection({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "aiReviewer");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries, isLoading } = useProvidersSnapshot(serverId, { enabled: isConnected });
  const [policyDraft, setPolicyDraft] = useState<string | null>(null);

  const enabled = config?.aiReviewer?.enabled === true;
  const selected = resolveSelectedModel(config?.aiReviewer?.provider, config?.aiReviewer?.model);
  const providers = useMemo(() => buildSelectableProviderSelectorProviders(entries), [entries]);
  const policy = config?.aiReviewer?.policy ?? "";
  const currentPolicyText = policyDraft ?? policy;
  const hasPolicyChanges = policyDraft !== null && policyDraft !== policy;

  const patchReviewer = useCallback(
    (updates: { enabled?: boolean; provider?: string; model?: string; policy?: string }) => {
      void patchConfig({ aiReviewer: { ...config?.aiReviewer, ...updates } });
    },
    [config?.aiReviewer, patchConfig],
  );

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      patchReviewer({ enabled: next });
    },
    [patchReviewer],
  );

  const handleModel = useCallback(
    (provider: AgentProvider, model: string) => {
      patchReviewer({ provider, model: `${provider}/${model}` });
    },
    [patchReviewer],
  );

  const handleClearModel = useCallback(() => {
    patchReviewer({ provider: "", model: "" });
  }, [patchReviewer]);

  const handlePolicyBlur = useCallback(() => {
    if (policyDraft !== null && policyDraft !== policy) {
      patchReviewer({ policy: policyDraft });
    }
    setPolicyDraft(null);
  }, [patchReviewer, policy, policyDraft]);

  const handlePolicySave = useCallback(() => {
    if (policyDraft !== null && policyDraft !== policy) {
      patchReviewer({ policy: policyDraft });
    }
    setPolicyDraft(null);
  }, [patchReviewer, policy, policyDraft]);

  const handlePolicyClear = useCallback(() => {
    setPolicyDraft("");
    patchReviewer({ policy: "" });
  }, [patchReviewer]);

  if (!isConnected || !isSupported) return null;

  return (
    <SettingsSection title="AI reviewer">
      <View style={settingsStyles.card} testID="host-page-ai-reviewer-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>AI reviewer</Text>
            <Text style={settingsStyles.rowHint}>
              Review permission requests automatically on this host. It is off by default.
            </Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={handleEnabledChange}
            accessibilityLabel="Enable AI reviewer"
            testID="host-page-ai-reviewer-enabled"
          />
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Reviewer model</Text>
            <Text style={settingsStyles.rowHint}>Choose a configured provider and model</Text>
          </View>
          <View style={styles.modelSelectorSlot}>
            <View style={styles.modelSelectorField}>
              <CombinedModelSelector
                providers={providers}
                selectedProvider={selected.provider}
                selectedModel={selected.model}
                onSelect={handleModel}
                isLoading={isLoading}
                disabled={providers.length === 0}
                serverId={serverId}
                triggerFill
              />
            </View>
            {selected.model ? (
              <Button
                variant="ghost"
                size="xs"
                onPress={handleClearModel}
                accessibilityLabel="Clear reviewer model"
                testID="host-page-ai-reviewer-model-clear"
              >
                Clear
              </Button>
            ) : null}
          </View>
        </View>

        <View style={[styles.policyRow, settingsStyles.rowBorder]}>
          <Text style={settingsStyles.rowTitle}>Policy</Text>
          <SettingsTextArea
            key={policy}
            accessibilityLabel="AI reviewer policy"
            value={currentPolicyText}
            onChangeText={setPolicyDraft}
            onBlur={handlePolicyBlur}
            placeholder="Escalate actions that could lose data or expose secrets."
            testID="host-page-ai-reviewer-policy"
          />
          <View style={styles.policyActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handlePolicyClear}
              disabled={currentPolicyText.length === 0}
              testID="host-page-ai-reviewer-policy-clear"
            >
              Clear policy
            </Button>
            {hasPolicyChanges ? (
              <Button
                variant="default"
                size="sm"
                onPress={handlePolicySave}
                testID="host-page-ai-reviewer-policy-save"
              >
                Save
              </Button>
            ) : null}
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  modelSelectorSlot: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelSelectorField: {
    minWidth: 200,
    maxWidth: 320,
    flexShrink: 1,
  },
  policyRow: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  policyActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
