import type { ToolCallDetail, ToolCallIconName } from "@getpaseo/protocol/agent-types";
import { isPaseoToolName } from "@getpaseo/protocol/tool-name-normalization";

export type ToolCallIcon = ToolCallIconName | "paseo";

const TOOL_DETAIL_ICON_NAMES: Record<ToolCallDetail["type"], ToolCallIcon> = {
  shell: "square_terminal",
  read: "eye",
  edit: "pencil",
  write: "pencil",
  search: "search",
  fetch: "search",
  worktree_setup: "square_terminal",
  sub_agent: "bot",
  plain_text: "wrench",
  plan: "brain",
  unknown: "wrench",
};

export function resolveToolCallIconName(toolName: string, detail?: ToolCallDetail): ToolCallIcon {
  const lowerName = toolName.trim().toLowerCase();

  if (detail?.type === "plain_text" && detail.icon) {
    return detail.icon;
  }

  // Thoughts are rendered through ToolCall with unknown detail payloads.
  if (lowerName === "thinking" && (!detail || detail.type === "unknown")) {
    return "brain";
  }
  if (lowerName === "speak") {
    return "mic_vocal";
  }
  // Oh My Pi's code-cell kernel; the detail payload is `unknown`, which would
  // otherwise resolve to the generic wrench.
  if (lowerName === "eval") {
    return "square_terminal";
  }
  if (lowerName === "web_search" || lowerName === "websearch" || lowerName === "web-search") {
    return "search";
  }
  if (isPaseoToolName(lowerName)) {
    return "paseo";
  }
  if (lowerName === "task") {
    return "bot";
  }

  if (detail) {
    return TOOL_DETAIL_ICON_NAMES[detail.type];
  }
  return "wrench";
}
