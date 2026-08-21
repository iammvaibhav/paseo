import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WebhookSummary } from "@getpaseo/protocol/webhook/types";
import { toErrorMessage } from "@/utils/error-messages";

export const webhooksQueryBaseKey = ["webhooks"] as const;

export const ALL_WEBHOOK_HOSTS_FAILED_MESSAGE = "No connected hosts could load webhooks";

export interface WebhookHostInput {
  serverId: string;
  serverName: string;
}

export interface WebhookRuntimeSnapshot {
  connectionStatus: string;
}

export interface WebhookRuntime {
  getClient(serverId: string): Pick<DaemonClient, "webhookList"> | null;
  getSnapshot(serverId: string): WebhookRuntimeSnapshot | null | undefined;
}

/** A webhook tagged with the host it came from, so the flat list can render a
 * per-row host label and scope mutations without host sections. The host's
 * public base URL rides along so a row can build its full hook URL. */
export interface AggregatedWebhook extends WebhookSummary {
  serverId: string;
  serverName: string;
  publicBaseUrl: string | null;
}

export interface WebhookHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedWebhooksConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedWebhooksResult {
  status: "loaded";
  data: AggregatedWebhook[];
  hostErrors: WebhookHostError[];
}

export type FetchAggregatedWebhooksState =
  | FetchAggregatedWebhooksConnectingResult
  | FetchAggregatedWebhooksResult;

export type AggregateLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T[] };

export interface FetchAggregatedWebhooksInput {
  hosts: readonly WebhookHostInput[];
  runtime: WebhookRuntime;
}

/**
 * Fetch webhooks across connected hosts and merge them into one flat list.
 * Connectivity is checked here at execution time, so explicit query refreshes
 * pick up the currently connected host set.
 *
 * Offline hosts are skipped. A connected host that fails contributes to
 * `hostErrors` (surfaced as a banner) while the rest still render; only when
 * every connected host fails do we throw so the screen shows a full error.
 */
export async function fetchAggregatedWebhooks(
  input: FetchAggregatedWebhooksInput,
): Promise<FetchAggregatedWebhooksState> {
  const hasSettlingHost = input.hosts.some((host) =>
    isWebhookHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasAskableHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
  });

  if (!hasAskableHost && hasSettlingHost) {
    return { status: "connecting" };
  }

  const webhooks: AggregatedWebhook[] = [];
  const hostErrors: WebhookHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.webhookList();
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const webhook of payload.webhooks) {
          webhooks.push({
            ...webhook,
            serverId: host.serverId,
            serverName: host.serverName,
            publicBaseUrl: payload.publicBaseUrl,
          });
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

  if (connectedAttempts > 0 && webhooks.length === 0 && hostErrors.length === connectedAttempts) {
    throw new Error(ALL_WEBHOOK_HOSTS_FAILED_MESSAGE);
  }

  if (webhooks.length === 0 && hasSettlingHost) {
    return { status: "connecting" };
  }

  return { status: "loaded", data: webhooks, hostErrors };
}

function isWebhookHostConnectionSettling(
  snapshot: WebhookRuntimeSnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
