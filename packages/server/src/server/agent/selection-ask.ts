import {
  PARENT_AGENT_ID_LABEL,
  SELECTION_ASK_LABEL,
  SELECTION_ASK_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";

export interface BuildSelectionAskPromptInput {
  selection: string;
  question: string;
}

export interface BuildSelectionAskLabelsInput {
  sourceAgentId: string;
}

export function buildSelectionAskPrompt(input: BuildSelectionAskPromptInput): string {
  const quotedSelection = input.selection
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const parts = [
    `You are answering a side ask about a selection from the parent chat.
Only answer the question. Do not make any changes unless the user explicitly asks you to.`,
  ];
  if (quotedSelection) {
    parts.push(`Selected text from the parent chat:\n${quotedSelection}`);
  }
  parts.push(`Question about that selection:\n${input.question}`);
  return parts.join("\n\n");
}

export function buildSelectionAskLabels(
  input: BuildSelectionAskLabelsInput,
): Record<string, string> {
  return {
    [PARENT_AGENT_ID_LABEL]: input.sourceAgentId,
    [SELECTION_ASK_LABEL]: "1",
    [SELECTION_ASK_SOURCE_LABEL]: input.sourceAgentId,
  };
}
