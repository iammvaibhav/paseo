import { createHash } from "node:crypto";

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
import { readBundledCommanderPrompt } from "./commander-contract.js";
import type { MissionControlAppendInput } from "./store.js";

/**
 * The Commander is host-wide; `~` is the only cwd that always exists on every
 * host. The create paths expand `~` to the daemon's home (same contract as the
 * app's launch).
 */
export const COMMANDER_CWD = "~";
export const COMMANDER_TITLE = "Commander";

/**
 * Label carrying the Commander's build hash (baked system prompt + tool
 * allowlist) at spawn. Drift auto-recreate compares it on daemon boot: hash ≠
 * current build → archive the stale Commander and spawn fresh.
 */
export const COMMANDER_HASH_LABEL_KEY = "paseo.mission-control.build-hash";

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
  /**
   * Publishes a mission-control event. Used to surface a failed Commander
   * recreate as a Needs-you card (kind "blocked", blocker severity) while the
   * old Commander stays live. Absent in tests and on hosts without the
   * service.
   */
  publishEvent?: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
}

/** The Needs-you card headline for a failed Commander spawn. */
function commanderRecreateFailureHeadline(message: string): string {
  return `Commander recreate failed — ${message}`;
}

export interface EnsureCommanderOnBootResult {
  created: boolean;
  agentId?: string;
}

function commanderLabels(buildHash: string): Record<string, string> {
  return {
    [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
    [COMMANDER_HASH_LABEL_KEY]: buildHash,
  };
}

/**
 * The Commander's build hash: the bundled (repo-shipped) system prompt plus
 * the hard tool allowlist. Both change only on deploy, so a hash mismatch on
 * boot means a stale build — archive + recreate. User instructions from
 * central config intentionally do NOT enter the hash: editing
 * commanderInstructions is a runtime setting, not build drift, and must never
 * nuke the live conversation.
 */
export function computeCommanderBuildHash(): string {
  const shippedPrompt = readBundledCommanderPrompt().trim();
  const allowlist = [...COMMANDER_TOOL_ALLOWLIST].sort().join("\0");
  return createHash("sha256").update(shippedPrompt).update("\0").update(allowlist).digest("hex");
}

/**
 * Resolve the commander model override from central config: "provider/model"
 * or a bare model on the host's first registered provider. Absent → the
 * host's default (no model override).
 */
function resolveCommanderProviderModel(
  central: MissionControlCentralConfig,
  providerIds: readonly string[],
): { provider: string; model?: string } {
  const commanderModel = central.commanderModel?.trim() ?? null;
  const provider = providerIds[0];
  if (commanderModel === null) {
    return { provider };
  }
  const slashIndex = commanderModel.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: commanderModel.slice(0, slashIndex).trim(),
      model: commanderModel.slice(slashIndex + 1).trim(),
    };
  }
  return { provider, model: commanderModel };
}

/**
 * Spawn the fleet Commander with the static system prompt and a fresh context
 * pack as its first message. Central commanderModel overrides the host default
 * model. Single fleet commander: callers must have verified no live
 * commander-labeled agent exists.
 */
export async function spawnCommander(
  input: EnsureCommanderOnBootInput,
): Promise<{ agentId: string }> {
  const { systemPrompt, firstMessage } = await buildCommanderLaunchConfig(input.launchContext);
  const providerIds = input.providerSnapshotManager.listRegisteredProviderIds();
  const { provider, model } = resolveCommanderProviderModel(input.centralConfig(), providerIds);

  const createInput: CreateAgentFromMcpInput = {
    kind: "mcp",
    provider,
    title: COMMANDER_TITLE,
    initialPrompt: firstMessage,
    cwd: COMMANDER_CWD,
    labels: commanderLabels(computeCommanderBuildHash()),
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
      component: "commander",
      agentId: result.snapshot.id,
      provider,
      ...(model ? { model } : {}),
      commanderHost: input.centralConfig().commanderHost ?? "local",
    },
    "mission_control.commander.spawned",
  );
  return { agentId: result.snapshot.id };
}

/**
 * Archive the current Commander (live or stored-only) so its conversation
 * stays in History while a fresh one takes over. Never throws on a missing
 * record — archiving is best-effort bookkeeping.
 */
export async function archiveCommanderAgent(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  agentId: string,
  logger: Logger,
): Promise<void> {
  logger.info({ component: "commander", agentId }, "mission_control.commander.archiving_stale");
  const live = agentManager.getAgent(agentId);
  if (live) {
    await agentManager.archiveAgent(agentId);
    return;
  }
  const record = await agentStorage.get(agentId);
  if (record && !record.archivedAt) {
    await agentManager.archiveSnapshot(agentId, new Date().toISOString());
  }
}

/**
 * Reset the Commander (mission_control.commander.reset + drift recreate):
 * spawn a fresh one with a new context pack first; once it is live, archive
 * the current one (its conversation stays in History). A failed spawn keeps
 * the current Commander and surfaces the error as a Needs-you card instead of
 * leaving the fleet with none. Shares the drift-recreate machinery with
 * ensureCommanderOnBoot.
 */
export async function resetCommander(
  input: EnsureCommanderOnBootInput,
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  if (input.launchContext.daemonConfigStore.get().missionControl?.enabled === false) {
    return { ok: false, error: "Mission Control is disabled on this host" };
  }
  const central = input.centralConfig();
  const designated =
    central.commanderHost === null ||
    central.commanderHost === undefined ||
    central.commanderHost === "local" ||
    central.commanderHost === input.hostName ||
    (input.hostAlias !== null && central.commanderHost === input.hostAlias);
  if (!designated) {
    return { ok: false, error: "This host is not the designated commander host" };
  }
  const providerIds = input.providerSnapshotManager.listRegisteredProviderIds();
  if (providerIds.length === 0) {
    return { ok: false, error: "No provider registered on this host" };
  }

  const existing = await findExistingCommander(input.agentManager, input.agentStorage);
  // Spawn-first swap: the current Commander stays live until the fresh one is
  // up. A failed spawn (live incident: "Provider claude is disabled") must not
  // leave the fleet with NO Commander — the old one is kept and the error is
  // surfaced as a Needs-you card. Only after the new Commander is live is the
  // old one archived (conversation stays in History).
  try {
    const { agentId } = await spawnCommander(input);
    if (existing) {
      await archiveCommanderAgent(input.agentManager, input.agentStorage, existing, input.logger);
    }
    input.logger.info(
      { component: "commander", agentId, archived: existing ?? null },
      "mission_control.commander.reset_complete",
    );
    return { ok: true, agentId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.error(
      { err: error, component: "commander", agentId: existing ?? null },
      "mission_control.commander.reset_failed",
    );
    if (existing) {
      input.publishEvent?.({
        agentId: existing,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: commanderRecreateFailureHeadline(message),
      });
    }
    return { ok: false, error: message };
  }
}

/**
 * Daemon-boot commander ensure (spec: "Nothing needed in deploy scripts"): when
 * this host is the designated commander host and no commander-labeled agent
 * exists (live or unarchived), create it with the static system prompt and the
 * context pack as its first message. Central commanderModel overrides the host
 * default model. Single fleet commander: never creates a second one.
 *
 * Drift auto-recreate (spec Commander): the stored Commander carries its build
 * hash (system prompt + tool allowlist); when it differs from the current
 * build's hash, a fresh Commander is spawned first and the stale one archived
 * once the new one is live — the old conversation stays in History, and a
 * failed spawn keeps the stale Commander running (surfaced as a Needs-you
 * card) rather than leaving none. Logs under component "commander".
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

  const providerIds = input.providerSnapshotManager.listRegisteredProviderIds();
  if (providerIds.length === 0) {
    input.logger.warn(
      { component: "boot" },
      "mission_control.boot.no_provider — no provider registered; Commander creation deferred",
    );
    return { created: false };
  }

  const existing = await findExistingCommander(input.agentManager, input.agentStorage);
  if (existing) {
    const record = await input.agentStorage.get(existing);
    const storedHash = record?.labels?.[COMMANDER_HASH_LABEL_KEY] ?? null;
    const currentHash = computeCommanderBuildHash();
    if (storedHash === currentHash) {
      return { created: false, agentId: existing };
    }
    // Drift: a stale build (prompt/tool allowlist changed since spawn, or a
    // pre-hash Commander). Logged before the swap so the boot trail shows what
    // triggered it.
    input.logger.info(
      {
        component: "commander",
        agentId: existing,
        storedHash: storedHash ?? null,
        currentHash,
      },
      "mission_control.commander.drift_detected",
    );
    // Spawn-first swap: the stale Commander stays live until the fresh one is
    // up, so a failed spawn keeps the fleet talking instead of leaving the
    // board's empty state for minutes (live incident: "Provider claude is
    // disabled" — the old Commander had already been archived). The old one is
    // archived only after the new Commander is live; on failure it is kept and
    // the error surfaces as a Needs-you card.
    try {
      const { agentId } = await spawnCommander(input);
      await archiveCommanderAgent(input.agentManager, input.agentStorage, existing, input.logger);
      input.logger.info(
        { component: "commander", agentId, recreated: true },
        "mission_control.commander.ensured",
      );
      return { created: true, agentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.logger.error(
        { err: error, component: "commander", agentId: existing },
        "mission_control.commander.recreate_failed",
      );
      input.publishEvent?.({
        agentId: existing,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: commanderRecreateFailureHeadline(message),
      });
      return { created: false, agentId: existing };
    }
  }

  const { agentId } = await spawnCommander(input);
  input.logger.info(
    { component: "commander", agentId, recreated: false },
    "mission_control.commander.ensured",
  );
  return { created: true, agentId };
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
