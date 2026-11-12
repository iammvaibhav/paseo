import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_AGENT_MODE_ID,
  isAgentModeId,
  type AgentModeId,
} from "@getpaseo/protocol/agent-modes";
import { APPROACH_OPTIONS } from "@/agent-controls/approach-options";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { HostProjectListItem } from "@/projects/host-projects";

export const NEW_PROJECT_OPTION_ID = "routing:new_project";
export const SCRATCH_OPTION_ID = "routing:scratch";

/** Where the workspace goes when it is not an existing project the picker lists. */
export type RoutingTarget =
  | { kind: "project" }
  | { kind: "new_project"; serverId: string }
  | { kind: "scratch"; serverId: string };

const TARGET_PRESENTATION: Record<
  RoutingTarget["kind"],
  { label: string | null; optionId: string | null }
> = {
  project: { label: null, optionId: null },
  new_project: { label: "New project", optionId: NEW_PROJECT_OPTION_ID },
  scratch: { label: "Scratch", optionId: SCRATCH_OPTION_ID },
};

const SPECIAL_PROJECT_OPTIONS: ComboboxOption[] = [
  {
    id: NEW_PROJECT_OPTION_ID,
    label: "New project",
    description: "Named from the prompt, created with git on this host",
  },
  {
    id: SCRATCH_OPTION_ID,
    label: "Scratch",
    description: "This host's scratch area for one-off work",
  },
];

/** The listed-project picker as the screen computes it without routing. */
export interface RoutingProjectPickerInput {
  options: ComboboxOption[];
  selectedOptionId: string;
  triggerLabel: string;
  selectedProject: HostProjectListItem | null;
}

export interface NewWorkspaceRoutingInput {
  /** The host serves routing.project.create (features.routingSuggest). */
  supported: boolean;
  /** A fork carries its own setup; New project / Scratch stay off. */
  forked: boolean;
  selectedServerId: string;
  projectPicker: RoutingProjectPickerInput;
}

export interface NewWorkspaceRouting {
  target: RoutingTarget;
  agentMode: AgentModeId;
  agentModeOptions: ComboboxOption[];
  /** Project picker selection of New project / Scratch; false for a normal project id. */
  selectSpecialProjectOption: (optionId: string) => boolean;
  selectAgentMode: (id: string) => void;
  /** The project picker with New project / Scratch folded in. */
  picker: RoutingProjectPickerInput;
}

/**
 * Manual placement controls for the New workspace screen: New project and
 * Scratch as project picker targets, and the agent mode. Every value comes
 * from the user's picks; the prompt is never sent anywhere to infer them.
 */
export function useNewWorkspaceRouting(input: NewWorkspaceRoutingInput): NewWorkspaceRouting {
  const { supported, forked, selectedServerId, projectPicker } = input;
  const enabled = supported && !forked;
  const [target, setTarget] = useState<RoutingTarget>({ kind: "project" });
  const [agentMode, setAgentMode] = useState<AgentModeId>(DEFAULT_AGENT_MODE_ID);

  const selectSpecialProjectOption = useCallback(
    (optionId: string): boolean => {
      if (optionId !== NEW_PROJECT_OPTION_ID && optionId !== SCRATCH_OPTION_ID) {
        setTarget({ kind: "project" });
        return false;
      }
      setTarget({
        kind: optionId === NEW_PROJECT_OPTION_ID ? "new_project" : "scratch",
        serverId: selectedServerId,
      });
      return true;
    },
    [selectedServerId],
  );

  const selectAgentMode = useCallback((id: string) => {
    if (!isAgentModeId(id)) return;
    setAgentMode(id);
  }, []);

  // The target follows the host: New project / Scratch on another host than
  // the selected one means the user moved the host after picking it.
  const effectiveTarget: RoutingTarget =
    target.kind !== "project" && target.serverId !== selectedServerId
      ? { kind: target.kind, serverId: selectedServerId }
      : target;

  const presentation = TARGET_PRESENTATION[effectiveTarget.kind];
  const picker = useMemo<RoutingProjectPickerInput>(() => {
    if (!enabled) return projectPicker;
    return {
      options: [...SPECIAL_PROJECT_OPTIONS, ...projectPicker.options],
      selectedOptionId: presentation.optionId ?? projectPicker.selectedOptionId,
      triggerLabel: presentation.label ?? projectPicker.triggerLabel,
      selectedProject: presentation.optionId ? null : projectPicker.selectedProject,
    };
  }, [enabled, presentation, projectPicker]);

  return {
    target: effectiveTarget,
    agentMode,
    agentModeOptions: APPROACH_OPTIONS,
    selectSpecialProjectOption,
    selectAgentMode,
    picker,
  };
}
