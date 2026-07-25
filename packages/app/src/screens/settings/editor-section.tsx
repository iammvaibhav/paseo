import { Switch, Text, View, type ViewStyle } from "react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import type { DefaultFileOpener, PlannotatorFeedbackMode } from "@/hooks/use-settings/storage";
import { SettingsSection } from "./settings-section";
import { settingsStyles } from "@/styles/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";

const CONTROL_STYLE: ViewStyle = {
  marginTop: 8,
};

export function EditorSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const handleVimChange = useCallback(
    (vimKeybindings: boolean) => void updateSettings({ vimKeybindings }),
    [updateSettings],
  );
  const handleDefaultFileOpenerChange = useCallback(
    (defaultFileOpener: DefaultFileOpener) => void updateSettings({ defaultFileOpener }),
    [updateSettings],
  );
  const handleFeedbackModeChange = useCallback(
    (plannotatorFeedbackMode: PlannotatorFeedbackMode) =>
      void updateSettings({ plannotatorFeedbackMode }),
    [updateSettings],
  );
  const defaultFileOpenerOptions = useMemo<Array<SegmentedControlOption<DefaultFileOpener>>>(
    () => [
      { value: "paseo", label: t("settings.editor.defaultFileOpenerPaseo") },
      { value: "vscode-web", label: t("settings.editor.defaultFileOpenerVsCodeWeb") },
      { value: "plannotator", label: t("settings.editor.defaultFileOpenerPlannotator") },
    ],
    [t],
  );
  const feedbackModeOptions = useMemo<Array<SegmentedControlOption<PlannotatorFeedbackMode>>>(
    () => [
      { value: "auto-send", label: t("settings.editor.plannotatorFeedbackAutoSend") },
      { value: "compose", label: t("settings.editor.plannotatorFeedbackCompose") },
    ],
    [t],
  );

  return (
    <SettingsSection title={t("settings.editor.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.editor.vimKeybindings")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.editor.vimHint")}</Text>
          </View>
          <Switch
            value={settings.vimKeybindings}
            onValueChange={handleVimChange}
            accessibilityLabel={t("settings.editor.vimKeybindings")}
            testID="vim-keybindings-toggle"
          />
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.editor.defaultFileOpener")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.editor.defaultFileOpenerHint")}</Text>
            <SegmentedControl
              options={defaultFileOpenerOptions}
              value={settings.defaultFileOpener}
              onValueChange={handleDefaultFileOpenerChange}
              size="sm"
              style={CONTROL_STYLE}
              testID="default-file-opener"
            />
          </View>
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.editor.plannotatorFeedbackMode")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.editor.plannotatorFeedbackModeHint")}
            </Text>
            <SegmentedControl
              options={feedbackModeOptions}
              value={settings.plannotatorFeedbackMode}
              onValueChange={handleFeedbackModeChange}
              size="sm"
              style={CONTROL_STYLE}
              testID="plannotator-feedback-mode"
            />
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}
