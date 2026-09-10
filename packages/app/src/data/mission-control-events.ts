import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

export const missionControlEventsQueryBaseKey = ["missionControlEvents"] as const;

/** Per-host events query key, so the push router can invalidate exactly the
 * host that delivered a `mission_control_event` push. */
export function missionControlEventsQueryKey(serverId: string) {
  return [...missionControlEventsQueryBaseKey, serverId] as const;
}

export type MissionControlEventsClient = Pick<DaemonClient, "missionControlEventsFetch">;

export async function fetchMissionControlEvents(input: {
  client: MissionControlEventsClient;
  sinceTs?: string;
  beforeSeq?: number;
  limit?: number;
}): Promise<MissionControlEvent[]> {
  const payload = await input.client.missionControlEventsFetch({
    ...(input.sinceTs ? { sinceTs: input.sinceTs } : {}),
    ...(typeof input.beforeSeq === "number" ? { beforeSeq: input.beforeSeq } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
  });
  return payload.events ?? [];
}
