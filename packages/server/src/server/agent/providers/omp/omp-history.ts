/**
 * Offline OMP timeline from the native session JSONL file.
 *
 * OMP already maps disk history via {@link streamOmpHistory} (same path as
 * live streamHistory). This wrapper collects timeline items so agent open can
 * seed the daemon store without spawning the OMP process.
 */
import type { Logger } from "pino";
import pino from "pino";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { streamOmpHistory } from "./history.js";
import { resolveOmpSessionFile } from "./session-descriptor.js";

const silentLogger = pino({ level: "silent" });

/**
 * Read and project OMP offline history. Returns null when the session file is
 * missing, unreadable, or yields no timeline items.
 */
export async function readOmpTimelineFromDisk(input: {
  sessionFile: string;
  logger?: Logger;
}): Promise<AgentTimelineItem[] | null> {
  const logger = input.logger ?? silentLogger;
  const rawFile = input.sessionFile.trim();
  if (!rawFile) {
    return null;
  }
  const sessionFile = await resolveOmpSessionFile(rawFile);

  try {
    const items: AgentTimelineItem[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      provider: "omp",
    })) {
      if (event.type === "timeline") {
        items.push(event.item);
      }
    }
    return items.length > 0 ? items : null;
  } catch (error) {
    logger.debug({ err: error, sessionFile: input.sessionFile }, "OMP disk history unavailable");
    return null;
  }
}
