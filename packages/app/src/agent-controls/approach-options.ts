import { AGENT_MODES, type AgentModeId } from "@getpaseo/protocol/agent-modes";
import type { ComboboxOption } from "@/components/ui/combobox";

/**
 * Approaches the pickers offer. The protocol still defines plan, review, and
 * debug; the app only lets users pick these three.
 */
const PICKER_APPROACH_IDS: readonly AgentModeId[] = ["solo", "orchestrator", "research"];

export const APPROACH_OPTIONS: ComboboxOption[] = PICKER_APPROACH_IDS.flatMap((id) => {
  const mode = AGENT_MODES.find((candidate) => candidate.id === id);
  return mode ? [{ id: mode.id, label: mode.label, description: mode.description }] : [];
});
