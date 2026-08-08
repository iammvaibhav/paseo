import type { Logger } from "pino";

import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type {
  BoundCreateAgentCommand,
  CreateAgentFromMcpInput,
} from "../agent/create-agent/create.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import type { FleetContextDependencies } from "./context.js";
import { buildCommanderLaunchConfig } from "./context.js";

/**
 * The Commander is host-wide; `~` is the only cwd that always exists on every
 * host. The create paths expand `~` to the daemon's home (same contract as the
 * app's launch).
 */
export const COMMANDER_CWD = "~";
export const COMMANDER_TITLE = "Commander";

/**
 * The Commander's hard tool restriction (spec: Commander contract). Only Paseo
 * fleet/agent tools — no bash, no file editing, no task subagents. Mirrors the
 * app-side launch allowlist plus the v3 tagging and cross-host activity tools.
 */
export const COMMANDER_TOOL_ALLOWLIST: readonly string[] = [
  "fleet_list_agents",
  "fleet_create_agent",
  "fleet_send_prompt",
  "fleet_get_agent_activity",
  "fleet_search",
  "create_agent",
  "send_agent_prompt",
  "get_agent_status",
  "get_agent_activity",
  "list_agents",
  "create_workspace",
  "list_workspaces",
  "history_search",
  "tag_message",
];

export interface EnsureCommanderOnBootInput {
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listRegisteredProviderIds">;
  createAgent: BoundCreateAgentCommand;
  /** Central mission-control config (commander host), resolved at boot. */
  centralConfig: () => MissionControlCentralConfig;
  /** Everything buildCommanderLaunchConfig needs to snapshot the fleet. */
  launchContext: FleetContextDependencies;
  /** This host's own identity for the "designated host" check. */
  hostName: string;
  hostAlias: string | null;
}

export interface EnsureCommanderOnBootResult {
  created: boolean;
  agentId?: string;
}

function commanderLabels(): Record<string, string> {
  return {
    [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
  };
}

/**
 * Daemon-boot commander ensure (spec: "Nothing needed in deploy scripts"): when
 * this host is the designated commander host and no commander-labeled agent
 * exists (live or unarchived), create it with the static system prompt and the
 * context pack as its first message. Central commanderModel overrides the host
 * default model. Single fleet commander: never creates a second one.
 */
export async function ensureCommanderOnBoot(
  input: EnsureCommanderOnBootInput,
): Promise<EnsureCommanderOnBootResult> {
  // Per-host feature switch: a disabled Mission Control host never spawns the
  // fleet Commander.
  if (input.launchContext.daemonConfigStore.get().missionControl?.enabled === false) {
    return { created: false };
  }
  const central = input.centralConfig();
  const designated =
    central.commanderHost === null ||
    central.commanderHost === undefined ||
    central.commanderHost === "local" ||
    central.commanderHost === input.hostName ||
    (input.hostAlias !== null && central.commanderHost === input.hostAlias);
  if (!designated) {
    return { created: false };
  }

  const existing = await findExistingCommander(input.agentManager, input.agentStorage);
  if (existing) {
    return { created: false, agentId: existing };
  }

  const providerIds = input.providerSnapshotManager.listRegisteredProviderIds();
  if (providerIds.length === 0) {
    input.logger.warn(
      { component: "boot" },
      "mission_control.boot.no_provider — no provider registered; Commander creation deferred",
    );
    return { created: false };
  }

  const { systemPrompt, firstMessage } = await buildCommanderLaunchConfig(input.launchContext);
  // Central commanderModel is "provider/model" or a bare model on the host's
  // default provider; absent → the host's first registered provider + default.
  const commanderModel = central.commanderModel?.trim() ?? null;
  let provider = providerIds[0];
  let model: string | undefined;
  if (commanderModel !== null) {
    const slashIndex = commanderModel.indexOf("/");
    if (slashIndex > 0) {
      provider = commanderModel.slice(0, slashIndex).trim();
      model = commanderModel.slice(slashIndex + 1).trim();
    } else {
      model = commanderModel;
    }
  }

  const createInput: CreateAgentFromMcpInput = {
    kind: "mcp",
    provider,
    title: COMMANDER_TITLE,
    initialPrompt: firstMessage,
    cwd: COMMANDER_CWD,
    labels: commanderLabels(),
    config: {
      cwd: COMMANDER_CWD,
      systemPromptMode: "replace",
      systemPrompt,
      toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST],
      ...(model ? { model } : {}),
    },
    background: true,
    notifyOnFinish: false,
  };

  const result = await input.createAgent(createInput);
  input.logger.info(
    {
      component: "boot",
      agentId: result.snapshot.id,
      provider,
      ...(model ? { model } : {}),
      commanderHost: central.commanderHost ?? "local",
    },
    "mission_control.boot.commander_created",
  );
  return { created: true, agentId: result.snapshot.id };
}

async function findExistingCommander(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
): Promise<string | null> {
  for (const agent of agentManager.listAgents()) {
    if (agent.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
      return agent.id;
    }
  }
  const records = await agentStorage.list();
  const stored = records.find(
    (record) =>
      !record.archivedAt &&
      record.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE,
  );
  return stored?.id ?? null;
}
