import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { Search, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";

const ThemedSearch = withUnistyles(Search);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  // Placeholders sit at foregroundMuted and no dimmer — see docs/design.md §14.
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SearchFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  /** Falls back to `placeholder`, which already names the field. */
  accessibilityLabel?: string;
  clearAccessibilityLabel: string;
  /** Fill the container, for a search that heads one list. Defaults to the filter rail's width. */
  fullWidth?: boolean;
  testID?: string;
  clearTestID?: string;
  autoFocus?: boolean;
  /** Escape on web; native keyboards have no Escape key. */
  onEscape?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * The standalone search box that leads a screen's filter rail. Its chrome is
 * the host filter pill's, so the two sit on the same rail and read as one row
 * of controls; only the border colour moves on focus, which keeps the leading
 * icon from shifting. It owns its own clear affordance — a caller rendering its
 * own X has been handed the wrong component.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  clearAccessibilityLabel,
  fullWidth = false,
  testID,
  clearTestID,
  autoFocus,
  onEscape,
  onFocus,
  onBlur,
}: SearchFieldProps): ReactElement {
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  // The input is uncontrolled; this is the text it holds, so a `value` the
  // caller changes on its own (cleared from elsewhere) can be written into it.
  const inputTextRef = useRef(value);
  useEffect(() => {
    if (value === inputTextRef.current) return;
    inputTextRef.current = value;
    inputRef.current?.replaceText(value);
  }, [value]);
  const handleChangeText = useCallback(
    (text: string) => {
      inputTextRef.current = text;
      onChangeText(text);
    },
    [onChangeText],
  );
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onFocus?.();
  }, [onFocus]);
  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onBlur?.();
  }, [onBlur]);
  const handleClear = useCallback(() => {
    inputRef.current?.replaceText("");
    handleChangeText("");
  }, [handleChangeText]);
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") onEscape?.();
    },
    [onEscape],
  );

  return (
    <View
      style={[styles.field, fullWidth && styles.fieldFullWidth, isFocused && styles.fieldFocused]}
    >
      <ThemedSearch size={14} uniProps={mutedColorMapping} />
      <ThemedTextInput
        testID={testID}
        ref={inputRef}
        initialValue={value}
        onChangeText={handleChangeText}
        onFocus={handleFocus}
        onBlur={handleBlur}
        autoFocus={autoFocus}
        onKeyPress={onEscape ? handleKeyPress : undefined}
        placeholder={placeholder}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.input}
      />
      {value.length > 0 ? (
        <Pressable
          testID={clearTestID}
          onPress={handleClear}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          hitSlop={8}
        >
          <ThemedX size={14} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

const SEARCH_FIELD_MAX_WIDTH = 420;

const styles = StyleSheet.create((theme) => ({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
    maxWidth: SEARCH_FIELD_MAX_WIDTH,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fieldFullWidth: {
    maxWidth: "100%",
  },
  fieldFocused: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 20,
    // The browser's focus ring would sit inside the field's own focus border.
    // `outlineWidth` is typed on ViewStyle since RN 0.81 and is a no-op on
    // native, so this needs neither a cast nor a platform branch.
    outlineWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
