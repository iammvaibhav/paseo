import {
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import {
  createAssistantSelectionClipboardContent,
  createAssistantSelectionPlainText,
} from "./content.web";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { type MarkdownClipboardContent, writeRichClipboardContent } from "@/utils/rich-clipboard";
import {
  SelectionAskPopoverHost,
  type SelectionAskPopoverHostProps,
} from "@/selection-ask/selection-popover";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * When set (web only), the surface also hosts the selection Ask popover:
   * selecting text in the stream offers Add to composer / Ask. Native builds
   * keep the surface copy-only.
   */
  selectionAsk?: SelectionAskPopoverHostProps["config"];
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

export function AssistantSelectionCopySurface({
  children,
  style,
  selectionAsk = null,
}: AssistantSelectionCopySurfaceProps) {
  // Chromium never delivers a copy event for Cmd/Ctrl+Shift+C — the accelerator
  // is consumed before the page — so the Markdown copy runs on keydown itself,
  // writing through the async clipboard API. `markdownCopyJustHandledRef` stops
  // the plain-text copy handler from overwriting it in engines that do fire a
  // copy event for the shifted combo.
  const markdownCopyJustHandledRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) {
        return;
      }
      const armGuard = () => {
        markdownCopyJustHandledRef.current = true;
        // A copy event from the same key press (engines that fire one for the
        // shifted combo) runs before timers, so this clears the guard afterwards.
        window.setTimeout(() => {
          markdownCopyJustHandledRef.current = false;
        }, 0);
      };

      const selection = window.getSelection();
      let content: MarkdownClipboardContent | null = null;
      try {
        content = createAssistantSelectionClipboardContent(selection);
      } catch (error) {
        console.warn("[assistant-selection-copy] Markdown copy failed", error);
      }
      if (content) {
        event.preventDefault();
        armGuard();
        void writeRichClipboardContent(content, getDefaultMarkdownClipboardEnvironment());
        return;
      }

      // Fall back so the shortcut never silently copies nothing: rendered
      // message text when the selection is in a message, otherwise the raw
      // selection.
      const plainText = createAssistantSelectionPlainText(selection) ?? selection?.toString() ?? "";
      if (!plainText) {
        return;
      }
      event.preventDefault();
      armGuard();
      void getDefaultMarkdownClipboardEnvironment().writePlainText(plainText);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (markdownCopyJustHandledRef.current) {
      markdownCopyJustHandledRef.current = false;
      event.preventDefault();
      return;
    }

    // Cmd/Ctrl+C: the rendered text only, with no Markdown syntax and no rich half.
    const plainText = createAssistantSelectionPlainText(window.getSelection());
    if (plainText === null) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", plainText);
  }, []);

  return (
    <SelectionAskPopoverHost config={selectionAsk}>
      <div onCopy={handleCopy} style={DISPLAY_CONTENTS}>
        <View style={style}>{children}</View>
      </div>
    </SelectionAskPopoverHost>
  );
}
