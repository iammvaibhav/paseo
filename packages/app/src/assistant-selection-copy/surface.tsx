import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { SelectionAskConfig } from "@/selection-ask/use-selection-ask";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Selection Ask is web-only; native surfaces stay copy-only.
   */
  selectionAsk?: SelectionAskConfig | null;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
