import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type {
  BoundCreateAgentCommand,
  CreateAgentFromMcpInput,
} from "../agent/create-agent/create.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { expandUserPath } from "../path-utils.js";
import { areEquivalentPaths } from "../../utils/path.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import {
  COMMANDER_TOOL_ALLOWLIST,
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
  buildCommanderSystemPrompt,
} from "./commander-contract.js";
import type { FleetContextDependencies } from "./context.js";
import { buildCommanderLaunchConfig } from "./context.js";
import { isCommanderSystemMarkerName } from "./naming-backfill.js";
import type { MissionControlAppendInput } from "./store.js";

// The allowlist now lives in commander-contract.ts (the static contract
// module) so session reloads can re-derive it; re-export for callers that
// referenced it from commander-boot.
export { COMMANDER_TOOL_ALLOWLIST } from "./commander-contract.js";

/**
 * The Commander launch-contract hook for the session-config pipeline: for the
 * commander-labeled agent (label value "commander"; verifiers carry their own
 * contract and are excluded), re-derive the contract (systemPromptMode
 * "replace" + current bundled prompt + tool allowlist) from the CURRENT build
 * on every session build — create, reload, resume, import. The stored record
 * never needs to carry the contract, and a Commander can never come back from
 * a reload with the default coding prompt or an unrestricted catalog (live
 * incident: a running Commander resumed that way because its old record
 * predated contract persistence). Returns null for every other agent so
 * worker/verifier sessions are untouched.
 */
export function buildCommanderLaunchContract(
  labels: Record<string, string>,
  centralConfig: () => MissionControlCentralConfig,
): Partial<AgentSessionConfig> | null {
  if (labels[MISSION_CONTROL_LABEL_KEY] !== MISSION_CONTROL_LABEL_VALUE) {
    return null;
  }
  return {
    systemPromptMode: "replace",
    systemPrompt: buildCommanderSystemPrompt(centralConfig().commanderInstructions),
    toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST],
  };
}

/**
 * The Commander is host-wide; `~` is the only cwd that always exists on every
 * host. The create paths expand `~` to the daemon's home (same contract as the
 * app's launch).
 */
export const COMMANDER_CWD = "~";
export const COMMANDER_TITLE = "Commander";

/**
 * The Commander's home workspace is host-scoped infrastructure, never user
 * work. Its title is stable and host-identifying — never message-derived (live
 * incident: the `<paseo-system>` context-pack envelope leaked into the
 * workspace title on every spawn).
 */
export function commanderHomeWorkspaceTitle(hostName: string, hostAlias: string | null): string {
  return `Commander (${hostAlias?.trim() || hostName})`;
}

/**
 * The single designation rule: ONLY an explicitly designated host may
 * boot-ensure (or reset) the fleet Commander. `commanderHost` null/unset
 * designates NO host — a daemon must never self-designate by default (live
 * incident: every host boot-ensured its own Commander because null read as
 * "local is designated", violating the single-fleet-Commander invariant).
 * "local" is the explicit designation value for the local daemon (the host
 * picker writes the daemon hostname, with the host label as fallback).
 */
export function isDesignatedCommanderHost(input: {
  central: Pick<MissionControlCentralConfig, "commanderHost">;
  hostName: string;
  hostAlias: string | null;
}): boolean {
  const commanderHost = input.central.commanderHost?.trim() || null;
  if (commanderHost === null) {
    return false;
  }
  return (
    commanderHost === "local" ||
    commanderHost === input.hostName ||
    (input.hostAlias !== null && commanderHost === input.hostAlias)
  );
}

/**
 * Label carrying the Commander's build hash (baked system prompt + tool
 * allowlist) at spawn. Drift auto-recreate compares it on daemon boot: hash ≠
 * current build → archive the stale Commander and spawn fresh.
 */
export const COMMANDER_HASH_LABEL_KEY = "paseo.mission-control.build-hash";

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
   * Workspace registry seam for the Commander's home workspace: reuse the
   * existing non-archived home-dir workspace (or provision one) and boot
   * self-heal orphaned `<paseo-system>` workspaces.
   */
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "upsert" | "archive">;
  /** Provisions a fresh home workspace only when none exists for reuse. */
  createCommanderWorkspace: (cwd: string, title: string) => Promise<{ workspaceId: string }>;
  /**
   * Publishes a mission-control event. Used to surface a failed Commander
   * recreate as a Needs-you card (kind "blocked", blocker severity) while the
   * old Commander stays live. Absent in tests and on hosts without the
   * service.
   */
  publishEvent?: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  /**
   * Invoked after a successful Commander spawn (createAgent). Used by the
   * daemon to arm the ack-drop tracker for the context-pack first turn.
   */
  onCommanderCreated?: (agentId: string) => void;
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
  const shippedPrompt = buildCommanderSystemPrompt();
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

  // The Commander reuses the host's existing home-dir workspace (provisioning
  // only when none exists) and is stamped with it. Passing an explicit
  // workspaceId also skips the create path's fresh-workspace provisioning and
  // its message-derived auto-naming — both were live-incident sources of one
  // `<paseo-system>` home workspace per spawn.
  const workspaceId = await resolveOrCreateCommanderWorkspace(input);

  const createInput: CreateAgentFromMcpInput = {
    kind: "mcp",
    provider,
    title: COMMANDER_TITLE,
    initialPrompt: firstMessage,
    cwd: COMMANDER_CWD,
    workspaceId,
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
      workspaceId,
      ...(model ? { model } : {}),
      commanderHost: input.centralConfig().commanderHost ?? null,
    },
    "mission_control.commander.spawned",
  );
  input.onCommanderCreated?.(result.snapshot.id);
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

export interface CommanderWorkspaceDependencies {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "upsert" | "archive">;
  /**
   * Provisions a fresh directory workspace for a cwd + title. Used only when
   * no non-archived home-dir workspace exists yet; injected so commander-boot
   * stays decoupled from workspace provisioning internals.
   */
  createCommanderWorkspace: (cwd: string, title: string) => Promise<{ workspaceId: string }>;
  hostName: string;
  hostAlias: string | null;
  logger: Logger;
}

/**
 * Resolve the Commander's home workspace (cwd `~`): reuse the host's existing
 * non-archived home-dir workspace when one exists, otherwise provision a fresh
 * one. Never provisions a second record for the same cwd (live incident: a new
 * `<paseo-system>` home workspace on every spawn/reset — 3 records on macbook,
 * 2 on iammvaibhav, identical cwd). The workspace carries the stable
 * host-derived title; a reused workspace whose title is missing or still the
 * machinery `<paseo-system>` marker is re-titled to it. Returns the
 * workspaceId to stamp on the Commander.
 */
export async function resolveOrCreateCommanderWorkspace(
  input: CommanderWorkspaceDependencies,
): Promise<string> {
  const homeCwd = expandUserPath(COMMANDER_CWD);
  const workspaces = await input.workspaceRegistry.list();
  const existing = workspaces
    .filter((workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, homeCwd))
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.workspaceId.localeCompare(right.workspaceId),
    )[0];
  if (existing) {
    const stableTitle = commanderHomeWorkspaceTitle(input.hostName, input.hostAlias);
    if (needsCommanderTitleStabilization(existing.title)) {
      await input.workspaceRegistry.upsert({
        ...existing,
        title: stableTitle,
        updatedAt: new Date().toISOString(),
      });
      input.logger.info(
        { component: "commander", workspaceId: existing.workspaceId, title: stableTitle },
        "mission_control.commander.workspace_title_stabilized",
      );
    }
    return existing.workspaceId;
  }
  const title = commanderHomeWorkspaceTitle(input.hostName, input.hostAlias);
  const workspace = await input.createCommanderWorkspace(homeCwd, title);
  input.logger.info(
    { component: "commander", workspaceId: workspace.workspaceId, cwd: homeCwd, title },
    "mission_control.commander.workspace_provisioned",
  );
  return workspace.workspaceId;
}

/**
 * Whether a reused Commander home workspace's title needs stabilization: it
 * is missing or still the legacy `<paseo-system>` machinery marker, so the
 * provisioning path re-titles it to the stable host-derived title. (The
 * provisioning-overwrite decision — not shared with orphan cleanup or the
 * naming backfill.)
 */
export function needsCommanderTitleStabilization(title: string | null | undefined): boolean {
  return !title || isCommanderSystemMarkerName(title);
}

/**
 * Whether a workspace title is the legacy `<paseo-system>` machinery marker
 * (pre-fix auto-namer leak). The orphan self-heal treats it as commander
 * infrastructure — the legacy-marker decision, separate from the current
 * stable host-derived title check.
 */
export function isLegacyCommanderWorkspaceMarker(title: string): boolean {
  return isCommanderSystemMarkerName(title);
}

/**
 * True when a workspace title marks commander home-dir infrastructure: the
 * legacy `<paseo-system>` marker (pre-fix auto-namer leak) or the current
 * stable host-derived title. The orphan self-heal treats both as commander
 * machinery so old orphans are still cleaned and newly provisioned workspaces
 * are recognised too — the live-agent guard is what keeps a live Commander's
 * workspace from being archived.
 */
export function isCommanderHomeWorkspaceTitle(
  title: string | null | undefined,
  hostName: string,
  hostAlias: string | null,
): boolean {
  if (!title) {
    return false;
  }
  return (
    isLegacyCommanderWorkspaceMarker(title) ||
    title === commanderHomeWorkspaceTitle(hostName, hostAlias)
  );
}

/**
 * Boot self-heal for orphaned Commander home workspaces (live incident: every
 * daemon self-designated and each spawn provisioned a NEW home workspace titled
 * `<paseo-system>`, leaving sidebar-visible records with no live agent — 3 on
 * macbook incl. one whose spawn failed after provisioning, 2 on iammvaibhav).
 *
 * Archives every non-archived workspace whose cwd is the host's home directory,
 * whose title marks commander infrastructure (legacy `<paseo-system>` or the
 * stable `Commander (host)` title), and that has NO live agent attached. Real
 * workspaces are never touched (different cwd, different title, or any live
 * agent). Idempotent: archived records are skipped. Logs each archive; returns
 * the count.
 */
export async function archiveOrphanCommanderWorkspaces(input: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "archive">;
  agentStorage: Pick<AgentStorage, "list">;
  hostName: string;
  hostAlias: string | null;
  logger: Logger;
}): Promise<number> {
  const homeCwd = expandUserPath(COMMANDER_CWD);
  // "Live" = any UNARCHIVED stored agent references the workspace. At daemon
  // boot the in-memory agent manager is still empty (records load on demand),
  // so only storage can tell whether a workspace is attached to a live agent —
  // the live Commander's workspace must never be archived.
  const liveAgentWorkspaceIds = new Set(
    (await input.agentStorage.list())
      .filter((record) => !record.archivedAt && Boolean(record.workspaceId))
      .map((record) => record.workspaceId as string),
  );
  const workspaces = await input.workspaceRegistry.list();
  let archived = 0;
  for (const workspace of workspaces) {
    if (workspace.archivedAt) {
      continue;
    }
    if (!isCommanderHomeWorkspaceTitle(workspace.title, input.hostName, input.hostAlias)) {
      continue;
    }
    if (!areEquivalentPaths(workspace.cwd, homeCwd)) {
      continue;
    }
    if (liveAgentWorkspaceIds.has(workspace.workspaceId)) {
      continue;
    }
    await input.workspaceRegistry.archive(workspace.workspaceId, new Date().toISOString());
    archived += 1;
    input.logger.info(
      {
        component: "commander",
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        title: workspace.title,
        archivedAt: new Date().toISOString(),
      },
      "mission_control.boot.orphan_commander_workspace_archived",
    );
  }
  if (archived > 0) {
    input.logger.info(
      { component: "commander", archived },
      "mission_control.boot.orphan_commander_workspaces_archived",
    );
  }
  return archived;
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
  if (
    !isDesignatedCommanderHost({ central, hostName: input.hostName, hostAlias: input.hostAlias })
  ) {
    const hasDesignation = Boolean(central.commanderHost?.trim());
    return {
      ok: false,
      error: hasDesignation
        ? "This host is not the designated commander host"
        : "No Commander host designated — pick one in Mission Control settings",
    };
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
  // Boot self-heal for orphaned Commander home workspaces (live incident:
  // `<paseo-system>`-titled home workspaces left by failed/reset spawns, no
  // live agent, visible in the sidebar). Every host cleans its own home —
  // runs before the designation gate so non-designated hosts retire their
  // orphans too. Never blocks boot: cleanup failures are logged, not fatal.
  try {
    await archiveOrphanCommanderWorkspaces({
      workspaceRegistry: input.workspaceRegistry,
      agentStorage: input.agentStorage,
      hostName: input.hostName,
      hostAlias: input.hostAlias,
      logger: input.logger,
    });
  } catch (error) {
    input.logger.warn(
      { err: error, component: "boot" },
      "mission_control.boot.orphan_cleanup_failed",
    );
  }
  const central = input.centralConfig();
  if (
    !isDesignatedCommanderHost({ central, hostName: input.hostName, hostAlias: input.hostAlias })
  ) {
    if (!central.commanderHost?.trim()) {
      input.logger.info(
        { component: "boot" },
        "mission_control.boot.no_commander_host_designated — no host runs the fleet Commander until one is picked in Mission Control settings",
      );
    }
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
