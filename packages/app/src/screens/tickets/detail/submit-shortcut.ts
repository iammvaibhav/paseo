import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { ShortcutKey } from "@/utils/format-shortcut";

// Web key events carry the modifier state. Native soft keyboards never send it.
interface KeyPressWithModifiers extends TextInputKeyPressEventData {
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export const SUBMIT_SHORTCUT_KEYS: ShortcutKey[] = ["mod", "Enter"];

/** ⌘+Enter on macOS, Ctrl+Enter elsewhere. */
export function isSubmitShortcut(event: NativeSyntheticEvent<TextInputKeyPressEventData>): boolean {
  const nativeEvent: KeyPressWithModifiers = event.nativeEvent;
  const hasModifier = Boolean(nativeEvent.metaKey || nativeEvent.ctrlKey);
  return nativeEvent.key === "Enter" && hasModifier;
}
