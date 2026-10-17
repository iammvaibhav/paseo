import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MissionControlInstruction } from "@getpaseo/protocol/mission-control/types";

export const missionControlInstructionsQueryBaseKey = ["missionControlInstructions"] as const;

/** Per-host instructions query key, invalidated with the same
 * `mission_control_event` push that refreshes the feed (a citing card closes
 * a row; the verbose thread's manual close refetches too). */
export function missionControlInstructionsQueryKey(serverId: string) {
  return [...missionControlInstructionsQueryBaseKey, serverId] as const;
}

export type MissionControlInstructionsClient = Pick<DaemonClient, "missionControlInstructionsList">;

export async function fetchMissionControlInstructions(input: {
  client: MissionControlInstructionsClient;
}): Promise<MissionControlInstruction[]> {
  const payload = await input.client.missionControlInstructionsList();
  return payload.instructions ?? [];
}
