import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StoredAutomation } from "@getpaseo/protocol/automation/types";
import { toErrorMessage } from "@/utils/error-messages";

export const automationsQueryBaseKey = ["automations"] as const;
export const ALL_AUTOMATION_HOSTS_FAILED_MESSAGE = "No connected hosts could load automations";

export interface AutomationHostInput {
  serverId: string;
  serverName: string;
}

export interface AutomationRuntimeSnapshot {
  connectionStatus: string;
}

export interface AutomationRuntime {
  getSnapshot: (serverId: string) => AutomationRuntimeSnapshot | null | undefined;
  getClient: (serverId: string) => DaemonClient | null | undefined;
}

export interface AggregatedAutomation extends StoredAutomation {
  serverId: string;
  serverName: string;
}

export interface AutomationHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export type FetchAggregatedAutomationsState =
  | { status: "connecting" }
  | { status: "loaded"; data: AggregatedAutomation[]; hostErrors: AutomationHostError[] };

export interface FetchAggregatedAutomationsInput {
  hosts: readonly AutomationHostInput[];
  runtime: AutomationRuntime;
  supportedHosts?: ReadonlyMap<string, boolean>;
}

export async function fetchAggregatedAutomations(
  input: FetchAggregatedAutomationsInput,
): Promise<FetchAggregatedAutomationsState> {
  const supportedHosts = input.supportedHosts;
  const eligibleHosts = input.hosts.filter((host) => supportedHosts?.get(host.serverId) !== false);
  const hasSettlingHost = eligibleHosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return (
      !snapshot ||
      snapshot.connectionStatus === "connecting" ||
      snapshot.connectionStatus === "idle"
    );
  });
  const onlineHosts = eligibleHosts.filter((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
  });
  if (onlineHosts.length === 0 && hasSettlingHost) return { status: "connecting" };

  const automations: AggregatedAutomation[] = [];
  const hostErrors: AutomationHostError[] = [];
  await Promise.all(
    onlineHosts.map(async (host) => {
      const client = input.runtime.getClient(host.serverId);
      if (!client) return;
      try {
        const payload = await (
          client as DaemonClient & {
            automationList: () => Promise<{
              automations: StoredAutomation[];
              error: string | null;
            }>;
          }
        ).automationList();
        if (payload.error) throw new Error(payload.error);
        for (const automation of payload.automations) {
          automations.push({ ...automation, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );
  if (
    onlineHosts.length > 0 &&
    automations.length === 0 &&
    hostErrors.length === onlineHosts.length
  ) {
    throw new Error(ALL_AUTOMATION_HOSTS_FAILED_MESSAGE);
  }
  if (automations.length === 0 && hasSettlingHost) return { status: "connecting" };
  automations.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return { status: "loaded", data: automations, hostErrors };
}
