import type { Logger } from "pino";
import { buildAgentDeepLink, buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { seedStoredTimeline } from "../agent/tools/fleet-transcript.js";
import type { ReminderAgentInfo } from "./agent-reminder-service.js";

/** The last assistant message rides the event trimmed; the transcript has the rest. */
export const REMINDER_LAST_MESSAGE_LIMIT = 2000;

export interface ReminderAgentDescriberDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  serverId: string;
  hostLabel: () => string;
  appBaseUrl: () => string | null;
  readBucket: (agentId: string) => Promise<string | null>;
}

async function readLastAssistantMessage(
  deps: ReminderAgentDescriberDeps,
  agentId: string,
): Promise<string | null> {
  try {
    // A closed agent's timeline is read from the provider's history on disk.
    await seedStoredTimeline({ ...deps, agentId });
    const rows = deps.agentManager.fetchTimeline(agentId, { direction: "tail", limit: 200 }).rows;
    const last = rows.findLast((row) => row.item.type === "assistant_message");
    const text = last?.item.type === "assistant_message" ? last.item.text.trim() : "";
    if (!text) return null;
    return text.length > REMINDER_LAST_MESSAGE_LIMIT
      ? `${text.slice(0, REMINDER_LAST_MESSAGE_LIMIT)}\n[truncated ${text.length - REMINDER_LAST_MESSAGE_LIMIT} chars; use fleet_get_transcript for the full response]`
      : text;
  } catch (error) {
    deps.logger.warn({ err: error, agentId }, "reminder last message unavailable");
    return null;
  }
}

export function createReminderAgentDescriber(
  deps: ReminderAgentDescriberDeps,
): (agentId: string) => Promise<ReminderAgentInfo> {
  return async (agentId) => {
    const [record, bucket, lastMessage] = await Promise.all([
      deps.agentStorage.get(agentId).catch(() => null),
      deps.readBucket(agentId).catch(() => null),
      readLastAssistantMessage(deps, agentId),
    ]);
    const live = deps.agentManager.getAgent(agentId);
    const target = { serverId: deps.serverId, agentId };
    const appBaseUrl = deps.appBaseUrl()?.replace(/\/$/, "");
    return {
      title: record?.title ?? null,
      host: deps.hostLabel(),
      workspaceId: live?.workspaceId ?? record?.workspaceId ?? null,
      cwd: live?.cwd ?? record?.cwd ?? null,
      status: live?.lifecycle ?? record?.lastStatus ?? null,
      bucket,
      lastMessage,
      deepLink: buildAgentDeepLink(target),
      webUrl: appBaseUrl ? `${appBaseUrl}${buildAgentDeepLinkRoute(target)}` : null,
    };
  };
}
