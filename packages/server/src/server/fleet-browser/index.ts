import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import { sendPreparedPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { FleetBrowserConfig } from "./config.js";
import { FleetBrowserService } from "./service.js";
import { FleetBrowserStore } from "./store.js";

export async function openFleetBrowser(options: {
  paseoHome: string;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
}): Promise<FleetBrowserService> {
  const logger = options.logger.child({ module: "fleet-browser" });
  const { agentManager, agentStorage } = options;
  const config = new FleetBrowserConfig(options.paseoHome, logger);
  await config.load();
  config.start();
  const service = new FleetBrowserService({
    config,
    store: await FleetBrowserStore.open(options.paseoHome, logger),
    logger,
    agents: {
      async workspaceIdOf(agentId) {
        const live = agentManager.getAgent(agentId);
        if (live) return live.workspaceId ?? null;
        return (await agentStorage.get(agentId))?.workspaceId ?? null;
      },
      isRunning: (agentId) => agentManager.hasInFlightRun(agentId),
      async deliver(agentId, text) {
        try {
          const { disposition } = await sendPreparedPromptToAgent({
            agentManager,
            agentStorage,
            agentId,
            prompt: text,
            activeTurnBehavior: "steer",
            replaceOrigin: "machinery",
            unarchive: false,
            logger,
          });
          return disposition === "steered" ? "steered" : "turn_started";
        } catch (error) {
          logger.warn({ err: error, agentId }, "fleet_browser.deliver_failed");
          return "none";
        }
      },
    },
  });
  service.start();
  return service;
}

export { FleetBrowserService, FleetBrowserError } from "./service.js";
export { FleetBrowserSession } from "./session.js";
export { registerFleetBrowserTools } from "./tools.js";
