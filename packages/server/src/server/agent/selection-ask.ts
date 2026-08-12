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
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `This is a side ask from a selection in the parent chat. Only answer and make no changes unless the user asks to.

${quotedSelection}

....
${input.question}`;
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
