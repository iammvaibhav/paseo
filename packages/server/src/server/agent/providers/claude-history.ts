/**
 * Offline Claude timeline from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * Claude's agent constructor already loads this file into streamHistory without
 * spawning a process. We reuse that path so disk and agent history stay one implementation.
 */
import type { Logger } from "pino";
import pino from "pino";

import type { AgentPersistenceHandle, AgentTimelineItem } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude/agent.js";

const silentLogger = pino({ level: "silent" });

/**
 * Read Claude session history from disk without spawning Claude Code.
 * Returns null when the session file is missing or unreadable.
 */
export async function readClaudeTimelineFromDisk(input: {
  cwd: string;
  sessionId: string;
  logger?: Logger;
}): Promise<AgentTimelineItem[] | null> {
  const logger = input.logger ?? silentLogger;
  const client = new ClaudeAgentClient({ logger });
  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: input.sessionId,
    nativeHandle: input.sessionId,
    metadata: { provider: "claude", cwd: input.cwd },
  };

  try {
    // resumeSession only constructs the session + loadPersistedHistory; it does not spawn.
    const session = await client.resumeSession(handle, { cwd: input.cwd, provider: "claude" });
    const items: AgentTimelineItem[] = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "timeline") {
        items.push(event.item);
      }
    }
    try {
      await session.close();
    } catch {
      // no live process in the common case
    }
    return items;
  } catch (error) {
    logger.debug({ err: error, sessionId: input.sessionId }, "Claude disk history unavailable");
    return null;
  }
}
