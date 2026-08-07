export const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
export const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * The Commander's labels. The label key is the invisibility contract: any agent
 * carrying a `paseo.mission-control*` label (the Commander today, other
 * mission-control-scoped agents in the future) is hidden outside Mission Control.
 */
export function commanderLabels(): Record<string, string> {
  return {
    [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
  };
}

/**
 * True for any agent carrying a `paseo.mission-control*` label, regardless of
 * value. Key-prefix match mirrors the daemon's MissionControlService exclusion
 * (`service.ts` `MISSION_CONTROL_LABEL_PREFIX`) so board, badge, sidebar, and
 * archive guards agree with the feed filter on exactly the same agents.
 */
export function isCommanderAgent(labels: Record<string, string> | null | undefined): boolean {
  return Object.keys(labels ?? {}).some((key) => key.startsWith(MISSION_CONTROL_LABEL_KEY));
}
