export const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
export const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * The Commander's labels. The label key is the invisibility contract: any agent
 * carrying a `paseo.mission-control*` label (the Commander today, other
 * mission-control-scoped agents in the future) is hidden outside Mission Control
 * unless verbose mode is on.
 */
export function commanderLabels(): Record<string, string> {
  return {
    [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
  };
}
