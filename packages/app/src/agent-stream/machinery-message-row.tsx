import React, { type ReactElement } from "react";
import { MutedSystemRow } from "@/screens/mission-control/muted-system-row";

/**
 * The agent-chat placeholder for a machinery-originated prompt row (stall
 * status-ask nudges). Rendered ONLY in Mission Control verbose mode; the row
 * exists so the machinery send is auditable in the timeline, but the raw
 * prompt text is never shown — the component receives no text at all, only
 * the placeholder copy.
 */
export function MachineryMessageRow({ timestamp }: { timestamp: number }): ReactElement {
  return <MutedSystemRow message="Mission Control asked for a status" timestamp={timestamp} />;
}
