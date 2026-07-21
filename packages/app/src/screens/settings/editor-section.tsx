import { Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import type { PlannotatorFeedbackMode } from "@/hooks/use-settings/storage";
import { SettingsSection } from "./settings-section";
import { settingsStyles } from "@/styles/settings";

const MODE_ROW_STYLE: ViewStyle = {
  flexDirection: "row",
  gap: 8,
  marginTop: 8,
};

const MODE_BUTTON_BASE: ViewStyle = {
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 8,
  borderWidth: 1,
};

function FeedbackModeButton(props: {
  mode: PlannotatorFeedbackMode;
  label: string;
  selected: boolean;
  onSelect: (mode: PlannotatorFeedbackMode) => void;
}) {
  const handlePress = useCallback(() => {
    props.onSelect(props.mode);
  }, [props]);
  const accessibilityState = useMemo(() => ({ selected: props.selected }), [props.selected]);
  const style = useMemo(
    (): StyleProp<ViewStyle> => [MODE_BUTTON_BASE, { opacity: props.selected ? 1 : 0.7 }],
    [props.selected],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={style}
      testID={`plannotator-feedback-mode-${props.mode}`}
    >
      <Text style={settingsStyles.rowTitle}>{props.label}</Text>
    </Pressable>
  );
}

export function EditorSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const handleVimChange = useCallback(
    (vimKeybindings: boolean) => void updateSettings({ vimKeybindings }),
    [updateSettings],
  );
  const handleMarkdownPlannotatorChange = useCallback(
    (openMarkdownInPlannotator: boolean) => void updateSettings({ openMarkdownInPlannotator }),
    [updateSettings],
  );
  const handleFeedbackModeChange = useCallback(
    (plannotatorFeedbackMode: PlannotatorFeedbackMode) =>
      void updateSettings({ plannotatorFeedbackMode }),
    [updateSettings],
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
            <Text style={settingsStyles.rowTitle}>
              {t("settings.editor.openMarkdownInPlannotator")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.editor.openMarkdownInPlannotatorHint")}
            </Text>
          </View>
          <Switch
            value={settings.openMarkdownInPlannotator}
            onValueChange={handleMarkdownPlannotatorChange}
            accessibilityLabel={t("settings.editor.openMarkdownInPlannotator")}
            testID="open-markdown-plannotator-toggle"
          />
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.editor.plannotatorFeedbackMode")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.editor.plannotatorFeedbackModeHint")}
            </Text>
            <View style={MODE_ROW_STYLE}>
              <FeedbackModeButton
                mode="auto-send"
                label={t("settings.editor.plannotatorFeedbackAutoSend")}
                selected={settings.plannotatorFeedbackMode === "auto-send"}
                onSelect={handleFeedbackModeChange}
              />
              <FeedbackModeButton
                mode="compose"
                label={t("settings.editor.plannotatorFeedbackCompose")}
                selected={settings.plannotatorFeedbackMode === "compose"}
                onSelect={handleFeedbackModeChange}
              />
            </View>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}
