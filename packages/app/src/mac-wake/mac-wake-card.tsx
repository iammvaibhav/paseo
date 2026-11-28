import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";
import {
  lanAddressFromHost,
  validateMacWakeDraft,
  type MacWakeDraft,
  type MacWakeDraftErrors,
} from "./config";
import { macWakeNative, type MacWakeNative, type MacWakeNativeConfig } from "./native";

type RunState =
  | { status: "idle" }
  | { status: "running"; action: "wake" | "letSleep" }
  | { status: "done"; message: string }
  | { status: "failed"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wake Mac (iOS only): set up on the Mac's host page, then Wake / Let sleep from there. */
export function MacWakeCard({ host }: { host: HostProfile }) {
  if (!macWakeNative) return null;
  return <MacWakeCardContent host={host} native={macWakeNative} />;
}

function MacWakeCardContent({ host, native }: { host: HostProfile; native: MacWakeNative }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<MacWakeNativeConfig>(() => native.getConfig());
  const [isEditing, setIsEditing] = useState(false);
  const [run, setRun] = useState<RunState>({ status: "idle" });

  const attachedHere = config.host !== null && config.serverId === host.serverId;
  const refreshConfig = useCallback(() => setConfig(native.getConfig()), [native]);
  const openEditor = useCallback(() => setIsEditing(true), []);
  const closeEditor = useCallback(() => setIsEditing(false), []);

  const runAction = useCallback(
    (action: "wake" | "letSleep") => {
      setRun({ status: "running", action });
      void native[action]()
        .then((message) => setRun({ status: "done", message }))
        .catch((error: unknown) => setRun({ status: "failed", message: errorMessage(error) }));
    },
    [native],
  );
  const handleWake = useCallback(() => runAction("wake"), [runAction]);
  const handleLetSleep = useCallback(() => runAction("letSleep"), [runAction]);

  // Configured for another host: its buttons live on that host's page.
  if (config.host !== null && !attachedHere) return null;

  const isRunning = run.status === "running";
  return (
    <View style={settingsStyles.card} testID="host-page-mac-wake-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.daemon.macWake.title")}</Text>
          <Text style={settingsStyles.rowHint}>
            {attachedHere
              ? `${config.host} · ${config.mac}`
              : t("settings.host.daemon.macWake.hint")}
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          onPress={openEditor}
          disabled={isRunning}
          testID="host-page-mac-wake-edit-button"
        >
          {attachedHere
            ? t("settings.host.daemon.macWake.edit")
            : t("settings.host.daemon.macWake.setUp")}
        </Button>
      </View>

      {attachedHere ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.actions}>
              <Button
                variant="default"
                size="sm"
                onPress={handleWake}
                disabled={isRunning}
                loading={isRunning && run.action === "wake"}
                testID="host-page-mac-wake-wake-button"
              >
                {t("settings.host.daemon.macWake.wake")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={handleLetSleep}
                disabled={isRunning}
                loading={isRunning && run.action === "letSleep"}
                testID="host-page-mac-wake-sleep-button"
              >
                {t("settings.host.daemon.macWake.letSleep")}
              </Button>
            </View>
            {run.status === "done" ? (
              <Text style={settingsStyles.rowHint} testID="host-page-mac-wake-result">
                {run.message}
              </Text>
            ) : null}
            {run.status === "failed" ? (
              <Text style={settingsStyles.rowError} testID="host-page-mac-wake-error">
                {run.message}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {isEditing ? (
        <MacWakeSetupModal
          host={host}
          native={native}
          config={config}
          onClose={closeEditor}
          onSaved={refreshConfig}
        />
      ) : null}
    </View>
  );
}

interface MacWakeSetupModalProps {
  host: HostProfile;
  native: MacWakeNative;
  config: MacWakeNativeConfig;
  onClose: () => void;
  onSaved: () => void;
}

/** Mounted fresh per open, so every open starts from the saved settings. */
function MacWakeSetupModal({ host, native, config, onClose, onSaved }: MacWakeSetupModalProps) {
  const { t } = useTranslation();
  const [initialDraft] = useState<MacWakeDraft>(() => ({
    host: config.host ?? lanAddressFromHost(host) ?? "",
    mac: config.mac ?? "",
    token: "",
  }));
  const [draft, setDraft] = useState<MacWakeDraft>(initialDraft);
  const [errors, setErrors] = useState<MacWakeDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.daemon.macWake.modalTitle") }),
    [t],
  );

  const setField = useCallback((field: keyof MacWakeDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }, []);
  const handleHostChange = useCallback((value: string) => setField("host", value), [setField]);
  const handleMacChange = useCallback((value: string) => setField("mac", value), [setField]);
  const handleTokenChange = useCallback((value: string) => setField("token", value), [setField]);

  const finish = useCallback(
    async (operation: Promise<void>) => {
      setIsPending(true);
      setSubmitError(null);
      try {
        await operation;
        onSaved();
        onClose();
      } catch (error) {
        setSubmitError(errorMessage(error));
        setIsPending(false);
      }
    },
    [onClose, onSaved],
  );

  const handleSave = useCallback(() => {
    if (isPending) return;
    const found = validateMacWakeDraft(draft, config.hasToken);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const token = draft.token.trim();
    void finish(
      native.saveConfig(
        draft.host.trim(),
        draft.mac.trim(),
        host.serverId,
        token.length > 0 ? token : null,
      ),
    );
  }, [config.hasToken, draft, finish, host.serverId, isPending, native]);

  const handleRemove = useCallback(() => {
    if (isPending) return;
    void finish(native.clearConfig());
  }, [finish, isPending, native]);

  const handleCancel = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={handleCancel}
      testID="host-page-mac-wake-modal"
      desktopMaxWidth={480}
    >
      <View style={styles.body}>
        <Field
          label={t("settings.host.daemon.macWake.hostLabel")}
          error={errors.host ? t("settings.host.daemon.macWake.hostRequired") : null}
        >
          <FormTextInput
            initialValue={initialDraft.host}
            onChangeText={handleHostChange}
            placeholder="192.168.1.20"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!isPending}
            accessibilityLabel={t("settings.host.daemon.macWake.hostLabel")}
            testID="host-page-mac-wake-host-input"
          />
        </Field>
        <Field
          label={t("settings.host.daemon.macWake.macLabel")}
          error={errors.mac ? t("settings.host.daemon.macWake.macInvalid") : null}
        >
          <FormTextInput
            initialValue={initialDraft.mac}
            onChangeText={handleMacChange}
            placeholder="ce:13:8b:1e:5b:10"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isPending}
            accessibilityLabel={t("settings.host.daemon.macWake.macLabel")}
            testID="host-page-mac-wake-mac-input"
          />
        </Field>
        <Field
          label={t("settings.host.daemon.macWake.tokenLabel")}
          error={errors.token ? t("settings.host.daemon.macWake.tokenRequired") : null}
        >
          <FormTextInput
            initialValue=""
            onChangeText={handleTokenChange}
            placeholder={
              config.hasToken
                ? t("settings.host.daemon.macWake.tokenSavedPlaceholder")
                : t("settings.host.daemon.macWake.tokenPlaceholder")
            }
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!isPending}
            accessibilityLabel={t("settings.host.daemon.macWake.tokenLabel")}
            testID="host-page-mac-wake-token-input"
          />
        </Field>

        {submitError ? <Text style={settingsStyles.rowError}>{submitError}</Text> : null}

        <View style={styles.actions}>
          {config.host !== null ? (
            <Button
              variant="destructive"
              onPress={handleRemove}
              disabled={isPending}
              testID="host-page-mac-wake-remove-button"
            >
              {t("settings.host.daemon.macWake.remove")}
            </Button>
          ) : null}
          <View style={styles.spacer} />
          <Button variant="secondary" onPress={handleCancel} disabled={isPending}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={isPending}
            loading={isPending}
            testID="host-page-mac-wake-save-button"
          >
            {t("common.actions.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spacer: {
    flex: 1,
  },
}));
