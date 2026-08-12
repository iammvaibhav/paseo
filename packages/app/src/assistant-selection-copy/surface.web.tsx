import { useCallback, type ClipboardEvent, type CSSProperties, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { createAssistantSelectionClipboardContent } from "./content.web";
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
  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);

  return (
    <SelectionAskPopoverHost config={selectionAsk}>
      <div onCopy={handleCopy} style={DISPLAY_CONTENTS}>
        <View style={style}>{children}</View>
      </div>
    </SelectionAskPopoverHost>
  );
}
