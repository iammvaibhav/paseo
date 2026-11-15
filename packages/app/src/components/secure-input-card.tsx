import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, type KeyboardTypeOptions, type TextInputProps } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, LockKeyhole, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  SecureInputFormSchema,
  type SecureInputField,
  type SecureInputForm,
} from "@getpaseo/protocol/secure-input/rpc-schemas";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";

const ThemedLockIcon = withUnistyles(LockKeyhole);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The form of a secure input request, or null when the permission is something else. */
export function readSecureInputForm(request: AgentPermissionRequest): SecureInputForm | null {
  const parsed = SecureInputFormSchema.safeParse(request.metadata?.secureInput);
  return parsed.success ? parsed.data : null;
}

/** Masked unless the agent asked for a plain value; multi-line inputs cannot be masked. */
function isMasked(field: SecureInputField): boolean {
  if (field.type === "textarea") return false;
  return field.secret || field.type === "password" || field.type === "otp";
}

const KEYBOARD_TYPES: Partial<Record<SecureInputField["type"], KeyboardTypeOptions>> = {
  email: "email-address",
  url: "url",
  number: "numeric",
};

const AUTO_COMPLETE: Partial<Record<SecureInputField["type"], TextInputProps["autoComplete"]>> = {
  password: "current-password",
  otp: "one-time-code",
  email: "email",
  url: "url",
};

const TEXT_CONTENT_TYPE: Partial<
  Record<SecureInputField["type"], TextInputProps["textContentType"]>
> = {
  password: "password",
  otp: "oneTimeCode",
  email: "emailAddress",
  url: "URL",
};

interface SecureInputFieldRowProps {
  field: SecureInputField;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
  onSubmitEditing: () => void;
}

function SecureInputFieldRow({
  field,
  disabled,
  onChange,
  onSubmitEditing,
}: SecureInputFieldRowProps) {
  const { t } = useTranslation();
  const masked = isMasked(field);
  const [revealed, setRevealed] = useState(false);
  const handleChange = useCallback(
    (text: string) => onChange(field.name, text),
    [field.name, onChange],
  );
  const toggleReveal = useCallback(() => setRevealed((value) => !value), []);
  const label = field.required
    ? field.label
    : `${field.label} (${t("message.secureInput.optional")})`;
  const trailing = useMemo(
    () =>
      masked ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={toggleReveal}
          disabled={disabled}
          testID={`secure-input-reveal-${field.name}`}
        >
          {revealed ? t("message.secureInput.hide") : t("message.secureInput.show")}
        </Button>
      ) : null,
    [disabled, field.name, masked, revealed, t, toggleReveal],
  );
  return (
    <Field label={label} hint={field.description} trailing={trailing}>
      <FormTextInput
        testID={`secure-input-field-${field.name}`}
        accessibilityLabel={field.label}
        placeholder={field.placeholder}
        secureTextEntry={masked && !revealed}
        multiline={field.type === "textarea"}
        keyboardType={KEYBOARD_TYPES[field.type]}
        autoComplete={AUTO_COMPLETE[field.type] ?? "off"}
        textContentType={TEXT_CONTENT_TYPE[field.type]}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={!disabled}
        onChangeText={handleChange}
        onSubmitEditing={field.type === "textarea" ? undefined : onSubmitEditing}
      />
    </Field>
  );
}

interface SecureInputCardProps {
  request: AgentPermissionRequest;
  form: SecureInputForm;
  /** Sends the values to the host's secure input service. Rejects with the host's reason. */
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  isCancelling: boolean;
}

/**
 * The form an agent opens with request_secure_input. Values live in a ref, never in
 * React state, a query cache or a draft store, and leave only through `onSubmit`.
 */
export function SecureInputCard({
  request,
  form,
  onSubmit,
  onCancel,
  isCancelling,
}: SecureInputCardProps) {
  const { t } = useTranslation();
  const valuesRef = useRef<Record<string, string>>({});
  // Which fields hold text, so Submit can enable; never the text itself.
  const [filled, setFilled] = useState<ReadonlySet<string>>(() => new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback((name: string, value: string) => {
    valuesRef.current[name] = value;
    setFilled((current) => {
      if (current.has(name) === value.length > 0) return current;
      const next = new Set(current);
      if (value.length > 0) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  const busy = isSubmitting || isCancelling;
  const canSubmit = useMemo(
    () => form.fields.every((field) => !field.required || filled.has(field.name)),
    [filled, form.fields],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || busy) return;
    const values: Record<string, string> = {};
    for (const field of form.fields) {
      const value = valuesRef.current[field.name];
      if (value) values[field.name] = value;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(values);
      valuesRef.current = {};
    } catch (submitError) {
      setIsSubmitting(false);
      setError(
        submitError instanceof Error && submitError.message
          ? submitError.message
          : t("message.secureInput.submitFailed"),
      );
    }
  }, [busy, canSubmit, form.fields, onSubmit, t]);

  return (
    <View style={styles.container} testID="secure-input-card">
      <View style={styles.header}>
        <ThemedLockIcon size={16} uniProps={mutedColorMapping} />
        <Text style={styles.title}>{request.title ?? request.name}</Text>
      </View>
      {request.description ? <Text style={styles.description}>{request.description}</Text> : null}
      <View style={styles.fields}>
        {form.fields.map((field) => (
          <SecureInputFieldRow
            key={field.name}
            field={field}
            disabled={busy}
            onChange={handleChange}
            onSubmitEditing={handleSubmit}
          />
        ))}
      </View>
      <Text style={styles.hint}>{t("message.secureInput.hint")}</Text>
      {error ? <Alert variant="error" description={error} size="sm" /> : null}
      <View style={styles.actions}>
        <Button
          variant="secondary"
          leftIcon={X}
          onPress={onCancel}
          disabled={busy}
          loading={isCancelling}
          testID="secure-input-cancel"
        >
          {t("message.secureInput.cancel")}
        </Button>
        <Button
          variant="default"
          leftIcon={Check}
          onPress={handleSubmit}
          disabled={!canSubmit || busy}
          loading={isSubmitting}
          testID="secure-input-submit"
        >
          {t("message.secureInput.submit")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  fields: {
    gap: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
