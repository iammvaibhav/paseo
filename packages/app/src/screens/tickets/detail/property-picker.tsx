import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { SelectFieldOption } from "@/components/ui/select-field";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

interface PropertyPickerProps<TValue extends string> {
  /** Names the property for screen readers and titles the picker sheet. */
  label: string;
  valueLabel: string;
  isPlaceholder?: boolean;
  /** An icon before the value. Pass a stable element. */
  leading?: ReactNode;
  options: SelectFieldOption<TValue>[];
  value: TValue | null;
  onChange: (value: TValue) => void;
  searchable?: boolean;
  /** Accept typed text that matches no option, e.g. a custom date. */
  onCustomValue?: (text: string) => void;
  customValuePrefix?: string;
  /** "row" is the quiet properties-rail trigger; "pill" adds a border for a toolbar. */
  appearance?: "row" | "pill";
  pending?: boolean;
  disabled?: boolean;
  testID?: string;
}

/**
 * A property value that opens a picker when pressed. It reads as the value
 * itself, not as a form field, so a column of them stays quiet.
 */
export function PropertyPicker<TValue extends string>({
  label,
  valueLabel,
  isPlaceholder = false,
  leading,
  options,
  value,
  onChange,
  searchable = false,
  onCustomValue,
  customValuePrefix,
  appearance = "row",
  pending = false,
  disabled = false,
  testID,
}: PropertyPickerProps<TValue>): ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const optionById = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
    [options],
  );
  const selectedId = useMemo(
    () => options.find((option) => option.value === value)?.id ?? "",
    [options, value],
  );

  const handlePress = useCallback(() => setOpen((current) => !current), []);
  const handleSelect = useCallback(
    (id: string) => {
      setOpen(false);
      const option = optionById.get(id);
      if (option) {
        onChange(option.value);
        return;
      }
      onCustomValue?.(id);
    },
    [onChange, onCustomValue, optionById],
  );

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      appearance === "pill" && styles.triggerPill,
      (hovered || pressed || open) && styles.triggerActive,
      disabled && styles.triggerDisabled,
    ],
    [appearance, disabled, open],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={styles.anchor}>
        <Pressable
          onPress={handlePress}
          disabled={disabled}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${valueLabel}`}
          testID={testID}
        >
          {leading}
          <Text style={isPlaceholder ? styles.placeholder : styles.value} numberOfLines={1}>
            {valueLabel}
          </Text>
          {pending ? <ThemedLoadingSpinner size="small" uniProps={mutedIconColorMapping} /> : null}
        </Pressable>
      </View>
      <Combobox
        options={comboboxOptions}
        value={selectedId}
        onSelect={handleSelect}
        searchable={searchable || onCustomValue !== undefined}
        allowCustomValue={onCustomValue !== undefined}
        customValuePrefix={customValuePrefix}
        searchPlaceholder={t("tickets.detail.picker.searchPlaceholder")}
        emptyText={t("tickets.detail.picker.empty")}
        title={label}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 1,
    minWidth: 0,
    alignSelf: "flex-start",
  },
  trigger: {
    minHeight: CONTROL_HEIGHTS.tight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  triggerPill: {
    borderColor: theme.colors.border,
  },
  triggerActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  value: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  placeholder: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
}));
