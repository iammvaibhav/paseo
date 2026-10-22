import path from "node:path";
import type { Logger } from "pino";
import { DocThreadsService } from "./service.js";
import { DocThreadStore } from "./store.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { DocThreadsHost } from "./session.js";

export async function openDocThreads(options: {
  paseoHome: string;
  logger: Logger;
  agentStorage: AgentStorage;
  agentManager: AgentManager;
}): Promise<{ host: DocThreadsHost; store: DocThreadStore } | null> {
  const store = await DocThreadStore.open({
    directory: path.join(options.paseoHome, "doc-threads"),
    logger: options.logger,
  });
  if (!store) return null;
  const service = new DocThreadsService({
    store,
    logger: options.logger,
    agents: {
      async getAgentWorkspace(agentId) {
        const live = options.agentManager.getAgent(agentId);
        if (live) {
          return {
            workspaceId: live.workspaceId ?? "",
            cwd: live.cwd,
          };
        }
        const stored = await options.agentStorage.get(agentId);
        if (!stored) return null;
        return { workspaceId: stored.workspaceId ?? "", cwd: stored.cwd };
      },
    },
  });
  return {
    store,
    host: {
      service,
      delivery: {
        agentManager: options.agentManager,
        agentStorage: options.agentStorage,
        logger: options.logger,
      },
    },
  };
}

export { DocThreadsService, DocThreadsError } from "./service.js";
export { DocThreadStore, newDocThreadId } from "./store.js";
export { DocThreadsSession, isServingDocThreads, formatDocThreadPrompt } from "./session.js";
export type { DocThreadsHost } from "./session.js";
