import type { ReactNode } from "react";
import type { SelectionAskConfig } from "./use-selection-ask";

export interface SelectionAskPopoverHostProps {
  config: SelectionAskConfig | null;
  children: ReactNode;
}

/**
 * Native no-op host for the selection Ask popover. The feature is web-only:
 * native builds keep the stream surface as-is (selection copy still works).
 */
export function SelectionAskPopoverHost({ children }: SelectionAskPopoverHostProps) {
  return children;
}
