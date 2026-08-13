/**
 * Shared definition of what "system-owned" means in Mission Control: one
 * predicate decides which artifacts the verbose debug gate hides, and no
 * surface (server filters or app surfaces) rolls its own variant.
 *
 * System-owned agents are the Commander and every machinery artifact — any
 * agent carrying a `paseo.mission-control*` label (commander, verifier,
 * monitors, build-hash stamps). The Commander's home workspace is system
 * infrastructure too; it lives under a reserved path inside the daemon
 * user's home so no user project can claim its cwd (live incident: a user
 * project rooted at `~` surfaced the Commander workspace/agent).
 */

/** The label-key prefix marking system-owned agents (commander, verifier, machinery). */
export const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";

/** The label value marking the Commander itself (direct `paseo.mission-control`). */
export const MISSION_CONTROL_COMMANDER_LABEL_VALUE = "commander";

/**
 * True when the labels mark the Commander itself (direct `paseo.mission-control`
 * = "commander"). Narrower than `isCommanderOrMachineryLabels`: verifiers and
 * other machinery (monitors, build-hash stamps) are not the Commander. Used to
 * recognize Commander-dispatched workers, whose parent record is the Commander.
 */
export function isCommanderLabels(labels: Record<string, string> | undefined): boolean {
  return labels?.[MISSION_CONTROL_LABEL_PREFIX] === MISSION_CONTROL_COMMANDER_LABEL_VALUE;
}

/**
 * True when the labels carry ANY `paseo.mission-control` key — the
 * commander, verifiers, and machinery artifacts. A bare `undefined` (an
 * unlabeled record) is never system-owned. Key comparison is exact
 * prefix-aware: `paseo.mission-control` itself and any
 * `paseo.mission-control.*` sub-key (build-hash, …) both count; a merely
 * similar prefix (e.g. `paseo.mission-controlly`) does not.
 */
export function isSystemOwnedAgentLabels(labels: Record<string, string> | undefined): boolean {
  if (!labels) {
    return false;
  }
  return Object.keys(labels).some(
    (key) =>
      key === MISSION_CONTROL_LABEL_PREFIX || key.startsWith(`${MISSION_CONTROL_LABEL_PREFIX}.`),
  );
}

/**
 * The board-visibility predicate: which system-owned agents are hidden from
 * Mission Control surfaces. Only the Commander itself and non-verifier
 * machinery (monitors, build-hash stamps) are hidden. Verifiers are tracked
 * like any worker — their spin-up and completion show as lifecycle events —
 * so the verifier label is explicitly NOT hidden.
 */
export function isCommanderOrMachineryLabels(labels: Record<string, string> | undefined): boolean {
  if (!labels) {
    return false;
  }
  const direct = labels[MISSION_CONTROL_LABEL_PREFIX];
  if (direct === MISSION_CONTROL_COMMANDER_LABEL_VALUE) {
    return true;
  }
  if (direct === "verifier") {
    return false;
  }
  return Object.keys(labels).some((key) => key.startsWith(`${MISSION_CONTROL_LABEL_PREFIX}.`));
}

/**
 * The Commander's home directory, as a path segment under the daemon's paseo
 * home: `<paseoHome>/commander` (`~/.paseo/commander` in the standard layout
 * where paseoHome = `~/.paseo`). Reserved — boot creates it if missing and
 * provisions the Commander's home workspace there, so no user project can
 * claim the Commander's cwd.
 */
export const COMMANDER_HOME_DIR_SEGMENT = "commander";
