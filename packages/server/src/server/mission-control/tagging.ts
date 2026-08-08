import { randomUUID } from "node:crypto";

import { isSystemInjectedEnvelope } from "../agent/agent-prompt.js";
import type { AgentManager } from "../agent/agent-manager.js";

export interface CommanderUserMessage {
  messageId: string;
  text: string;
}

/**
 * The user message the Commander is currently handling: the newest real user
 * turn on its timeline. System-injected envelopes (digests, notifications, the
 * launch-time context pack) are never user messages, so they are skipped.
 * `messageId` prefers the provider message id, falls back to the client
 * message id, then a generated id — the Verifier reads tag records by this id.
 */
export function resolveCommanderUserMessage(
  agentManager: Pick<AgentManager, "getTimeline">,
  commanderId: string,
): CommanderUserMessage | null {
  const timeline = agentManager.getTimeline(commanderId);
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type !== "user_message") {
      continue;
    }
    if (isSystemInjectedEnvelope(item.text)) {
      continue;
    }
    return {
      messageId: item.messageId ?? item.clientMessageId ?? randomUUID(),
      text: item.text,
    };
  }
  return null;
}
