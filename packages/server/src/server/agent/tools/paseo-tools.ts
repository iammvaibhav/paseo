import { basename, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ensureValidJson } from "../../json-utils.js";
import type { Logger } from "pino";

import type {
  AgentMode,
  AgentPromptInput,
  AgentProvider,
  AgentSessionConfig,
  AgentTimelineItem,
  AgentTimelineUserMessageClassification,
} from "../agent-sdk-types.js";
import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../agent-manager.js";
import { AgentProfileSchema } from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
  AgentAttachmentSchema,
  type AgentAttachment,
} from "../../messages.js";
import type { AgentListItemPayload } from "../../messages.js";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
} from "../agent-projections.js";
import { curateAgentActivity } from "../activity-curator.js";
import { selectItemsByProjectedLimit } from "../timeline-projection.js";
import type { AgentStorage } from "../agent-storage.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { supportsDiskTimeline, tryReadProviderTimelineFromDisk } from "../provider-disk-history.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import { createAgentCommand, type CreateAgentFromMcpInput } from "../create-agent/create.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../../worktree-session.js";
import type { ScheduleService } from "../../schedule/service.js";
import {
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  type ScheduleCadence,
  type UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderModeSchema,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
  waitForAgentWithTimeout,
} from "../mcp-shared.js";
import {
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setupFinishNotification,
  startAgentRun,
} from "../agent-prompt.js";
import { buildAgentPrompt, renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { resolveCommanderUserMessage } from "../../mission-control/tagging.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorkspaceIdForPath } from "../../resolve-workspace-id-for-path.js";
import { deriveWorkspaceDisplayName } from "../../workspace-registry-model.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { buildPeerUnreachableError, type PeerManager } from "../../peers/peer-manager.js";
import { MissionControlSearchMatchSchema } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlProposalSpawnPlan } from "@getpaseo/protocol/mission-control/types";
import { MissionControlMetaPlanSchema } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import { hasMissionControlLabels } from "../../mission-control/naming.js";
import {
  classifyFleetMetaAction,
  buildFleetMetaProposalInput,
  resolveMetaTargetHost,
} from "../../mission-control/fleet-meta.js";
import {
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
} from "../../mission-control/commander-contract.js";
import { MISSION_CONTROL_VERIFIER_LABEL_VALUE } from "../../mission-control/verifier.js";
import {
  SEARCH_TIER3_TIMEOUT_MS,
  buildFleetHistoryAskBrief,
  mergeFleetSearchMatches,
  parseHistoryAskMatches,
  runFleetSearchHost,
  type FleetSearchMatch,
  type FleetSearchTier3Runner,
} from "../../mission-control/search.js";
import type { MissionControlService } from "../../mission-control/service.js";
import type { MissionControlVerifierDispatcher } from "../../mission-control/verifier.js";
import { MissionControlReportStatusInputSchema } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import type { ProposalCreateInput } from "../../mission-control/approvals.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "./types.js";

export interface PaseoToolHostDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  providerSnapshotManager: ProviderSnapshotManager;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
  github?: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot" | "getCheckout"
  >;
  findWorkspaceIdForCwd?: ArchiveDependencies["findWorkspaceIdForCwd"];
  listActiveWorkspaces?: ArchiveDependencies["listActiveWorkspaces"];
  archiveWorkspaceRecord?: ArchiveDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchiveDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  createDirectoryWorkspace?: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  workspaceScripts?: Pick<WorkspaceScriptsService, "list" | "launch" | "stop">;
  markWorkspaceArchiving?: ArchiveDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchiveDependencies["clearWorkspaceArchiving"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<string>;
  browserToolsEnabled?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  peerManager?: PeerManager | null;
  missionControlService?: MissionControlService | null;
  paseoHome?: string;
  worktreesRoot?: string;
  /**
   * This daemon's serverId, for building paseo://h/… deep links.
   */
  serverId?: string;
  /**
   * This daemon's Mission Control host alias (missionControl.hostAlias).
   * Fleet tool RESULTS replace the literal "local" host with this alias so
   * the model's own echo and any raw JSON never surface "local" (spec: never
   * render "local" as a host). Absent → keep "local" (the UI resolves it).
   */
  hostAlias?: string | null;
  /**
   * ID of the agent that is using this tool catalog.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /**
   * Caller labels captured at catalog-build time. Launch contexts are built
   * before the agent registers, so label-gated tools (verifier) must not
   * rely solely on a registry lookup.
   */
  callerLabels?: Readonly<Record<string, string>>;
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  /**
   * Mission Control verifier dispatcher. When present and the caller agent is
   * a verifier (paseo.mission-control=verifier), the catalog exposes the
   * verifier-only tools contact_worker and submit_verdict.
   */
  verifierDispatcher?: MissionControlVerifierDispatcher | null;
  logger: Logger;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveAgentListActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    parseTimestamp(agent.updatedAt),
    parseTimestamp(agent.lastUserMessageAt),
    parseTimestamp(agent.attentionTimestamp),
    parseTimestamp(agent.archivedAt),
    parseTimestamp(agent.createdAt),
  );
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

const WorkspaceAutomationSummarySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.enum(["local", "worktree"]),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  title: z.string().nullable(),
});

function toWorkspaceAutomationSummary(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    isolation: workspace.kind === "worktree" ? ("worktree" as const) : ("local" as const),
    kind: workspace.kind,
    title: workspace.title,
  };
}

type WorkspaceWorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

interface WorkspaceWorktreeOptions {
  mode?: WorkspaceWorktreeMode;
  worktreeSlug?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  prNumber?: number;
  forge?: string;
}

type WorkspaceWorktreeTarget = Pick<
  CreatePaseoWorktreeCommandInput,
  "action" | "branchName" | "refName" | "checkoutSource"
>;

function assertOptionsAbsent(
  options: Array<[name: string, value: unknown]>,
  message: string,
): void {
  if (options.some(([, value]) => value !== undefined)) {
    throw new Error(message);
  }
}

function resolveWorkspaceWorktreeTarget(input: WorkspaceWorktreeOptions): WorkspaceWorktreeTarget {
  switch (input.mode ?? "branch-off") {
    case "branch-off":
      assertOptionsAbsent(
        [
          ["branch", input.branch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branch, prNumber, and forge require a checkout mode",
      );
      return {
        action: "branch-off",
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseBranch ? { refName: input.baseBranch } : {}),
      };
    case "checkout-branch":
      if (!input.branch) {
        throw new Error("branch is required for checkout-branch mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branchName, baseBranch, prNumber, and forge are not valid for checkout-branch mode",
      );
      return { action: "checkout", refName: input.branch };
    case "checkout-pr":
      if (input.prNumber === undefined) {
        throw new Error("prNumber is required for checkout-pr mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["branch", input.branch],
        ],
        "branchName, baseBranch, and branch are not valid for checkout-pr mode",
      );
      return {
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          ...(input.forge ? { forge: input.forge } : {}),
          number: input.prNumber,
        },
      };
  }
}

function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function compareAgentListItems(a: AgentListItemPayload, b: AgentListItemPayload): number {
  const attentionDelta =
    Number(b.requiresAttention ?? false) - Number(a.requiresAttention ?? false);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as Record<string, number>;
  const statusDelta = (statusOrder[a.status] ?? 999) - (statusOrder[b.status] ?? 999);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return resolveAgentListActivityTime(b) - resolveAgentListActivityTime(a);
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
}

function resolveScheduleUpdateProviderAndModel(params: {
  provider?: string;
  model?: string | null;
}): { provider?: string; model?: string | null } {
  const providerInput = params.provider?.trim();
  const modelInput = typeof params.model === "string" ? params.model.trim() : params.model;

  if (params.model !== undefined && modelInput === "") {
    throw new Error("model cannot be empty");
  }

  if (!providerInput) {
    return params.model !== undefined ? { model: modelInput } : {};
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      ...(params.model !== undefined ? { model: modelInput } : {}),
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }
  if (params.model === null) {
    throw new Error("provider specifies a model but model is null");
  }
  if (typeof modelInput === "string" && modelInput !== modelFromProvider) {
    throw new Error("Conflicting model values provided");
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}

interface ScheduleUpdateToolInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string | null;
  prompt?: string;
  maxRuns?: number | null;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
  expiresIn?: string;
  clearExpires?: boolean;
}

function normalizeScheduleCadenceArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function normalizeScheduleTimeZoneArg(value: string | undefined): string | undefined {
  return normalizeScheduleCadenceArg(value);
}

function resolveScheduleUpdateCadence(input: ScheduleUpdateToolInput): ScheduleCadence | undefined {
  const every = normalizeScheduleCadenceArg(input.every);
  const cron = normalizeScheduleCadenceArg(input.cron);
  const timeZone = normalizeScheduleTimeZoneArg(input.timezone);

  if (every !== undefined && cron !== undefined) {
    throw new Error("Specify at most one of every or cron");
  }
  if (timeZone !== undefined && cron === undefined) {
    throw new Error("timezone can only be used with cron");
  }
  if (every !== undefined) {
    // COMPAT(scheduleEveryInput): accept the old hidden field and canonicalize it before write.
    // Added in v0.2.0; remove after 2027-01-17.
    const everyMs = parseDurationString(every);
    const expression = everyMsToFiveFieldCron(everyMs);
    if (expression) {
      return { type: "cron", expression };
    }
    throw new Error(`${every} cannot be represented faithfully by five-field cron`);
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron,
      ...(timeZone !== undefined ? { timezone: timeZone } : {}),
    };
  }
  return undefined;
}

function resolveScheduleUpdateExpiresAt(input: ScheduleUpdateToolInput): string | null | undefined {
  if (input.expiresIn !== undefined && input.clearExpires) {
    throw new Error("Specify at most one of expiresIn or clearExpires");
  }
  if (input.expiresIn !== undefined) {
    return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
  }
  if (input.clearExpires) {
    return null;
  }
  return undefined;
}

function buildScheduleUpdateInput(input: ScheduleUpdateToolInput): UpdateScheduleInput {
  const cadence = resolveScheduleUpdateCadence(input);
  const expiresAt = resolveScheduleUpdateExpiresAt(input);
  const providerModelPatch = resolveScheduleUpdateProviderAndModel({
    provider: input.provider,
    model: input.model,
  });
  const newAgentConfig = {
    ...(providerModelPatch.provider !== undefined ? { provider: providerModelPatch.provider } : {}),
    ...(providerModelPatch.model !== undefined ? { model: providerModelPatch.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(Object.keys(newAgentConfig).length > 0 ? { newAgentConfig } : {}),
  };
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

const historySearchResultItemSchema = z.object({
  agentId: z.string(),
  name: z.string().optional(),
  title: z.string().nullable().optional(),
  description: z.string().optional(),
  cwd: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  link: z.string().optional(),
});

type HistorySearchResultItem = z.infer<typeof historySearchResultItemSchema>;

interface HistorySearchTarget {
  name?: string;
  title?: string | null;
  shortDescription?: string;
  cwd: string;
}

/**
 * Multi-token case-insensitive metadata filter, mirroring the History Ask
 * fuzzy matcher (packages/app/src/history-ask/fuzzy.ts): every whitespace-
 * separated token must match at least one of title/name/description/cwd.
 */
function matchesHistorySearch(query: string, target: HistorySearchTarget): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  const fields = [target.title, target.name, target.shortDescription, target.cwd]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

function resolveTerminalKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}

/**
 * Shared selection/curation for get_agent_activity, across the live and peek
 * paths so both produce byte-identical summaries.
 */
function curateActivitySummary(input: { timeline: AgentTimelineItem[]; limit?: number }): {
  updateCount: number;
  content: string;
} {
  const selection = selectItemsByProjectedLimit({
    items: input.timeline,
    direction: "tail",
    limit: input.limit ?? 0,
  });
  const curatedContent = curateAgentActivity(selection.items);
  const { totalProjected, shownProjected } = selection;

  const noun = totalProjected === 1 ? "activity" : "activities";
  const countHeader =
    input.limit && shownProjected < totalProjected
      ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${input.limit})`
      : `Showing all ${totalProjected} ${noun}`;

  return {
    updateCount: input.timeline.length,
    content: `${countHeader}\n\n${curatedContent}`,
  };
}

/**
 * Read an agent's activity without ever spawning its provider process: live
 * agents answer from the in-memory timeline, closed agents from the stored
 * record plus offline provider disk history.
 */
async function peekAgentActivity(input: {
  agentId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Promise<{ timeline: AgentTimelineItem[]; currentModeId: string | null }> {
  const live = input.agentManager.getAgent(input.agentId);
  if (live) {
    return {
      timeline: input.agentManager.getTimeline(input.agentId),
      currentModeId: live.currentModeId,
    };
  }

  const record = await input.agentStorage.get(input.agentId);
  if (!record) {
    throw new Error(`Agent ${input.agentId} not found`);
  }

  if (!input.agentManager.hasTimeline(input.agentId)) {
    const sessionId = record.persistence?.sessionId;
    if (sessionId && supportsDiskTimeline(record.provider)) {
      const diskItems = await tryReadProviderTimelineFromDisk(
        {
          provider: record.provider,
          cwd: record.cwd,
          sessionId,
          ...(typeof record.persistence?.nativeHandle === "string"
            ? { nativeHandle: record.persistence.nativeHandle }
            : {}),
        },
        { logger: input.logger },
      );
      if (diskItems && diskItems.length > 0) {
        input.agentManager.seedTimelineFromItems(input.agentId, diskItems);
      }
    }
    if (!input.agentManager.hasTimeline(input.agentId)) {
      input.agentManager.seedTimelineFromItems(input.agentId, []);
    }
  }

  const rows = input.agentManager.fetchTimeline(input.agentId, {
    direction: "tail",
    limit: 0,
  }).rows;
  return {
    timeline: rows.map((row) => row.item),
    currentModeId: null,
  };
}

/**
 * Last report_status headlines per agent (cap 5, oldest -> newest). Only
 * source "self" events are report_status reports; deterministic system cards
 * never pollute the roster summary.
 */
function collectReportStatusHeadlines(
  events: readonly MissionControlEvent[],
): Map<string, string[]> {
  const byAgent = new Map<string, MissionControlEvent[]>();
  for (const event of events) {
    if (event.source !== "self") {
      continue;
    }
    const list = byAgent.get(event.agentId) ?? [];
    list.push(event);
    byAgent.set(event.agentId, list);
  }
  const result = new Map<string, string[]>();
  for (const [agentId, list] of byAgent) {
    list.sort((left, right) => left.ts.localeCompare(right.ts));
    result.set(
      agentId,
      list.slice(-5).map((event) => event.headline),
    );
  }
  return result;
}

/**
 * The agent's most recent non-system user message (roster enrichment).
 * System-injected envelopes (digests, notifications) are never user messages;
 * closed agents without a buffered timeline report null.
 */
function lastUserMessageFor(agentManager: AgentManager, agentId: string): string | null {
  const timeline = agentManager.getTimeline(agentId);
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type !== "user_message") {
      continue;
    }
    if (isSystemInjectedEnvelope(item.text)) {
      continue;
    }
    return item.text;
  }
  return null;
}

async function listPeerFleetAgents(input: {
  client: DaemonClient;
  peerName: string;
  includeArchived: boolean;
  statuses?: readonly string[];
  sinceMs: number;
}): Promise<Array<AgentListItemPayload & { host: string }>> {
  const payload = await input.client.fetchAgents({
    ...(input.includeArchived ? { filter: { includeArchived: true } } : {}),
    page: { limit: 200 },
  });
  const result: Array<AgentListItemPayload & { host: string }> = [];
  for (const entry of payload.entries) {
    if (
      input.statuses &&
      input.statuses.length > 0 &&
      !input.statuses.includes(entry.agent.status)
    ) {
      continue;
    }
    if (Date.parse(entry.agent.updatedAt) >= input.sinceMs) {
      result.push({ ...toAgentListItemPayload(entry.agent), host: input.peerName });
    }
  }
  return result;
}

/**
 * The spawn outcome status: live agents carry `lifecycle`, persisted records
 * carry `lastStatus`, and anything else is idle.
 */
function resolveSpawnedAgentStatus(spawned: ManagedAgent | StoredAgentRecord): string {
  if ("lifecycle" in spawned) {
    return spawned.lifecycle;
  }
  if ("lastStatus" in spawned) {
    return spawned.lastStatus;
  }
  return "idle";
}

interface CommanderSpawnPlanInput {
  host: string;
  provider: string;
  model: string | undefined;
  title?: string;
  summary: string;
  initialPrompt?: string;
  cwd?: string;
  workspaceId?: string;
  settings?: {
    modeId?: string;
    thinkingOptionId?: string;
    features?: Record<string, unknown>;
  };
  labels?: Record<string, string>;
}

/** The spawnPlan reconstruction payload for a Commander spawn proposal. */
function buildCommanderSpawnPlan(input: CommanderSpawnPlanInput): MissionControlProposalSpawnPlan {
  const {
    host,
    provider,
    model,
    title,
    summary,
    initialPrompt,
    cwd,
    workspaceId,
    settings,
    labels,
  } = input;
  return {
    host,
    provider,
    ...(model ? { model } : {}),
    ...(title ? { title } : {}),
    summary,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(settings?.modeId ? { mode: settings.modeId } : {}),
    ...(settings?.thinkingOptionId ? { thinking: settings.thinkingOptionId } : {}),
    ...(settings?.features ? { features: settings.features } : {}),
    ...(labels ? { labels } : {}),
  };
}

interface CommanderSpawnProposalInput {
  serverId: string;
  host: string;
  provider: string;
  title?: string;
  initialPrompt?: string;
  cwd?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  settings?: {
    model?: string | null;
    modeId?: string;
    thinkingOptionId?: string;
    features?: Record<string, unknown>;
  };
  /** M8 instruction ledger: the open instruction id this dispatch answers. */
  respondsTo?: string;
}

/**
 * The proposal payload for a Commander spawn (fleet_create_agent): kind
 * "spawn" whose card shows what would be created (host, provider/model,
 * brief); approving (or auto mode) executes the spawn via the approvals spawn
 * hook. Pure builder — the approval gate decides ask-vs-auto; the caller
 * routes through runCommanderGatedAction.
 */
function buildCommanderSpawnProposalInput(input: CommanderSpawnProposalInput): ProposalCreateInput {
  const { host, provider, settings, title, initialPrompt, cwd, workspaceId, labels } = input;
  const slash = provider.indexOf("/");
  const model = slash > 0 ? provider.slice(slash + 1) : (settings?.model ?? undefined);
  const cleanProvider = slash > 0 ? provider.slice(0, slash) : provider;
  const summary = `Spawn ${title ?? "an agent"} (${provider}) on ${host}`;
  return {
    origin: "commander",
    serverId: input.serverId,
    targetAgentId: "",
    message: initialPrompt ? `${summary}: ${initialPrompt.slice(0, 200)}` : summary,
    deliveryMode: "interrupt",
    reason: "Commander spawn",
    classification: "normal",
    kind: "spawn",
    spawnPlan: buildCommanderSpawnPlan({
      host,
      provider: cleanProvider,
      model,
      title,
      summary,
      initialPrompt,
      cwd,
      workspaceId,
      settings,
      labels,
    }),
    ...(input.respondsTo ? { respondsTo: input.respondsTo } : {}),
  };
}

/**
 * Post-process a resolved spawn proposal into the fleet_create_agent tool's
 * structured content: pending-approval, an already-spawned agent (auto mode
 * — the spawn hook created it), or sent.
 */
async function formatSpawnProposalOutcome(input: {
  proposal: MissionControlProposal;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
}): Promise<Record<string, unknown>> {
  const { proposal, agentManager, agentStorage } = input;
  const cleanProvider = proposal.spawnPlan?.provider ?? "unknown";
  if (proposal.status === "pending") {
    return {
      agentId: null,
      type: cleanProvider,
      status: "pending-approval",
      guidance: `Spawn request sent for approval (proposal ${proposal.id}). The agent will be created once approved.`,
    };
  }
  // Auto mode: the spawn hook already created the agent.
  if (proposal.spawnedAgentId) {
    const spawned =
      agentManager.getAgent(proposal.spawnedAgentId) ??
      (await agentStorage.get(proposal.spawnedAgentId));
    if (spawned) {
      return {
        agentId: spawned.id,
        type: spawned.provider,
        status: resolveSpawnedAgentStatus(spawned),
        cwd: spawned.cwd,
        ...(spawned.workspaceId ? { workspaceId: spawned.workspaceId } : {}),
      };
    }
  }
  return {
    agentId: null,
    type: cleanProvider,
    status: "sent",
    guidance: `Spawn request sent (proposal ${proposal.id}).`,
  };
}

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    workspaceScripts,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    callerAgentId,
    callerLabels,
    resolveSpeakHandler,
    resolveCallerContext,
    peerManager,
    missionControlService,
    serverId,
    logger,
  } = options;
  // The display label for THIS daemon in fleet tool results: the Mission
  // Control host alias when configured, else "local" (the daemon-side host
  // identifier the UI still resolves). Never the raw hostname — results and
  // the model's echo of them must read as fleet aliases, not machine names.
  const hostLabel = options.hostAlias?.trim() || "local";
  // Fleet-tool host normalization: "local", this daemon's own serverId /
  // hostname / hostAlias (case-insensitive trim — the world snapshot teaches
  // the Commander the aliases) all route to the LOCAL branch of a fleet tool;
  // a peer name routes to the peer client. One shared resolver with the meta
  // executor and the spawn executor (resolveMetaTargetHost) — never a second
  // fleet map interpretation.
  const isFleetLocalTarget = (host: string): boolean => {
    const resolved = resolveMetaTargetHost(
      { serverId: serverId ?? "", hostAlias: options.hostAlias, peerManager: peerManager ?? null },
      host,
    );
    return resolved.ok && resolved.kind === "local";
  };
  const childLogger = logger.child({ module: "agent", component: "paseo-tool-catalog" });
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;

  /**
   * Ask-mode gate for Commander actions (user decision: everything is gated in
   * ask mode except the status-ask nudge). The Commander is the ONLY
   * mission-control machinery that drives the fleet spawn/send tools, so its
   * fleet_create_agent and fleet_send_prompt calls route through the approval
   * gate as proposals (kind "spawn"/"send", origin "commander"). Auto mode
   * sends immediately via the approvals module; non-Commander callers
   * (workers spawning subagents) are untouched.
   */
  const isCommanderCaller =
    callerLabels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE;

  /**
   * M4: the single approval-gate wrap point for mutating Commander tools.
   * Every side-effectful Commander action (spawn, send, meta — fleet_create_agent,
   * fleet_send_prompt, fleet_meta) routes its Commander-caller path through
   * here: the tool declares itself mutating by supplying a proposal payload
   * builder, and the gate decides — ask mode holds the card pending, auto
   * mode approves and records, and destructive classification always asks
   * (the existing approvals predicate). Non-Commander callers are untouched
   * (workers spawning subagents use the plain create_agent path). Returns the
   * resolved proposal so the caller can describe the outcome (pending vs
   * sent); { ok: false } when the caller is not the Commander or Mission
   * Control is not enabled.
   */
  const runCommanderGatedAction = async (action: {
    /** Tool name for error messages (e.g. "fleet_meta"). */
    toolName: string;
    /** The parsed tool input, forwarded to classify + buildProposal. */
    toolInput: unknown;
    /**
     * Destructive classification hook. Defaults to "normal"; a tool that can
     * destroy fleet state (fleet_meta archive actions) classifies here so
     * the gate always asks, even in auto mode. The returned classification
     * is authoritative over the builder's.
     */
    classify?: (toolInput: unknown) => "normal" | "destructive";
    /** Build the ProposalCreateInput the gate decides on. */
    buildProposal: (toolInput: unknown) => Promise<ProposalCreateInput> | ProposalCreateInput;
  }): Promise<{ ok: true; proposal: MissionControlProposal } | { ok: false; error: string }> => {
    const { toolName, toolInput, classify, buildProposal } = action;
    if (!isCommanderCaller) {
      return { ok: false, error: `${toolName} requires a Commander caller` };
    }
    if (!missionControlService) {
      return { ok: false, error: "Mission Control is not enabled on this host" };
    }
    try {
      const proposalInput = await buildProposal(toolInput);
      const proposal = await missionControlService.approvals.createProposal({
        ...proposalInput,
        // The tool's destructive classification (when it declares one) is
        // authoritative; otherwise the builder's classification stands.
        classification: classify?.(toolInput) ?? proposalInput.classification ?? "normal",
      });
      return { ok: true, proposal };
    } catch (error) {
      childLogger.warn(
        { err: error, component: "approvals", tool: toolName },
        "mission_control.commander_gated_action_failed",
      );
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const parseToolInput = async (tool: PaseoToolDefinition, input: unknown): Promise<unknown> => {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
      return input;
    }
    const schema =
      typeof inputSchema === "object" &&
      inputSchema !== null &&
      typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape).passthrough();
    return schema.parseAsync(input);
  };

  // Provider rejections on the spawn tools are dead ends unless the error
  // teaches the fix: the rejection classes below carry nothing about what a
  // VALID provider string looks like on the target host. Both the schema
  // rejection ("provider must be provider/model, for example codex/gpt-5.4")
  // and the runtime "Provider X is not configured" rejection get augmented
  // with the host, the rejected value, and capped invocable alternatives so a
  // single corrected retry is possible from the error text alone.
  const PROVIDER_SPAWN_TOOLS = new Set(["create_agent", "fleet_create_agent"]);
  const PROVIDER_REJECTION_PATTERNS = [
    /not configured/i,
    /provider must be provider\/model/i,
    /provider must be <provider>\/<model>/i,
  ];

  const toolErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "issues" in error &&
      Array.isArray((error as { issues?: unknown }).issues)
    ) {
      const messages = (error as { issues: Array<{ message?: unknown }> }).issues
        .map((issue) => (typeof issue.message === "string" ? issue.message : ""))
        .filter((message) => message.length > 0);
      if (messages.length > 0) {
        return messages.join("; ");
      }
    }
    return String(error);
  };

  const isProviderRejection = (message: string): boolean =>
    PROVIDER_REJECTION_PATTERNS.some((pattern) => pattern.test(message));

  const providerArg = (input: unknown): string | null => {
    const provider = (input as { provider?: unknown } | null)?.provider;
    return typeof provider === "string" && provider.trim() ? provider.trim() : null;
  };

  const hostArg = (input: unknown): string | null => {
    const host = (input as { host?: unknown } | null)?.host;
    return typeof host === "string" && host.trim() ? host.trim() : null;
  };

  const collectHostInvocableModels = async (host: string): Promise<string[]> => {
    try {
      let entries: Array<{ provider: string; models?: Array<{ id?: string | null }> }>;
      if (isFleetLocalTarget(host)) {
        // wait:false — never warm up providers (spawning binaries) on an
        // error path; the snapshot is advisory for the correction hint.
        entries = await providerSnapshotManager.listProviders({ wait: false });
      } else {
        const client = peerManager?.getPeerClient(host);
        if (!client) {
          return [];
        }
        const snapshot = await client.getProvidersSnapshot();
        entries = snapshot.entries ?? [];
      }
      const strings: string[] = [];
      for (const entry of entries) {
        for (const model of entry.models ?? []) {
          if (model.id) {
            strings.push(`${entry.provider}/${model.id}`);
          }
        }
      }
      return strings;
    } catch {
      // Augmentation is best-effort: never mask the original rejection.
      return [];
    }
  };

  const providerMatchScore = (rejected: string, candidate: string): number => {
    let score = 0;
    const rejectedProvider = rejected.split("/")[0];
    const candidateProvider = candidate.split("/")[0];
    if (rejectedProvider && candidateProvider && rejectedProvider === candidateProvider) {
      score += 100;
    }
    if (candidate.includes(rejected) || rejected.includes(candidate)) {
      score += 50;
    }
    let shared = 0;
    const limit = Math.min(rejected.length, candidate.length);
    while (shared < limit && rejected[shared] === candidate[shared]) {
      shared += 1;
    }
    return score + shared;
  };

  const formatProviderSuggestions = (rejected: string, valid: readonly string[]): string => {
    if (valid.length === 0) {
      return "No provider/model strings are currently available on this host.";
    }
    const scored = valid
      .map((candidate, index) => ({
        candidate,
        index,
        score: providerMatchScore(rejected, candidate),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const shown = scored.slice(0, 5).map((entry) => `- ${entry.candidate}`);
    const hidden = valid.length - shown.length;
    if (hidden > 0) {
      shown.push(`- ... and ${hidden} more (${valid.length} invocable strings on this host)`);
    }
    return shown.join("\n");
  };

  const buildActionableSpawnError = async (params: {
    toolName: string;
    input: unknown;
    original: unknown;
  }): Promise<Error> => {
    const provider = providerArg(params.input);
    const host = hostArg(params.input) ?? "local";
    const valid = await collectHostInvocableModels(host);
    const message = toolErrorMessage(params.original);
    const lines = [
      `${params.toolName} rejected provider "${provider ?? "(missing)"}" on host ${host}: ${message}`,
      "",
      `Valid invocable provider/model strings on ${host} (exactly what create_agent/fleet_create_agent accept):`,
      formatProviderSuggestions(provider ?? "", valid),
    ];
    return new Error(lines.join("\n"));
  };

  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => {
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      try {
        const parsed = await parseToolInput(tool, input);
        return await tool.handler(parsed, context);
      } catch (error) {
        if (PROVIDER_SPAWN_TOOLS.has(name) && isProviderRejection(toolErrorMessage(error))) {
          throw await buildActionableSpawnError({ toolName: name, input, original: error });
        }
        throw error;
      }
    },
  });

  const buildCronScheduleCadence = (input: {
    cron: string | undefined;
    timezone?: string;
  }): ScheduleCadence => {
    const expression = input.cron?.trim() ?? "";
    if (!expression) {
      throw new Error("cron is required");
    }
    const timezone = normalizeScheduleTimeZoneArg(input.timezone);
    return {
      type: "cron",
      expression,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

  const buildScheduleExpiry = (expiresIn: string | undefined): string | undefined => {
    return expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
  };

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };

  const resolveInheritedProviderConfig = (
    selectedProvider: string,
  ): Pick<AgentSessionConfig, "providerOptions"> | undefined => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.provider !== selectedProvider || !callerAgent.config?.providerOptions) {
      return undefined;
    }
    return { providerOptions: callerAgent.config.providerOptions };
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new Error("cwd is required");
      }
      throw new Error("cwd is required outside an agent-scoped session");
    }

    return expandUserPath(trimmedCwd);
  };

  async function resolveTerminalWorkspaceId(resolvedCwd: string): Promise<string> {
    // An agent-spawned terminal belongs to the caller agent's workspace. Only if
    // the caller has no workspace do we mint one for the cwd.
    const callerAgent = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (callerAgent?.workspaceId) {
      return callerAgent.workspaceId;
    }

    if (!options.ensureWorkspaceForCreate) {
      throw new Error(
        callerAgentId
          ? `Caller agent ${callerAgentId} has no workspace and workspace minting is not configured`
          : "workspaceId is required outside an agent-scoped session",
      );
    }

    return options.ensureWorkspaceForCreate(resolvedCwd);
  }

  function resolveWorkspaceIdForRename(requestedWorkspaceId?: string): string {
    const explicitWorkspaceId = requestedWorkspaceId?.trim();
    if (explicitWorkspaceId) {
      return explicitWorkspaceId;
    }

    if (callerAgentId) {
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return callerAgent.workspaceId;
    }
    throw new Error("workspaceId is required outside an agent-scoped session");
  }

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    resolvedProvider: string,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.provider === resolvedProvider && callerAgent.config.providerOptions
        ? { providerOptions: callerAgent.config.providerOptions }
        : {}),
      ...(callerAgent.config.featureValues
        ? { featureValues: callerAgent.config.featureValues }
        : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId && callerAgent.provider === resolvedProvider
        ? {
            modeId: callerAgent.currentModeId,
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent, resolvedProvider),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: {
    provider?: string;
    cwd?: string;
    isolation?: "local" | "worktree";
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
        },
      };
    }

    if (!params?.provider?.trim()) {
      throw new Error("provider is required when target is new-agent");
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(params?.isolation ? { isolation: params.isolation } : {}),
      },
    };
  };

  async function requireScheduleTarget(id: string, type: "agent" | "new-agent") {
    if (!scheduleService) {
      throw new Error("Schedule service is not configured");
    }
    const schedule = await scheduleService.inspect(id);
    if (schedule.target.type !== type) {
      throw new Error(
        type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`,
      );
    }
    return schedule;
  }

  async function requireCallerHeartbeat(id: string) {
    if (!callerAgentId) {
      throw new Error("Heartbeat operations require an agent-scoped session");
    }
    const schedule = await requireScheduleTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgentId) {
      throw new Error(`Heartbeat ${id} does not belong to caller ${callerAgentId}`);
    }
    return schedule;
  }
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const ProviderOrProviderModelInputSchema = AgentProviderEnum.trim()
    .min(1, "provider is required")
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider or provider/model, for example codex/gpt-5.4" },
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      thinkingOptionId: z.string().optional().describe("Thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const UpdateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode ID."),
      model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
      thinkingOptionId: z
        .string()
        .nullable()
        .optional()
        .describe("Thinking option ID. Pass null to clear."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const InspectProviderSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Draft session mode ID."),
      model: z.string().optional().describe("Draft model ID."),
      thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Draft provider feature values."),
    })
    .strict();
  const AgentRelationshipInputSchema = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("subagent") })
      .strict()
      .describe("Create a child agent under this agent's subagent track."),
    z
      .object({ kind: z.literal("detached") })
      .strict()
      .describe("Create a root agent that does not appear in this agent's subagent track."),
  ]);
  const AgentCreateWorktreeTargetInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("branch-off"),
        worktreeSlug: z
          .string()
          .min(1)
          .optional()
          .describe("Optional worktree slug/path label. Omit to let Paseo generate one."),
        branchName: z
          .string()
          .min(1)
          .optional()
          .describe("Optional git branch name. Defaults to the worktree slug."),
        baseBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional base branch. Defaults to the repository default branch."),
      })
      .strict()
      .describe("Create a new branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-branch"),
        branch: z.string().min(1).describe("Existing branch to check out."),
      })
      .strict()
      .describe("Check out an existing branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-pr"),
        githubPrNumber: z.number().int().positive().describe("GitHub pull request number."),
      })
      .strict()
      .describe("Check out a GitHub pull request in a new Paseo worktree."),
  ]);
  const AgentWorkspaceInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("current"),
        cwd: z.string().optional().describe("Optional runtime cwd. Defaults to the caller's cwd."),
      })
      .strict()
      .describe("Use the caller's current workspace."),
    z
      .object({
        kind: z.literal("existing"),
        workspaceId: z.string().min(1).describe("Existing workspace id to attach the agent to."),
        cwd: z
          .string()
          .optional()
          .describe("Optional runtime cwd. Defaults to the existing workspace cwd."),
      })
      .strict()
      .describe("Attach the agent to an existing workspace."),
    z
      .object({
        kind: z.literal("create"),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("directory"),
              path: z
                .string()
                .optional()
                .describe("Optional directory path. Defaults to the caller's cwd."),
            })
            .strict(),
          z
            .object({
              kind: z.literal("worktree"),
              cwd: z
                .string()
                .optional()
                .describe("Optional source repository. Defaults to the caller's cwd."),
              target: AgentCreateWorktreeTargetInputSchema,
            })
            .strict(),
        ]),
      })
      .strict()
      .describe("Create a new workspace for the agent."),
  ]);
  const commonCreateAgentFields = {
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.describe(
      "Required provider/model pair, for example codex/gpt-5.4.",
    ),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
  };
  const legacyCreateAgentPlacementFields = {
    relationship: AgentRelationshipInputSchema.describe(
      "Whether the created agent is a subagent under you or a detached root agent.",
    ),
    workspace: AgentWorkspaceInputSchema.describe(
      "Workspace ownership/location for the created agent.",
    ),
  };
  const canonicalCreateAgentFields = {
    ...commonCreateAgentFields,
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing workspace id. Agent-scoped calls default to the caller workspace; top-level calls create a new local workspace when omitted.",
      ),
  };
  const agentToAgentInputSchema = {
    ...canonicalCreateAgentFields,
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the created agent finishes, errors, or needs permission. Set false only for truly fire-and-forget agents.",
      ),
  };
  const canonicalTopLevelInputSchema = {
    ...canonicalCreateAgentFields,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the created agent finishes, errors, or needs permission.",
      ),
  };
  const legacyAgentToAgentInputSchema = {
    ...commonCreateAgentFields,
    ...legacyCreateAgentPlacementFields,
    notifyOnFinish: agentToAgentInputSchema.notifyOnFinish,
  };
  const legacyTopLevelCreateAgentInputSchema = {
    ...commonCreateAgentFields,
    relationship: legacyCreateAgentPlacementFields.relationship.optional(),
    workspace: legacyCreateAgentPlacementFields.workspace.optional(),
    background: canonicalTopLevelInputSchema.background,
    notifyOnFinish: canonicalTopLevelInputSchema.notifyOnFinish,
    cwd: z
      .string()
      .optional()
      .describe("Legacy top-level working directory. Prefer workspace.source.path."),
    mode: z.string().optional().describe("Legacy session mode ID. Prefer settings.modeId."),
    thinking: z
      .string()
      .optional()
      .describe("Legacy thinking option ID. Prefer settings.thinkingOptionId."),
    features: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Legacy feature values. Prefer settings.features."),
    worktreeName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy worktree slug. Prefer workspace.source.target.worktreeSlug."),
    branchName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch name. Prefer workspace.source.target.branchName."),
    baseBranch: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy base branch. Prefer workspace.source.target.baseBranch."),
    refName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch/ref to check out. Prefer workspace.source.target.branch."),
    githubPrNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Legacy GitHub PR number. Prefer workspace.source.target.githubPrNumber."),
  };
  const createAgentInputSchema = z
    .object(callerAgentId ? agentToAgentInputSchema : canonicalTopLevelInputSchema)
    .passthrough();
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const legacyAgentToAgentCreateAgentArgsSchema = z.object(legacyAgentToAgentInputSchema).strict();
  const canonicalTopLevelCreateAgentArgsSchema = z.object(canonicalTopLevelInputSchema).strict();
  const legacyTopLevelCreateAgentArgsSchema = z
    .object(legacyTopLevelCreateAgentInputSchema)
    .strict();
  const commonSendAgentPromptInputSchema = {
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run agent in background. Agent-scoped default is true so you can continue until the finish notification arrives. Set false only when you need a blocking response.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Set false only for truly fire-and-forget prompts.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the prompted agent finishes, errors, or needs permission.",
      ),
  };
  const sendAgentPromptInputSchema = callerAgentId
    ? agentToAgentSendAgentPromptInputSchema
    : topLevelSendAgentPromptInputSchema;
  const inspectProviderInputSchema = {
    provider: ProviderOrProviderModelInputSchema.describe(
      "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
    ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory used to resolve provider feature availability."),
    settings: InspectProviderSettingsInputSchema.optional().describe(
      "Draft provider settings used to compute available features.",
    ),
  };
  type AgentToAgentCreateAgentArgs = z.infer<typeof agentToAgentCreateAgentArgsSchema>;
  type LegacyAgentToAgentCreateAgentArgs = z.infer<typeof legacyAgentToAgentCreateAgentArgsSchema>;
  type TopLevelCreateAgentArgs = z.infer<typeof canonicalTopLevelCreateAgentArgsSchema>;
  type LegacyTopLevelCreateAgentArgs = z.infer<typeof legacyTopLevelCreateAgentArgsSchema>;

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context) => {
        if (!callerAgentId) {
          throw new Error("speak is only available to agent-scoped tool sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new Error(`No speak handler registered for your session '${callerAgentId}'`);
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return toCatalog();
  }

  if (options.browserToolsEnabled && options.browserToolsBroker) {
    registerBrowserTools({
      registerTool,
      broker: options.browserToolsBroker,
      callerAgentId,
      resolveCallerAgent,
    });
  }

  registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
      inputSchema: {
        isolation: z.enum(["local", "worktree"]),
        path: z
          .string()
          .optional()
          .describe("Local directory or source checkout. Defaults to your current workspace."),
        projectId: z.string().optional().describe("Existing project id to own the workspace."),
        title: z.string().trim().min(1).optional(),
        mode: z
          .enum(["branch-off", "checkout-branch", "checkout-pr"])
          .optional()
          .describe("Worktree creation mode. Defaults to branch-off."),
        worktreeSlug: z.string().trim().min(1).optional(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New branch name for branch-off mode."),
        baseBranch: z.string().trim().min(1).optional().describe("Base ref for branch-off mode."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing branch for checkout-branch mode."),
        prNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request or change request number for checkout-pr mode."),
        forge: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Forge for checkout-pr mode. Defaults to the source checkout."),
      },
      outputSchema: WorkspaceAutomationSummarySchema.shape,
    },
    async ({
      isolation,
      path,
      projectId,
      title,
      mode,
      worktreeSlug,
      branchName,
      baseBranch,
      branch,
      prNumber,
      forge,
    }) => {
      let workspace: PersistedWorkspaceRecord;
      if (isolation === "local") {
        const cwd = resolveScopedCwd(path, { required: true });
        assertOptionsAbsent(
          [
            ["mode", mode],
            ["worktreeSlug", worktreeSlug],
            ["branchName", branchName],
            ["baseBranch", baseBranch],
            ["branch", branch],
            ["prNumber", prNumber],
            ["forge", forge],
          ],
          "Worktree options require isolation worktree",
        );
        if (!options.createDirectoryWorkspace) {
          throw new Error("Workspace provisioning is not configured");
        }
        workspace = await options.createDirectoryWorkspace(cwd, title, projectId);
      } else {
        let cwd =
          path !== undefined || !projectId ? resolveScopedCwd(path, { required: true }) : null;
        if (!cwd) {
          if (!options.projectRegistry) {
            throw new Error("Project registry is not configured");
          }
          cwd = await resolveWorktreeSourceCwd({ projectId }, options.projectRegistry);
        }
        const worktreeTarget = resolveWorkspaceWorktreeTarget({
          mode,
          worktreeSlug,
          branchName,
          baseBranch,
          branch,
          prNumber,
          forge,
        });
        const result = await createPaseoWorktreeCommand(
          {
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            createPaseoWorktreeWorkflow: options.createPaseoWorktree,
          },
          {
            cwd,
            ...(projectId ? { projectId } : {}),
            ...(worktreeSlug ? { worktreeSlug } : {}),
            ...worktreeTarget,
            ...(title ? { title } : {}),
          },
        );
        if (!result.ok) {
          throw result.cause;
        }
        workspace = result.createdWorktree.workspace;
      }

      return {
        content: [],
        structuredContent: ensureValidJson(toWorkspaceAutomationSummary(workspace)),
      };
    },
  );

  registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List active workspaces.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(WorkspaceAutomationSummarySchema) },
    },
    async () => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspaces = (await options.workspaceRegistry.list())
        .filter((workspace) => !workspace.archivedAt)
        .map(toWorkspaceAutomationSummary);
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaces }),
      };
    },
  );

  registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: {
        workspaceId: z.string(),
        archivedAgentIds: z.array(z.string()),
        removedDirectory: z.boolean(),
      },
    },
    async ({ workspaceId }) => {
      if (!options.listActiveWorkspaces) {
        throw new Error("Active workspace lister is required to archive workspaces");
      }
      const workspace = await requireActiveWorkspaceForArchive(
        { listActiveWorkspaces: options.listActiveWorkspaces },
        workspaceId,
      );
      const result = await archiveByScope(
        archiveWorktreeDependencies(options, {
          agentManager,
          agentStorage,
          terminalManager: terminalManager ?? null,
          logger: childLogger,
        }),
        {
          requestId: "mcp:archive_workspace",
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          workspaceId,
          archivedAgentIds: result.archivedAgentIds,
          removedDirectory: result.removedDirectory,
        }),
      };
    },
  );

  registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. Agent-scoped creation defaults to your workspace and creates your subagent. Top-level creation without workspaceId creates a new local workspace. Requires provider/model (for example codex/gpt-5.4) and an initial prompt. Do not guess; call list_providers and list_models first if uncertain.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async (args: unknown) => {
      const resolvedArgs = await resolveCreateAgentToolArgs(args);
      const { parsedArgs, worktree } = resolvedArgs;
      let requestedBackground: boolean;
      let notifyOnFinish: boolean;
      if (resolvedArgs.kind === "agent-scoped") {
        requestedBackground = true;
        notifyOnFinish = parsedArgs.notifyOnFinish;
      } else {
        requestedBackground = resolvedArgs.parsedArgs.background;
        notifyOnFinish = resolvedArgs.parsedArgs.notifyOnFinish ?? false;
      }
      const selectedProvider = resolveRequiredProviderModel(parsedArgs.provider).provider;
      const inheritedConfig = resolveInheritedProviderConfig(selectedProvider);
      const {
        snapshot,
        background: createdInBackground,
        initialPromptStarted,
      } = await createAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
          paseoHome: options.paseoHome,
          worktreesRoot: options.worktreesRoot,
          terminalManager,
          providerSnapshotManager,
          createPaseoWorktree: options.createPaseoWorktree,
          ...(options.ensureWorkspaceForCreate
            ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
            : {}),
        },
        {
          kind: "mcp",
          provider: parsedArgs.provider,
          title: parsedArgs.title,
          initialPrompt: parsedArgs.initialPrompt,
          config: inheritedConfig,
          cwd: resolvedArgs.cwd,
          workspaceId: resolvedArgs.workspaceId,
          thinking: parsedArgs.settings?.thinkingOptionId,
          features: parsedArgs.settings?.features,
          labels: parsedArgs.labels,
          mode: parsedArgs.settings?.modeId,
          background: requestedBackground,
          notifyOnFinish,
          detached: resolvedArgs.detached,
          callerAgentId,
          callerContext,
          worktree,
        },
      );

      try {
        if (!createdInBackground && initialPromptStarted) {
          const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
            waitForActive: true,
          });

          const liveSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
          const responseData = {
            agentId: snapshot.id,
            type: snapshot.provider,
            status: result.status,
            cwd: liveSnapshot.cwd,
            ...(liveSnapshot.workspaceId ? { workspaceId: liveSnapshot.workspaceId } : {}),
            currentModeId: liveSnapshot.currentModeId,
            availableModes: liveSnapshot.availableModes,
            lastMessage: result.lastMessage,
            permission: sanitizePermissionRequest(result.permission),
          };
          const validJson = ensureValidJson(responseData);

          const response = {
            content: [],
            structuredContent: validJson,
          };
          return response;
        }
      } catch (error) {
        childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
        throw error;
      }

      // Return immediately for async creation.
      const currentSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
      const guidance =
        callerAgentId && notifyOnFinish && initialPromptStarted
          ? "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives."
          : undefined;
      const response = {
        content: [],
        structuredContent: ensureValidJson({
          agentId: currentSnapshot.id,
          type: snapshot.provider,
          status: currentSnapshot.lifecycle,
          cwd: currentSnapshot.cwd,
          ...(currentSnapshot.workspaceId ? { workspaceId: currentSnapshot.workspaceId } : {}),
          currentModeId: currentSnapshot.currentModeId,
          availableModes: currentSnapshot.availableModes,
          lastMessage: null,
          permission: null,
          ...(guidance ? { guidance } : {}),
        }),
      };
      return response;
    },
  );

  type ResolvedCreateAgentToolArgs =
    | {
        kind: "agent-scoped";
        parsedArgs: AgentToAgentCreateAgentArgs | LegacyAgentToAgentCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      }
    | {
        kind: "top-level";
        parsedArgs: TopLevelCreateAgentArgs | LegacyTopLevelCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      };

  async function resolveCreateAgentToolArgs(args: unknown): Promise<ResolvedCreateAgentToolArgs> {
    if (callerAgentId) {
      if (hasLegacyCreateAgentPlacement(args)) {
        // COMPAT(nestedCreateAgentPlacement): accept the old relationship/workspace shape without
        // advertising it to models. Added in v0.2.0; remove after 2027-01-17.
        const parsed = legacyAgentToAgentCreateAgentArgsSchema.parse(args);
        const { cwd, workspaceId, worktree } = await resolveCreateAgentWorkspace(parsed.workspace, {
          prompt: parsed.initialPrompt,
        });
        return {
          kind: "agent-scoped",
          parsedArgs: parsed,
          detached: parsed.relationship.kind === "detached",
          cwd,
          workspaceId,
          worktree,
        };
      }
      const parsed = agentToAgentCreateAgentArgsSchema.parse(args);
      const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(parsed.workspaceId, {
        prompt: parsed.initialPrompt,
      });
      return {
        kind: "agent-scoped",
        parsedArgs: parsed,
        detached: false,
        cwd,
        workspaceId,
        worktree: undefined,
      };
    }
    if (hasLegacyCreateAgentPlacement(args)) {
      // COMPAT(nestedCreateAgentPlacement): see the agent-scoped branch above.
      const parsedArgs = normalizeTopLevelCreateAgentArgs(
        legacyTopLevelCreateAgentArgsSchema.parse(args),
      );
      if (parsedArgs.relationship?.kind === "subagent") {
        throw new Error("relationship subagent requires an agent-scoped tool session");
      }
      if (!parsedArgs.workspace) {
        throw new Error("Legacy create_agent placement could not be resolved");
      }
      const { cwd, workspaceId, worktree } = await resolveCreateAgentWorkspace(
        parsedArgs.workspace,
        { prompt: parsedArgs.initialPrompt },
      );
      return {
        kind: "top-level",
        parsedArgs,
        detached: true,
        cwd,
        workspaceId,
        worktree,
      };
    }
    const parsedArgs = canonicalTopLevelCreateAgentArgsSchema.parse(args);
    const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(
      parsedArgs.workspaceId,
      { prompt: parsedArgs.initialPrompt },
    );
    return {
      kind: "top-level",
      parsedArgs,
      detached: false,
      cwd,
      workspaceId,
      worktree: undefined,
    };
  }

  function hasLegacyCreateAgentPlacement(args: unknown): boolean {
    if (!args || typeof args !== "object") {
      return false;
    }
    const input = args as Record<string, unknown>;
    return [
      "relationship",
      "workspace",
      "cwd",
      "worktreeName",
      "branchName",
      "baseBranch",
      "refName",
      "githubPrNumber",
    ].some((key) => input[key] !== undefined);
  }

  async function resolveCanonicalCreateAgentWorkspace(
    workspaceId?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string;
  }> {
    if (workspaceId) {
      const resolved = await resolveCreateAgentWorkspace(
        { kind: "existing", workspaceId },
        undefined,
      );
      return { cwd: resolved.cwd, workspaceId };
    }
    if (!callerAgentId) {
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const cwd = process.cwd();
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(cwd, firstAgentContext),
      };
    }
    const caller = resolveCallerAgent();
    if (!caller?.workspaceId) {
      throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
    }
    return { cwd: undefined, workspaceId: caller.workspaceId };
  }

  function normalizeTopLevelCreateAgentArgs(
    args: LegacyTopLevelCreateAgentArgs,
  ): LegacyTopLevelCreateAgentArgs {
    const {
      cwd,
      mode,
      thinking,
      features,
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
      ...canonicalCandidate
    } = args;
    const settings = {
      ...canonicalCandidate.settings,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(features ? { features } : {}),
    };

    if (canonicalCandidate.relationship && canonicalCandidate.workspace) {
      return legacyTopLevelCreateAgentArgsSchema.parse({
        ...canonicalCandidate,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
    }

    if (canonicalCandidate.relationship || canonicalCandidate.workspace) {
      throw new Error("relationship and workspace must be provided together");
    }

    if (!cwd?.trim()) {
      throw new Error("cwd is required for legacy top-level create_agent calls");
    }

    const legacyWorktreeTarget = resolveLegacyCreateAgentWorktreeTarget({
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
    });
    const workspace = legacyWorktreeTarget
      ? {
          kind: "create" as const,
          source: {
            kind: "worktree" as const,
            cwd,
            target: legacyWorktreeTarget,
          },
        }
      : {
          kind: "create" as const,
          source: {
            kind: "directory" as const,
            path: cwd,
          },
        };

    return legacyTopLevelCreateAgentArgsSchema.parse({
      ...canonicalCandidate,
      relationship: { kind: "detached" },
      workspace,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  function resolveLegacyCreateAgentWorktreeTarget(input: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    githubPrNumber?: number;
  }): z.infer<typeof AgentCreateWorktreeTargetInputSchema> | null {
    if (input.githubPrNumber !== undefined) {
      return {
        kind: "checkout-pr",
        githubPrNumber: input.githubPrNumber,
      };
    }

    if (input.refName) {
      return {
        kind: "checkout-branch",
        branch: input.refName,
      };
    }

    if (input.worktreeName || input.branchName || input.baseBranch) {
      return {
        kind: "branch-off",
        worktreeSlug: input.worktreeName,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
      };
    }

    return null;
  }

  async function resolveCreateAgentWorkspace(
    workspace:
      | LegacyAgentToAgentCreateAgentArgs["workspace"]
      | NonNullable<LegacyTopLevelCreateAgentArgs["workspace"]>,
    firstAgentContext: FirstAgentContext | undefined,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
    worktree: CreateAgentFromMcpInput["worktree"];
  }> {
    if (workspace.kind === "current") {
      if (!callerAgentId) {
        throw new Error("workspace current requires an agent-scoped tool session");
      }
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return {
        cwd: workspace.cwd,
        workspaceId: callerAgent.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.kind === "existing") {
      if (!options.listActiveWorkspaces) {
        throw new Error("Workspace lookup is not configured");
      }
      const existingWorkspace = (await options.listActiveWorkspaces()).find(
        (candidate) => candidate.workspaceId === workspace.workspaceId,
      );
      if (!existingWorkspace) {
        throw new Error(`Workspace ${workspace.workspaceId} not found`);
      }
      const cwd = workspace.cwd
        ? resolveScopedCwd(workspace.cwd, { required: true })
        : existingWorkspace.cwd;
      const lockedCwd = callerContext?.lockedCwd?.trim();
      if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), cwd)) {
        throw new Error(`Workspace ${workspace.workspaceId} is outside the allowed cwd`);
      }
      return {
        cwd,
        workspaceId: workspace.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.source.kind === "directory") {
      const cwd = resolveScopedCwd(workspace.source.path, { required: true });
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(cwd, firstAgentContext),
        worktree: undefined,
      };
    }

    const cwd = resolveScopedCwd(workspace.source.cwd, { required: true });
    return {
      cwd,
      workspaceId: undefined,
      worktree: resolveCreateAgentWorktree(workspace.source.target),
    };
  }

  function resolveCreateAgentWorktree(
    target: z.infer<typeof AgentCreateWorktreeTargetInputSchema>,
  ): NonNullable<CreateAgentFromMcpInput["worktree"]> {
    switch (target.kind) {
      case "branch-off":
        return {
          action: "branch-off",
          worktreeName: target.worktreeSlug,
          branchName: target.branchName,
          baseBranch: target.baseBranch,
        };
      case "checkout-branch":
        return {
          action: "checkout",
          refName: target.branch,
        };
      case "checkout-pr":
        return {
          action: "checkout",
          githubPrNumber: target.githubPrNumber,
        };
      default:
        throw new Error("unreachable");
    }
  }

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Agent-scoped callers run in background by default; top-level callers wait by default.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async ({
      agentId,
      prompt,
      sessionMode,
      background = Boolean(callerAgentId),
      notifyOnFinish = Boolean(callerAgentId),
    }) => {
      const shouldNotifyOnFinish = Boolean(callerAgentId && notifyOnFinish && background);

      // Agent-originated (Commander/Verifier/worker) sends that supersede a
      // busy run are machinery-originated: the superseded run keeps the
      // failure treatment, never reads as a user interruption.
      if (agentManager.hasInFlightRun(agentId)) {
        missionControlService?.recordStopOrigin(agentId, "machinery");
      }
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        replaceOrigin: "machinery",
        sessionMode,
        logger: childLogger,
      });

      if (shouldNotifyOnFinish && callerAgentId) {
        setupFinishNotification({
          agentManager,
          agentStorage,
          childAgentId: agentId,
          callerAgentId,
          logger: childLogger,
        });
      }

      // If not running in background, wait for completion
      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }

      // Return immediately if background=true
      // Re-fetch snapshot since the state may have changed
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
        ...(shouldNotifyOnFinish
          ? {
              guidance:
                "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
            }
          : {}),
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
    },
  );

  registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        const structuredSnapshot = await serializeSnapshotWithMetadata(
          agentStorage,
          snapshot,
          childLogger,
        );
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = buildStoredAgentPayload(
        record,
        new Set(agentManager.getRegisteredProviderIds()),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
        }),
      };
    },
  );

  registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents as compact metadata.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async ({ includeArchived = false, cwd, sinceHours = 48, statuses, limit = 50 }) => {
      const callerCwd = callerAgentId ? resolveCallerAgent()?.cwd : undefined;
      const requestedCwd = cwd?.trim() ? expandUserPath(cwd) : callerCwd;
      const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const liveSnapshots = agentManager.listAgents();
      const liveAgents = await Promise.all(
        liveSnapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger),
        ),
      );
      const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
      const storedRecords = await agentStorage.list();
      const registeredProviderIds = new Set(agentManager.getRegisteredProviderIds());
      const storedAgents = storedRecords
        .filter((record) => !record.internal && !liveIds.has(record.id))
        .filter((record) => includeArchived || !record.archivedAt)
        .filter(
          (record) =>
            includeArchived || isStoredAgentProviderAvailable(record, registeredProviderIds),
        )
        .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
      const agents = [...liveAgents, ...storedAgents]
        .map(toAgentListItemPayload)
        .filter((agent) => !requestedCwd || isSameOrDescendantPath(requestedCwd, agent.cwd))
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !agent.archivedAt || resolveAgentListActivityTime(agent) >= sinceMs)
        .sort(compareAgentListItems)
        .slice(0, limit);

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const { cancelled } = await cancelAgentRunCommand(
        { agentManager, agentStorage, logger: childLogger },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: cancelled }),
      };
    },
  );

  registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await archiveAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
        },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await closeAgentCommand({ agentManager }, agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: UpdateAgentSettingsInputSchema.optional().describe(
          "Runtime settings to apply to the agent.",
        ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels, settings }) => {
      if (settings?.modeId !== undefined) {
        await agentManager.setAgentMode(agentId, settings.modeId);
      }
      if (settings?.model !== undefined) {
        await agentManager.setAgentModel(agentId, settings.model);
      }
      if (settings?.thinkingOptionId !== undefined) {
        await agentManager.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      if (settings?.features) {
        for (const [featureId, value] of Object.entries(settings.features)) {
          await agentManager.setAgentFeature(agentId, featureId, value);
        }
      }

      await updateAgentCommand({ agentManager }, { agentId, name, labels });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description:
        "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Workspace id to rename. Omit to rename your current workspace."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
      outputSchema: {
        success: z.boolean(),
        workspaceId: z.string(),
        title: z.string(),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, title }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is required to rename workspaces");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to rename workspaces");
      }

      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      const existing = await options.workspaceRegistry.get(workspaceId);
      if (!existing) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      if (existing.archivedAt) {
        throw new Error(`Workspace ${workspaceId} is archived`);
      }

      await options.workspaceRegistry.upsert({
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });
      await options.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          workspaceId,
          title,
        }),
      };
    },
  );

  registerTool(
    "list_workspace_scripts",
    {
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
      outputSchema: {
        scripts: z.array(WorkspaceScriptPayloadSchema),
      },
    },
    async ({ workspaceId }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ scripts: await workspaceScripts.list(workspaceId) }),
      };
    },
  );

  registerTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.launch({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.stop({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: "Create a terminal session for a working directory.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const workspaceId = await resolveTerminalWorkspaceId(resolvedCwd);

      const terminal = await terminalManager.createTerminal({
        cwd: resolvedCwd,
        workspaceId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      if (!terminalManager.getTerminal(terminalId)) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description: "Send literal text or special key tokens to a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken(keys, literal),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that starts a new agent on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        provider: (callerAgentId ? AgentProviderEnum.optional() : AgentProviderEnum).describe(
          "Provider, or provider/model (for example: codex or codex/gpt-5.4). Defaults to the caller's provider in an agent-scoped session.",
        ),
        cwd: z.string().optional(),
        isolation: z.enum(["local", "worktree"]).optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, provider, cwd, isolation, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: resolveNewAgentScheduleTarget({ provider, cwd, isolation }),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "create_heartbeat",
    {
      title: "Create heartbeat",
      description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      if (!callerAgentId) {
        throw new Error("create_heartbeat requires an agent-scoped session");
      }
      resolveCallerAgent();

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: { type: "agent", agentId: callerAgentId },
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "delete_heartbeat",
    {
      title: "Delete heartbeat",
      description: "Delete one of your heartbeats.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: { success: z.boolean() },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireCallerHeartbeat(id);
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list())
        .filter((schedule) => schedule.target.type === "new-agent")
        .map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await requireScheduleTarget(id, "new-agent");
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: z
        .object({
          id: z.string(),
          cron: z.string().optional().describe("New cron expression."),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for cron cadence; requires cron. For example: America/New_York.",
            ),
          name: z.string().nullable().optional().describe("New name (null to clear)."),
          prompt: z.string().trim().min(1).optional().describe("New prompt text."),
          maxRuns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("New max runs limit (null to clear)."),
          provider: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("New provider for new-agent target."),
          model: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New model for new-agent target (null to clear)."),
          mode: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New mode for new-agent target (null to clear)."),
          cwd: z.string().trim().min(1).optional().describe("New cwd for new-agent target."),
          expiresIn: z
            .string()
            .optional()
            .describe("New relative expiry duration (for example: 1h, 2d)."),
          clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
        })
        .passthrough(),
      outputSchema: StoredScheduleSchema.shape,
    },
    async (input) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(input.id, "new-agent");
      const schedule = await scheduleService.update(buildScheduleUpdateInput(input));

      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "schedule_logs",
    {
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        runs: z.array(ScheduleRunSchema),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      const runs = await scheduleService.logs(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ runs }),
      };
    },
  );

  registerTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately without changing its cron cadence.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireScheduleTarget(id, "new-agent");
      const schedule = await scheduleService.runOnce(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = (await providerSnapshotManager.listProviders({ wait: true })).map(
        toProviderSummary,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  registerTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      const models = await providerSnapshotManager.listModels({
        provider,
        wait: true,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  registerTool(
    "list_profiles",
    {
      title: "List agent profiles",
      description:
        "List agent profiles: named provider/model/mode bundles a human configured for specific " +
        "kinds of work. Read each profile's `notes` to pick the one that fits the task you're " +
        "delegating, then copy its `provider`, `model`, `modeId`, `thinkingOptionId`, and " +
        "`featureValues` into create_agent (there is no `profile` parameter). Returns an empty " +
        "list if none are configured.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(AgentProfileSchema),
      },
    },
    async () => {
      const profiles = daemonConfigStore?.get().agentProfiles ?? [];
      return {
        content: [],
        structuredContent: ensureValidJson({ profiles }),
      };
    },
  );

  registerTool(
    "inspect_provider",
    {
      title: "Inspect provider",
      description:
        "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: inspectProviderInputSchema,
      outputSchema: {
        provider: AgentProviderEnum,
        label: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean(),
        status: z.string(),
        modes: z.array(ProviderModeSchema).nullish(),
        selectedModel: z.string().nullable(),
        features: z.array(AgentFeatureSchema),
      },
    },
    async ({ provider, cwd, settings }) => {
      const resolvedProviderModel = resolveScheduleProviderAndModel({
        provider,
        defaultProvider: provider,
      });
      const providerId = resolvedProviderModel.provider;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const entry = await providerSnapshotManager.getProvider({
        cwd: resolvedCwd,
        provider: providerId,
        wait: true,
      });
      const summary = toProviderSummary(entry);
      if (!entry.enabled) {
        throw new Error(`Provider '${providerId}' is disabled`);
      }
      if (entry.status !== "ready") {
        throw new Error(entry.error ?? `Provider '${providerId}' is unavailable`);
      }
      const selectedModel = settings?.model ?? resolvedProviderModel.model;
      const features = await agentManager.listDraftFeatures({
        provider: providerId,
        cwd: resolvedCwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider: providerId,
          label: summary.label,
          description: summary.description,
          enabled: summary.enabled,
          status: summary.status,
          modes: summary.modes,
          selectedModel: selectedModel ?? null,
          features,
        }),
      };
    },
  );

  registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
        peek: z
          .boolean()
          .optional()
          .describe(
            "When true, read the stored timeline without loading the agent (no provider spawn).",
          ),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit, peek }) => {
      if (peek) {
        const activity = await peekAgentActivity({
          agentId,
          agentManager,
          agentStorage,
          logger: childLogger,
        });
        const summary = curateActivitySummary({ timeline: activity.timeline, limit });
        return {
          content: [],
          structuredContent: ensureValidJson({
            agentId,
            updateCount: summary.updateCount,
            currentModeId: activity.currentModeId,
            content: summary.content,
          }),
        };
      }
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);
      const summary = curateActivitySummary({ timeline, limit });

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: summary.updateCount,
          currentModeId: snapshot?.currentModeId ?? null,
          content: summary.content,
        }),
      };
    },
  );

  registerTool(
    "history_search",
    {
      title: "Search history",
      description:
        "Search stored agents on this daemon by title, name, description, or working directory. " +
        "Every whitespace-separated query token must match at least one of those fields (case-insensitive substring). " +
        "Use for 'have we done X before' questions; check the roster first.",
      inputSchema: {
        query: z.string().min(1),
        sinceHours: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(50).optional().default(20),
      },
      outputSchema: {
        results: z.array(historySearchResultItemSchema),
      },
    },
    async ({ query, sinceHours, limit = 20 }) => {
      const sinceMs = sinceHours !== undefined ? Date.now() - sinceHours * 60 * 60 * 1000 : null;
      const records = await agentStorage.list();
      const candidates = records
        .filter((record) => !record.internal && !hasMissionControlLabels(record.labels))
        .filter((record) => sinceMs === null || Date.parse(record.updatedAt) >= sinceMs)
        .filter((record) => matchesHistorySearch(query, record))
        .slice(0, limit);
      const results: HistorySearchResultItem[] = [];
      for (const record of candidates) {
        const item: HistorySearchResultItem = {
          agentId: record.id,
          cwd: record.cwd,
          status: record.lastStatus,
          updatedAt: record.updatedAt,
        };
        if (record.name !== undefined) {
          item.name = record.name;
        }
        if (record.title !== undefined) {
          item.title = record.title;
        }
        if (record.shortDescription !== undefined) {
          item.description = record.shortDescription;
        }
        if (options.serverId) {
          item.link = `paseo://h/${options.serverId}/agent/${record.id}`;
        }
        results.push(item);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ results }),
      };
    },
  );

  registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      const result = await setAgentModeCommand({ agentManager }, { agentId, modeId });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: result.modeId }),
      };
    },
  );

  registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request: sanitizePermissionRequest(request),
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await respondToAgentPermission({
        agentManager,
        agentId,
        requestId,
        response,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "report_status",
    {
      title: "Report status",
      description:
        "Report status to Mission Control at major steps only: root cause found, a fix landed, tests green, blocked, direction changed, done. " +
        'Silence between milestones; never send progress updates. "completed" means conclusively done — everything asked, finished; any doubt, ' +
        'cut short, or still in discussion: report "inconclusive", never "completed". Completion claims should carry proofs. ' +
        "Prefer hub-wait over sleep/timeout polling loops. Rate limited to one report per minute per agent. " +
        "Optional title/description maintain YOUR identity on the agent record: title is your current main theme, kept stable — retitle only " +
        "when the work's theme genuinely diverges (a decision-kind report, or once at completion); description is a living 2-3 sentence " +
        "'what this agent is doing now', replaced (never appended) whenever it materially changes, under ~400 characters. Send " +
        "title/description only when changing them; omitting them leaves them untouched. The result echoes your stored title/description " +
        "only when they drifted from what you sent (changed externally); otherwise no identity fields are returned.",
      inputSchema: MissionControlReportStatusInputSchema.extend({
        headline: z
          .string()
          .max(120)
          .describe("Plain-language headline, at most 120 characters, no markdown."),
      }),
      outputSchema: {
        ok: z.boolean(),
        eventId: z.string().optional(),
        reason: z.string().optional(),
        error: z.string().optional(),
        // Drift-only identity echo: the agent's stored title and short
        // description (null when never set), present ONLY when they differ
        // from what the agent just sent — someone else changed them. Absent
        // when the agent's own values are already current.
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      },
    },
    async (input) => {
      if (!callerAgentId) {
        throw new Error("report_status requires an agent-scoped session");
      }
      if (!missionControlService) {
        throw new Error("Mission Control is not enabled on this host");
      }
      const result = await missionControlService.reportSelfStatus(callerAgentId, input);
      if (!result.ok) {
        return {
          content: [],
          isError: true,
          structuredContent: ensureValidJson({
            ok: false,
            reason: result.reason,
            error: result.message,
          }),
        };
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          ok: true,
          eventId: result.event.id,
          // Drift-only identity echo: present only when the stored identity
          // differs from what the agent sent (external drift).
          ...(result.identity.title !== undefined ? { title: result.identity.title } : {}),
          ...(result.identity.description !== undefined
            ? { description: result.identity.description }
            : {}),
        }),
      };
    },
  );

  const fleetCreateAgentInputSchema = z
    .object({
      host: z
        .string()
        .min(1)
        .describe(
          "Target host: a peer name from the daemon peers config, or 'local' for this daemon.",
        ),
      ...canonicalTopLevelInputSchema,
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory on the target host. Required when targeting a peer without workspaceId.",
        ),
      respondsTo: z
        .string()
        .optional()
        .describe(
          "M8 instruction ledger: the open instruction id this dispatch answers (e.g. '#12'). The envelope lists open ids; cite one on every card you emit for a user instruction.",
        ),
    })
    .passthrough();

  const fleetListAgentsInputSchema = {
    includeArchived: z.boolean().optional().default(false),
    sinceHours: z
      .number()
      .int()
      .positive()
      .max(24 * 30)
      .optional()
      .default(48),
    statuses: z.array(AgentStatusEnum).optional(),
    limit: z.number().int().positive().max(200).optional().default(50),
  };

  const fleetAgentListItemSchema = AgentListItemPayloadSchema.extend({
    host: z.string(),
    // Roster enrichment: the agent's last report_status headlines (cap 5,
    // oldest -> newest) and its last non-system user message, when known.
    reportStatus: z.array(z.string()).max(5).optional(),
    lastUserMessage: z.string().nullable().optional(),
  });

  // --- M6 context tools: fleet_recall / fleet_context (read-only) -----------

  const runVerdictSchema = z
    .object({
      by: z.enum(["verifier", "user"]),
      summary: z.string(),
      at: z.string(),
      verifierAgentId: z.string().optional(),
    })
    .nullable();

  const runReportSchema = z.object({
    ts: z.string(),
    kind: z.string(),
    headline: z.string(),
    detail: z.string().optional(),
    reportKind: z.string().optional(),
  });

  const runProofSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    excerpt: z.string().optional(),
  });

  const runRecordSchema = z.object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    agentTitle: z.string(),
    hostAlias: z.string(),
    serverId: z.string(),
    workspaceId: z.string().nullable(),
    workspaceTitle: z.string().nullable(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    runEpoch: z.number(),
    startedAt: z.string(),
    endedAt: z.string(),
    outcome: z.string(),
    brief: z.string().nullable(),
    reports: z.array(runReportSchema),
    verdict: runVerdictSchema,
    proofs: z.array(runProofSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

  const runRollupEntrySchema = z.object({
    agentId: z.string(),
    agentName: z.string(),
    endedAt: z.string(),
    outcome: z.string(),
    brief: z.string().nullable(),
    decisions: z.array(z.string()),
    open: z.array(z.string()),
    verdict: z.string().nullable(),
  });

  const workspaceRollupSchema = z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string(),
    workspaceTitle: z.string().nullable(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    updatedAt: z.string(),
    runs: z.array(runRollupEntrySchema),
  });

  const projectRollupSchema = z.object({
    kind: z.literal("project"),
    projectId: z.string(),
    projectName: z.string().nullable(),
    updatedAt: z.string(),
    runs: z.array(runRollupEntrySchema),
  });

  const resolveFleetHost = (host: string): DaemonClient | null => {
    if (!peerManager) {
      return null;
    }
    const peerStatus = peerManager.getPeerStatus(host);
    if (!peerStatus) {
      return null;
    }
    if (peerStatus.state !== "online") {
      throw buildPeerUnreachableError(host, peerStatus.lastSeenAt);
    }
    return peerManager.getPeerClient(host);
  };

  /** Best-effort checkout read; never fails proposal creation. */
  const readWorkspaceCheckoutLite = async (
    cwd: string,
  ): Promise<ProjectCheckoutLitePayload | undefined> => {
    try {
      return await options.workspaceGitService?.getCheckout(cwd);
    } catch (error) {
      childLogger.warn(
        { err: error, cwd },
        "Failed to read checkout for a Commander spawn proposal label",
      );
      return undefined;
    }
  };

  /**
   * The name a freshly minted workspace at `cwd` would get, mirroring the
   * provisioning path (createWorkspaceForDirectory → initialWorkspacePlacement
   * → deriveWorkspaceDisplayName → resolveWorkspaceName): the checked-out
   * branch when on one, else the cwd's last path segment. When the cwd
   * already maps to a known workspace, that workspace's real name (title
   * wins) is preferred — the fresh mint shares the same checkout facts.
   */
  const resolveNewWorkspaceDisplayName = async (cwd: string): Promise<string> => {
    if (options.workspaceRegistry) {
      const mapped = resolveWorkspaceIdForPath(cwd, await options.workspaceRegistry.list());
      if (mapped) {
        const workspace = await options.workspaceRegistry.get(mapped);
        if (workspace && !workspace.archivedAt) {
          return resolveWorkspaceDisplayName(workspace);
        }
      }
    }
    const checkout = await readWorkspaceCheckoutLite(cwd);
    if (checkout) {
      // Same derivation the provisioning path uses (branch when on one, else
      // the cwd's last path segment — deriveWorkspaceDisplayName's fallback).
      return deriveWorkspaceDisplayName({ cwd, checkout });
    }
    const segments = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return segments[segments.length - 1] ?? cwd;
  };

  /**
   * The project a freshly minted workspace at `cwd` would join, mirroring the
   * provisioning path (findOrCreateProjectForDirectory): the exact cwd root's
   * existing project is reused when present (existing `project` label),
   * otherwise a project named after the cwd's basename would be created
   * (`newProject` label).
   */
  const resolveNewWorkspaceProjectLabel = async (
    cwd: string,
  ): Promise<{ key: "project" | "newProject"; name: string }> => {
    if (options.workspaceRegistry && options.projectRegistry) {
      const mapped = resolveWorkspaceIdForPath(cwd, await options.workspaceRegistry.list());
      if (mapped) {
        const workspace = await options.workspaceRegistry.get(mapped);
        // Only an exact cwd match reuses the mapped project — find-or-create
        // keys on the root path, so a nested cwd would mint its own project.
        if (workspace && !workspace.archivedAt && resolvePath(workspace.cwd) === resolvePath(cwd)) {
          const project = await options.projectRegistry.get(workspace.projectId);
          if (project && !project.archivedAt) {
            return { key: "project", name: resolveProjectDisplayName(project) };
          }
        }
      }
    }
    return { key: "newProject", name: basename(resolvePath(cwd)) || cwd };
  };

  /**
   * Resolve human-readable workspace/project labels for a Commander spawn
   * proposal at proposal-creation time, so the card renders names instead of
   * raw `wks_…` ids — even when the target workspace lives on another host
   * (the client's session-store lookup cannot see a peer's workspaces, so the
   * payload must be self-contained).
   *
   * Existing workspace (`workspaceId`): the workspace display name and its
   * project's name. New workspace (cwd only): the name the minted workspace
   * would get (see resolveNewWorkspaceDisplayName) plus the project it would
   * join. Peer targets resolve over the peer RPC (fetchWorkspaces) — the
   * local registries cannot see a peer's workspaces; a name is never
   * fabricated, so when nothing resolves the label is left absent and the
   * chips fall back to the raw payload fields.
   */
  const resolveCommanderSpawnLabels = async (input: {
    host: string;
    cwd?: string;
    workspaceId?: string;
  }): Promise<Record<string, string> | undefined> => {
    const { host, cwd, workspaceId } = input;
    const labels: Record<string, string> = {};
    if (isFleetLocalTarget(host)) {
      if (workspaceId) {
        const workspace = options.workspaceRegistry
          ? await options.workspaceRegistry.get(workspaceId)
          : undefined;
        if (workspace && !workspace.archivedAt) {
          labels.workspace = resolveWorkspaceDisplayName(workspace);
          const project = options.projectRegistry
            ? await options.projectRegistry.get(workspace.projectId)
            : undefined;
          if (project && !project.archivedAt) {
            labels.project = resolveProjectDisplayName(project);
          }
        }
      } else if (cwd) {
        labels.newWorkspace = await resolveNewWorkspaceDisplayName(cwd);
        const projectLabel = await resolveNewWorkspaceProjectLabel(cwd);
        labels[projectLabel.key] = projectLabel.name;
      }
    } else {
      // Peer target: the local registries cannot resolve the peer's workspace.
      let client: DaemonClient | null = null;
      try {
        client = resolveFleetHost(host);
      } catch (error) {
        childLogger.warn(
          { err: error, host },
          "Peer unavailable; leaving Commander spawn proposal labels unresolved",
        );
      }
      if (client && workspaceId) {
        try {
          const payload = await client.fetchWorkspaces({ page: { limit: 200 } });
          const entry = payload.entries.find((candidate) => candidate.id === workspaceId);
          if (entry) {
            // `name` carries the resolved title-or-derived name; `title` is
            // the raw override (null when derived) — mirror resolveWorkspaceName.
            labels.workspace = entry.title?.trim() || entry.name;
            labels.project = entry.projectDisplayName;
          }
        } catch (error) {
          childLogger.warn(
            { err: error, host, workspaceId },
            "Failed to resolve peer workspace label for a Commander spawn proposal",
          );
        }
      }
      // New workspace on a peer: the name derives from the peer's own checkout
      // (branch), which this daemon cannot know without fabricating — the
      // label stays absent and the chips fall back to the raw payload fields.
    }
    return Object.keys(labels).length > 0 ? labels : undefined;
  };

  registerTool(
    "fleet_list_agents",
    {
      title: "List agents across hosts",
      description:
        "List agents on this daemon and every reachable peer host, tagged with the host each agent runs on. " +
        "Unreachable hosts are omitted; use mission_control.peers.list or the board for host status.",
      inputSchema: fleetListAgentsInputSchema,
      outputSchema: {
        agents: z.array(fleetAgentListItemSchema),
      },
    },
    async ({ includeArchived = false, sinceHours = 48, statuses, limit = 50 }) => {
      const localResult = await toCatalog().executeTool("list_agents", {
        includeArchived,
        sinceHours,
        statuses,
        limit,
      });
      const localAgents = z
        .object({ agents: z.array(AgentListItemPayloadSchema) })
        .parse(localResult.structuredContent).agents;
      // Roster enrichment: each row gains the agent's last report_status
      // headlines (cap 5, oldest -> newest) and its last non-system user
      // message when one is known. Local rows read the local store + live
      // timeline; peer rows fetch one events payload per host.
      const localReports = collectReportStatusHeadlines(missionControlService?.fetchEvents() ?? []);
      const agents: Array<
        AgentListItemPayload & {
          host: string;
          reportStatus?: string[];
          lastUserMessage?: string | null;
        }
      > = [];
      for (const agent of localAgents) {
        const reports = localReports.get(agent.id);
        agents.push({
          ...agent,
          host: hostLabel,
          ...(reports ? { reportStatus: reports } : {}),
          lastUserMessage: lastUserMessageFor(agentManager, agent.id),
        });
      }

      if (peerManager) {
        const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
        for (const peerStatus of peerManager.getPeerStatuses()) {
          if (peerStatus.state !== "online") {
            continue;
          }
          const client = peerManager.getPeerClient(peerStatus.name);
          if (!client) {
            continue;
          }
          try {
            const peerAgents = await listPeerFleetAgents({
              client,
              peerName: peerStatus.name,
              includeArchived,
              statuses,
              sinceMs,
            });
            let peerReports = new Map<string, string[]>();
            try {
              const eventsPayload = await client.missionControlEventsFetch({ limit: 1000 });
              peerReports = collectReportStatusHeadlines(eventsPayload.events);
            } catch (error) {
              childLogger.warn(
                { err: error, peer: peerStatus.name },
                "Failed to fetch peer report_status events",
              );
            }
            for (const agent of peerAgents) {
              const reports = peerReports.get(agent.id);
              agents.push({
                ...agent,
                ...(reports ? { reportStatus: reports } : {}),
              });
            }
          } catch (error) {
            childLogger.warn(
              { err: error, peer: peerStatus.name },
              "Failed to list agents on peer",
            );
          }
        }
      }

      agents.sort(compareAgentListItems);
      return {
        content: [],
        structuredContent: ensureValidJson({ agents: agents.slice(0, limit) }),
      };
    },
  );

  registerTool(
    "fleet_create_agent",
    {
      title: "Create agent on a host",
      description:
        "Create an agent on a specific host in the fleet. host is a peer name from the daemon peers config, or 'local' for this daemon. " +
        "Requires provider/model (for example codex/gpt-5.4) and an initial prompt. " +
        "When targeting a peer, cwd or workspaceId is required to place the agent on that host.",
      inputSchema: fleetCreateAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async (args, context) => {
      const { host, cwd, workspaceId, provider, initialPrompt, title, labels, settings } = args;
      if (isCommanderCaller && missionControlService) {
        // Ask-mode gate (user decision: everything gated except the nudge —
        // including spawning a new agent). The spawn becomes a spawn-kind
        // proposal whose card shows what would be created (host, provider/
        // model, brief); approving (or auto mode) executes the spawn via the
        // approvals spawn hook (bootstrap spawnFromProposal).
        // Resolve human workspace/project labels at proposal time so the card
        // renders names (authoritative, cross-host correct) instead of raw
        // `wks_…` ids; caller-supplied labels pass through untouched.
        const resolvedSpawnLabels = await resolveCommanderSpawnLabels({
          host,
          cwd,
          workspaceId,
        });
        const spawnLabels = { ...labels, ...resolvedSpawnLabels };
        const gated = await runCommanderGatedAction({
          toolName: "fleet_create_agent",
          toolInput: args,
          buildProposal: () =>
            buildCommanderSpawnProposalInput({
              serverId: serverId ?? "",
              host,
              provider,
              title,
              initialPrompt,
              cwd,
              workspaceId,
              labels: Object.keys(spawnLabels).length > 0 ? spawnLabels : undefined,
              settings,
              ...(args.respondsTo ? { respondsTo: args.respondsTo } : {}),
            }),
        });
        if (!gated.ok) {
          throw new Error(gated.error);
        }
        const structuredContent = await formatSpawnProposalOutcome({
          proposal: gated.proposal,
          agentManager,
          agentStorage,
        });
        return { content: [], structuredContent: ensureValidJson(structuredContent) };
      }
      if (isFleetLocalTarget(host)) {
        const { cwd: _cwd, ...localArgs } = args;
        return toCatalog().executeTool("create_agent", localArgs, context);
      }
      const client = resolveFleetHost(host);
      if (!client) {
        throw new Error(`Host "${host}" is not a configured peer`);
      }
      if (!cwd && !workspaceId) {
        throw new Error(`cwd or workspaceId is required to place the agent on host "${host}"`);
      }
      const providerSlash = provider.indexOf("/");
      const snapshot = await client.createAgent({
        // The peer create RPC is the SESSION create path: `provider` must be
        // a plain provider id with `model` passed separately (the local
        // create_agent path splits "provider/model" itself). Passing the
        // combined string made every peer spawn fail with "Provider
        // provider/model is not configured" on the target host.
        provider: providerSlash > 0 ? provider.slice(0, providerSlash) : provider,
        ...(providerSlash > 0 ? { model: provider.slice(providerSlash + 1) } : {}),
        cwd: cwd ?? ".",
        workspaceId,
        initialPrompt,
        title,
        labels,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId: snapshot.id,
          type: snapshot.provider,
          status: snapshot.status,
          cwd: snapshot.cwd,
          ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
          lastMessage: null,
          permission: sanitizePermissionRequest(snapshot.pendingPermissions[0] ?? null),
        }),
      };
    },
  );

  registerTool(
    "fleet_get_agent_activity",
    {
      title: "Get agent activity on a host",
      description:
        "Return recent agent timeline entries as a curated summary, on this daemon ('local') or a peer host. " +
        "Same shape as the local get_agent_activity tool; proxied over peering so the Commander can read any " +
        "worker's timeline from its own host.",
      inputSchema: {
        host: z
          .string()
          .min(1)
          .describe(
            "Target host: a peer name from the daemon peers config, or 'local' for this daemon.",
          ),
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ host, agentId, limit }) => {
      if (isFleetLocalTarget(host)) {
        const local = await toCatalog().executeTool("get_agent_activity", { agentId, limit });
        const parsed = z
          .object({
            agentId: z.string(),
            updateCount: z.number(),
            currentModeId: z.string().nullable(),
            content: z.string(),
          })
          .parse(local.structuredContent);
        return { content: [], structuredContent: ensureValidJson(parsed) };
      }
      const client = resolveFleetHost(host);
      if (!client) {
        throw new Error(`Host "${host}" is not a configured peer`);
      }
      const payload = await client.fetchAgentTimeline(agentId, {
        direction: "tail",
        ...(typeof limit === "number" ? { limit } : {}),
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      const timeline = payload.entries.map((entry) => entry.item);
      const summary = curateActivitySummary({ timeline, limit });
      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: summary.updateCount,
          currentModeId: payload.agent?.currentModeId ?? null,
          content: summary.content,
        }),
      };
    },
  );

  registerTool(
    "fleet_search",
    {
      title: "Search the fleet",
      description:
        "Find which agents worked on something, across this daemon and every reachable peer host. " +
        "Tiered: identity/brief/report context first (instant), then a bounded transcript scan of the last 30 days, " +
        "and — only with deep:true when the earlier tiers find nothing — a History Ask agent that reads transcripts on disk. " +
        "Use for 'who worked on X' questions. fleet_list_agents is for rosters, not searching.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search text: a name, title, PR URL, or phrase an agent's work would mention."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .default(20)
          .describe("Maximum matches to return, fleet-wide."),
        deep: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true and the deterministic tiers find nothing, spawn a History Ask agent to read stored transcripts. Expensive; ask only when shallow search fails.",
          ),
      },
      outputSchema: {
        matches: z.array(MissionControlSearchMatchSchema),
      },
    },
    async ({ query, limit = 20, deep = false }) => {
      const startedAt = Date.now();
      const tier3Runner = buildFleetSearchTier3Runner();
      const localMatches = await runFleetSearchHost({
        query,
        limit,
        deep,
        deps: {
          agentManager,
          agentStorage,
          missionControlService: missionControlService ?? null,
          workspaceRegistry: options.workspaceRegistry,
          projectRegistry: options.projectRegistry,
          logger: childLogger,
          serverId: options.serverId,
          tier3: deep ? tier3Runner : null,
        },
      });

      const allMatches: FleetSearchMatch[] = [...localMatches];
      if (peerManager) {
        for (const peerStatus of peerManager.getPeerStatuses()) {
          if (peerStatus.state !== "online") {
            continue;
          }
          const client = peerManager.getPeerClient(peerStatus.name);
          if (!client) {
            continue;
          }
          try {
            const payload = await client.missionControlSearch({ query, limit, deep });
            for (const row of payload.matches) {
              allMatches.push({ ...row, host: peerStatus.name });
            }
          } catch (error) {
            childLogger.warn(
              { err: error, peer: peerStatus.name, component: "search" },
              "Failed to search peer",
            );
          }
        }
      }

      for (const match of allMatches) {
        if (match.host === "local") {
          match.host = hostLabel;
        }
      }
      const matches = mergeFleetSearchMatches(allMatches, limit);
      childLogger.info(
        {
          component: "search",
          query,
          limit,
          deep,
          localMatches: localMatches.length,
          hosts: [...new Set(matches.map((match) => match.host))],
          matches: matches.length,
          durationMs: Date.now() - startedAt,
        },
        "mission_control.fleet_search.done",
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ matches }),
      };
    },
  );

  /**
   * Tier 3 runner for fleet_search: spawns an omp History Ask agent on this
   * host (the existing History Ask machinery — same labels, same paseo://
   * citation contract as the app's launcher), waits for its answer, and maps
   * the citations into fleet search rows. Matches come back host-less;
   * runFleetSearchHost stamps them "local".
   */
  function buildFleetSearchTier3Runner(): FleetSearchTier3Runner {
    return {
      async run({ query }) {
        const localServerId = options.serverId ?? "";
        const providerIds = providerSnapshotManager.listRegisteredProviderIds();
        if (providerIds.length === 0) {
          childLogger.info(
            { component: "search" },
            "mission_control.fleet_search.tier3_no_provider",
          );
          return null;
        }
        const provider = providerIds.includes("omp") ? "omp" : providerIds[0]!;
        const workspaces = (await options.workspaceRegistry?.list()) ?? [];
        const workspace = workspaces
          .filter((candidate) => !candidate.archivedAt)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        const cleaned = query.trim().replace(/\s+/g, " ");
        const title =
          cleaned.length <= 40
            ? `Ask: fleet search: ${cleaned}`
            : `Ask: fleet search: ${cleaned.slice(0, 39)}…`;

        let agentId: string;
        try {
          const created = await createAgentCommand(
            {
              agentManager,
              agentStorage,
              logger: childLogger,
              paseoHome: options.paseoHome,
              worktreesRoot: options.worktreesRoot,
              terminalManager,
              providerSnapshotManager,
              createPaseoWorktree: options.createPaseoWorktree,
              ...(options.ensureWorkspaceForCreate
                ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
                : {}),
            },
            {
              kind: "mcp",
              provider,
              title,
              initialPrompt: buildFleetHistoryAskBrief(query, localServerId),
              cwd: workspace?.cwd ?? "~",
              ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
              labels: { "paseo.history-ask": "1", "paseo.history-ask.scope": "host" },
              background: false,
              notifyOnFinish: false,
            },
          );
          agentId = created.snapshot.id;
        } catch (error) {
          childLogger.warn(
            { err: error, component: "search" },
            "mission_control.fleet_search.tier3_spawn_failed",
          );
          return null;
        }

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error("deep fleet search timed out")),
          SEARCH_TIER3_TIMEOUT_MS,
        );
        try {
          const result = await agentManager.waitForAgentEvent(agentId, {
            signal: controller.signal,
          });
          const answer =
            result.lastMessage ?? (await agentManager.getLastAssistantMessage(agentId)) ?? "";
          const matches = parseHistoryAskMatches(answer, localServerId);
          childLogger.info(
            { component: "search", agentId, matches: matches.length },
            "mission_control.fleet_search.tier3_done",
          );
          return matches;
        } catch (error) {
          childLogger.warn(
            { err: error, component: "search", agentId },
            "mission_control.fleet_search.tier3_failed",
          );
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  registerTool(
    "fleet_send_prompt",
    {
      title: "Send agent prompt on a host",
      description:
        "Send a task to an agent on a specific host in the fleet. host is a peer name from the daemon peers config, or 'local' for this daemon. " +
        'mode controls delivery to a busy agent: "steer" injects into the live turn without cancelling (OMP live-steer; a busy non-OMP ' +
        'agent is interrupted so the message lands promptly), "queue" waits for the agent to idle before streaming, "interrupt" cancels ' +
        "the running turn and replaces it with this prompt. Omit mode to use the fleet commanderToWorkerMode central setting " +
        '(default "interrupt"); an explicit mode always overrides it — prefer "steer" for additive, non-urgent instructions.',
      inputSchema: {
        host: z
          .string()
          .min(1)
          .describe(
            "Target host: a peer name from the daemon peers config, or 'local' for this daemon.",
          ),
        agentId: z.string(),
        prompt: z.string(),
        mode: z
          .enum(["steer", "interrupt", "queue"])
          .optional()
          .describe(
            "Delivery to a busy agent. Omit to use the fleet commanderToWorkerMode setting.",
          ),
        respondsTo: z
          .string()
          .optional()
          .describe(
            "M8 instruction ledger: the open instruction id this dispatch answers (e.g. '#12'). The envelope lists open ids; cite one on every card you emit for a user instruction.",
          ),
        // Composer paste-through: the Commander forwards user attachments
        // (uploaded_file, github_pr, review, ...) as descriptors only — no
        // base64 through the model. The receiving daemon resolves them into
        // the worker prompt via the existing attachment store.
        attachments: z
          .array(AgentAttachmentSchema)
          .optional()
          .describe(
            "User attachments to forward to the worker (composer paste-through). Descriptors only; " +
              "uploaded_file references are resolved by the daemon from its attachment store.",
          ),
      },
      outputSchema: {
        success: z.boolean(),
        deliveryMode: z.enum(["steer", "interrupt", "queue", "steer-interrupt"]),
      },
    },
    async ({ host, agentId, prompt, mode, attachments, respondsTo }) => {
      // The Commander's default comes from the fleet central setting
      // commanderToWorkerMode (default "interrupt" — a fleet direction change
      // is time-sensitive and queue-until-idle can sit for tens of minutes).
      // An explicit mode argument from the Commander always wins; it may
      // choose "steer" for additive, non-urgent instructions.
      const effectiveMode =
        mode ?? missionControlService?.getCentralConfig().commanderToWorkerMode ?? "interrupt";
      if (isCommanderCaller && missionControlService) {
        // Ask-mode gate (user decision: everything gated except the nudge).
        // The send becomes a proposal; auto mode delivers immediately via the
        // approvals module, ask mode waits for Approve/Edit/Deny.
        const gated = await runCommanderGatedAction({
          toolName: "fleet_send_prompt",
          toolInput: { host, agentId, prompt, mode, attachments },
          buildProposal: () => ({
            origin: "commander",
            serverId: serverId ?? "",
            targetAgentId: agentId,
            message: prompt,
            deliveryMode: effectiveMode,
            reason: "Commander send",
            classification: "normal",
            timelineClassification: "instruction",
            ...(respondsTo ? { respondsTo } : {}),
          }),
        });
        if (!gated.ok) {
          throw new Error(gated.error);
        }
        const proposal = gated.proposal;
        if (proposal.status === "pending") {
          return {
            content: [],
            structuredContent: ensureValidJson({
              success: false,
              deliveryMode: effectiveMode,
              guidance: `Send request sent for approval (proposal ${proposal.id}). It will be delivered once approved.`,
            }),
          };
        }
        // Auto mode: approvals already delivered the message.
        return {
          content: [],
          structuredContent: ensureValidJson({ success: true, deliveryMode: effectiveMode }),
        };
      }
      if (isFleetLocalTarget(host)) {
        const deliveredAs = await dispatchLocalPromptMode({
          agentManager,
          agentStorage,
          agentId,
          prompt,
          mode: effectiveMode,
          attachments,
          // A Commander/Verifier dispatch superseding a busy worker's run is
          // machinery-originated — the superseded run must keep the failure
          // treatment, never read as a user interruption.
          replaceOrigin: "machinery",
          recordStopOrigin: (stopAgentId, origin) =>
            missionControlService?.recordStopOrigin(stopAgentId, origin),
          logger: childLogger,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ success: true, deliveryMode: deliveredAs }),
        };
      }
      const client = resolveFleetHost(host);
      if (!client) {
        throw new Error(`Host "${host}" is not a configured peer`);
      }
      await client.sendAgentMessage(agentId, prompt, {
        dispatchMode: effectiveMode,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, deliveryMode: effectiveMode }),
      };
    },
  );

  registerTool(
    "fleet_meta",
    {
      title: "Fleet meta actions",
      description:
        "Apply a fleet meta action: rename/archive a project, workspace, or agent (agent TITLE only — names are " +
        "permanent), create a project, move an agent to another workspace, or promote an experiment workspace " +
        "(a workspace in the per-host experiments project) to its own project. " +
        "Every action routes through the approval gate — archive actions always ask, even in auto mode. " +
        "metaPlan: { action, serverId?, targetId?, targetLabel?, newValue?, destination? }. " +
        'serverId names the host the action applies to ("local" or a peer name); destination is the target ' +
        "workspace id for move_agent/promote_workspace and the project root path for create_project.",
      inputSchema: {
        metaPlan: MissionControlMetaPlanSchema,
        respondsTo: z
          .string()
          .optional()
          .describe(
            "M8 instruction ledger: the open instruction id this dispatch answers (e.g. '#12'). The envelope lists open ids; cite one on every card you emit for a user instruction.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        status: z.enum(["pending", "sent"]).optional(),
        proposalId: z.string().optional(),
        guidance: z.string().optional(),
        error: z.string().optional(),
      },
    },
    async (args: { metaPlan: MissionControlMetaPlan; respondsTo?: string }) => {
      if (!isCommanderCaller || !missionControlService) {
        throw new Error("fleet_meta requires a Commander caller");
      }
      // M5: ask-mode gate (user decision: everything gated except the nudge).
      // The meta action becomes a meta-kind proposal whose card shows what
      // would change; approving (or auto mode — except destructive archives,
      // which always ask) applies it via the metaFromProposal hook. args is
      // schema-validated at the tool boundary (inputSchema), so classify and
      // buildProposal close over the typed value.
      const metaWorkspaceRegistry = options.workspaceRegistry;
      const metaProjectRegistry = options.projectRegistry;
      if (!metaWorkspaceRegistry || !metaProjectRegistry) {
        throw new Error(
          "fleet_meta is unavailable: workspace/project registries are not configured on this daemon",
        );
      }
      const gated = await runCommanderGatedAction({
        toolName: "fleet_meta",
        toolInput: args,
        classify: () => classifyFleetMetaAction(args.metaPlan),
        buildProposal: async () => {
          const proposalInput = await buildFleetMetaProposalInput({
            serverId: serverId ?? "",
            hostAlias: options.hostAlias,
            peerManager: peerManager ?? null,
            metaPlan: args.metaPlan,
            lookup: {
              agentManager,
              agentStorage,
              workspaceRegistry: metaWorkspaceRegistry,
              projectRegistry: metaProjectRegistry,
            },
          });
          return args.respondsTo
            ? { ...proposalInput, respondsTo: args.respondsTo }
            : proposalInput;
        },
      });
      if (!gated.ok) {
        throw new Error(gated.error);
      }
      const proposal = gated.proposal;
      if (proposal.status === "pending") {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: true,
            status: "pending",
            proposalId: proposal.id,
            guidance: `Meta action sent for approval (proposal ${proposal.id}). It will be applied once approved.`,
          }),
        };
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          ok: true,
          status: "sent",
          proposalId: proposal.id,
          guidance: `Meta action applied (proposal ${proposal.id}).`,
        }),
      };
    },
  );

  registerTool(
    "fleet_recall",
    {
      title: "Recall prior fleet work from memory",
      description:
        "Semantic recall over the fleet memory bank (Hindsight): run records written when agents finish — briefs, " +
        "report histories, decisions, verdicts — plus transcript memories from the read-only omp bank when configured. " +
        "THE lookup for 'which agent was that' and for pulling related prior work into a brief. Results are tagged with " +
        "their source `bank` ('paseo-fleet' run records vs 'omp' transcript memories); omp memories carry a sessionId " +
        "(raw, passthrough) plus an `attribution` block naming the Paseo agent when its persistence handle matches, and " +
        "`entities` naming agents/workspaces for unmatched ones. When the bank is unconfigured or unreachable this returns " +
        '{ok:false, reason:"memory unavailable"} — fall back to fleet_search / fleet_get_agent_activity, never guess. ' +
        "Read-only; never approval-gated.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "What to recall: an agent, a decision, a piece of work ('who fixed the auth bug').",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .default(5)
          .describe("Maximum memories to return."),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        matches: z
          .array(
            z.object({
              text: z.string(),
              // Source bank of the memory: the fleet bank (run records) or
              // the secondary omp bank (transcript memories).
              bank: z.string().optional(),
              context: z.string().nullable().optional(),
              occurredStart: z.string().nullable().optional(),
              documentId: z.string().nullable().optional(),
              tags: z.array(z.string()).nullable().optional(),
              // omp-bank memories: raw passthrough so unresolved matches can
              // be fleet_searched. sessionId = the omp session id (same id as
              // an agent's persistence handle); entities name agents/workspaces.
              sessionId: z.string().nullable().optional(),
              entities: z.array(z.string()).nullable().optional(),
              metadata: z.record(z.string(), z.unknown()).nullable().optional(),
              // Local attribution when the session id resolved to a Paseo
              // agent (live or stored). Absent = unresolved — use the raw
              // session_id/entities and fleet_search.
              attribution: z
                .object({
                  agentId: z.string(),
                  agentName: z.string(),
                  agentTitle: z.string(),
                  workspaceId: z.string().nullable(),
                })
                .optional(),
            }),
          )
          .optional(),
      },
    },
    async ({ query, limit = 5 }) => {
      if (!missionControlService) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            reason: "memory unavailable",
          }),
        };
      }
      const result = await missionControlService.hindsightRecall(query, limit);
      return {
        content: [],
        structuredContent: ensureValidJson(result),
      };
    },
  );

  registerTool(
    "fleet_context",
    {
      title: "Fetch run records and workspace/project rollups",
      description:
        "Fetch deterministic run records (brief + report history + verdict + proofs) and workspace/project rollups " +
        "from the local mission-control store. Pass agentId for that agent's latest runs, workspaceId for the " +
        "workspace rollup + its run records, projectId for the project rollup + its run records, or nothing for the " +
        "most recent records fleet-wide. Use this to warm a worker's brief with prior context — spawned workers already " +
        "receive the '# Prior work in this workspace' block automatically. Read-only; never approval-gated.",
      inputSchema: {
        workspaceId: z.string().optional(),
        projectId: z.string().optional(),
        agentId: z.string().optional(),
      },
      outputSchema: {
        runRecords: z.array(runRecordSchema),
        workspaceRollup: workspaceRollupSchema.optional(),
        projectRollup: projectRollupSchema.optional(),
      },
    },
    async (args: { workspaceId?: string; projectId?: string; agentId?: string }) => {
      if (!missionControlService) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            error: "Mission Control is not enabled on this host",
          }),
        };
      }
      const all = missionControlService.getRunRecords();
      let runRecords = all;
      let workspaceRollup: import("../../mission-control/rollups.js").WorkspaceRollup | undefined;
      let projectRollup: import("../../mission-control/rollups.js").ProjectRollup | undefined;
      if (args.agentId) {
        runRecords = all.filter((record) => record.agentId === args.agentId).slice(0, 5);
      } else if (args.workspaceId) {
        runRecords = all.filter((record) => record.workspaceId === args.workspaceId).slice(0, 5);
        workspaceRollup = missionControlService.getWorkspaceRollup(args.workspaceId) ?? undefined;
      } else if (args.projectId) {
        runRecords = all.filter((record) => record.projectId === args.projectId).slice(0, 5);
        projectRollup = missionControlService.getProjectRollup(args.projectId) ?? undefined;
      } else {
        runRecords = all.slice(0, 10);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          runRecords,
          ...(workspaceRollup ? { workspaceRollup } : {}),
          ...(projectRollup ? { projectRollup } : {}),
        }),
      };
    },
  );

  registerTool(
    "tag_message",
    {
      title: "Tag user message to agents",
      description:
        "Record that the user message you are currently handling relates to the given agent ids. " +
        "The Verifier reads these tags when auditing a worker, so tag every handled user message that names specific agents. " +
        "Fleet-wide remarks (no specific agent) should tag all active agents from the roster. Never tag digest notifications.",
      inputSchema: {
        agentIds: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Agent ids this user message relates to (fleet-wide remarks: all active roster ids).",
          ),
      },
      outputSchema: {
        recorded: z.boolean(),
      },
    },
    async (input: { agentIds: string[] }) => {
      const { agentIds } = input;
      if (!callerAgentId) {
        throw new Error("tag_message requires an agent-scoped session");
      }
      if (!missionControlService) {
        throw new Error("Mission Control is not enabled on this host");
      }
      const message = resolveCommanderUserMessage(agentManager, callerAgentId);
      if (!message) {
        throw new Error("No user message found to tag; tag only while handling a user message");
      }
      const uniqueAgentIds: string[] = [...new Set(agentIds as string[])];
      await missionControlService.recordMessageTags({
        messageId: message.messageId,
        agentIds: uniqueAgentIds,
        ts: new Date().toISOString(),
        text: message.text,
      });
      childLogger.info(
        {
          component: "tagging",
          agentId: callerAgentId,
          agentIds: uniqueAgentIds,
          messageId: message.messageId,
        },
        "mission_control.tagging.recorded",
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ recorded: true }),
      };
    },
  );

  // M4 Commander interaction cards: clarify and post_answer are the ONLY ways
  // the Commander speaks to the user besides proposals and direct replies.
  // Registered unconditionally and gated like the fleet_* tools — the
  // Commander's toolAllowlist (commander-contract.ts) hands them to the
  // Commander session and nothing else, and the handler rejects non-Commander
  // callers. They are NOT approval-gated: a clarification or answer card is a
  // card TO the user, never a side effect on the fleet. The user's response
  // to a clarification arrives as a normal user message; there is no
  // response RPC.
  registerTool(
    "clarify",
    {
      title: "Ask the user a structured question",
      description:
        "Ask the user a question with discrete options (and optional free text) when you cannot " +
        "resolve which agent, workspace, or project they mean, or when the missing fact is one only " +
        "they know (user-private or consequential). Renders as a clarification card with the options " +
        "as buttons; their choice comes back as a normal user message. NEVER ask what the snapshot " +
        "or a fleet tool can answer. One question per card: pick the single decision that blocks " +
        "dispatch.",
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(1, "question is required")
          .max(500, "question must be at most 500 characters")
          .describe(
            "The single decision needed, phrased as a question the user can answer in one tap.",
          ),
        options: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(8)
          .describe(
            "Discrete answers (2-8). Each must be self-explanatory — the user taps without reading " +
              "extra context.",
          ),
        allowFreeText: z
          .boolean()
          .default(false)
          .describe(
            "Allow a free-text answer in addition to the options (true only when no option set can " +
              "cover the answer space).",
          ),
        respondsTo: z
          .string()
          .optional()
          .describe(
            "M8 instruction ledger: the open instruction id this clarification answers (e.g. '#12'). The envelope lists open ids; cite one on every card you emit for a user instruction.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        eventId: z.string().optional(),
      },
    },
    async (input: {
      question: string;
      options: string[];
      allowFreeText: boolean;
      respondsTo?: string;
    }) => {
      if (!isCommanderCaller) {
        throw new Error("clarify requires a Commander caller");
      }
      if (!missionControlService) {
        throw new Error("Mission Control is not enabled on this host");
      }
      const event = await missionControlService.emitCommanderCard({
        kind: "clarification",
        headline: input.question,
        clarification: {
          question: input.question,
          options: input.options,
          allowFreeText: input.allowFreeText,
          ...(input.respondsTo ? { respondsTo: input.respondsTo } : {}),
        },
      });
      if (!event) {
        throw new Error("No Commander to attribute the clarification card to");
      }
      childLogger.info(
        { component: "commander-card", eventId: event.id, kind: "clarification" },
        "mission_control.commander_card.clarification",
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ ok: true, eventId: event.id }),
      };
    },
  );

  registerTool(
    "post_answer",
    {
      title: "Post a structured fleet answer",
      description:
        'Answer a fleet question as a structured answer card. Use kind "agent_status" when the ' +
        "question is about a specific agent (renders name, host chip, state, last report, proofs — " +
        'native feed-card components); use kind "generic" with optional labeled fields for ' +
        "everything else, and free text only when the answer genuinely has no structure. Answer " +
        "from the world snapshot and fleet tools, never from memory of old digests. One answer per " +
        "call; multi-part answers get one card per question.",
      inputSchema: {
        kind: z
          .enum(["agent_status", "generic"])
          .describe(
            "agent_status: about one agent (renders the agent's feed-card identity). generic: any " +
              "other structured answer.",
          ),
        agentId: z
          .string()
          .optional()
          .describe("The agent the answer is about; required when kind is agent_status."),
        headline: z
          .string()
          .trim()
          .min(1, "headline is required")
          .max(120, "headline must be at most 120 characters")
          .describe("One-line answer headline, plain language, no markdown."),
        body: z
          .string()
          .optional()
          .describe(
            "Optional detail (1-3 sentences). Free text only when the answer has no structure; " +
              "prefer fields.",
          ),
        fields: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(60),
              value: z.string().trim().min(1).max(400),
            }),
          )
          .max(12)
          .optional()
          .describe(
            "Optional labeled rows (state, host, last report, proofs, dates...). Label the value, " +
              "never paste raw ids.",
          ),
        respondsTo: z
          .string()
          .optional()
          .describe(
            "M8 instruction ledger: the open instruction id this answer responds to (e.g. '#12'). The envelope lists open ids; cite one on every card you emit for a user instruction.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        eventId: z.string().optional(),
      },
    },
    async (input: {
      kind: "agent_status" | "generic";
      agentId?: string;
      headline: string;
      body?: string;
      fields?: Array<{ label: string; value: string }>;
      respondsTo?: string;
    }) => {
      if (!isCommanderCaller) {
        throw new Error("post_answer requires a Commander caller");
      }
      if (!missionControlService) {
        throw new Error("Mission Control is not enabled on this host");
      }
      if (input.kind === "agent_status" && !input.agentId) {
        throw new Error("agentId is required when kind is agent_status");
      }
      const event = await missionControlService.emitCommanderCard({
        kind: "answer",
        headline: input.headline,
        answer: {
          kind: input.kind,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          headline: input.headline,
          ...(input.body ? { body: input.body } : {}),
          ...(input.fields && input.fields.length > 0 ? { fields: input.fields } : {}),
          ...(input.respondsTo ? { respondsTo: input.respondsTo } : {}),
        },
      });
      if (!event) {
        throw new Error("No Commander to attribute the answer card to");
      }
      childLogger.info(
        { component: "commander-card", eventId: event.id, kind: "answer" },
        "mission_control.commander_card.answer",
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ ok: true, eventId: event.id }),
      };
    },
  );

  // Verifier-only tools: exposed only to sessions of Mission Control verifier
  // agents (paseo.mission-control=verifier). contact_worker routes through the
  // approval gate and relays the worker's reply back; submit_verdict records
  // the audit result. The verifier session's toolAllowlist restricts the
  // catalog to exactly these two names.
  const verifierDispatcher = options.verifierDispatcher ?? null;
  if (
    verifierDispatcher !== null &&
    isVerifierCatalogCaller(options, verifierDispatcher, callerAgentId)
  ) {
    registerTool(
      "contact_worker",
      {
        title: "Contact worker",
        description:
          "Request proof or clarification from the worker you are auditing. The message is " +
          "routed through the approval gate and delivered per the fleet verifierToWorkerMode " +
          "setting (default interrupt; steer when the worker is mid-turn); the worker's reply " +
          "(its next report_status or final turn text) is relayed back to you as a message. " +
          "Call this when a requirement of the brief is unproven or a proof is missing.",
        inputSchema: {
          message: z
            .string()
            .trim()
            .min(1, "message is required")
            .max(4000, "message must be at most 4000 characters")
            .describe("Precise request naming the requirement and the proof you need."),
        },
      },
      async ({ message }) => {
        if (callerAgentId === undefined) {
          throw new Error("contact_worker requires an agent-scoped session");
        }
        return verifierDispatcher.handleContactWorker(callerAgentId, message);
      },
    );

    registerTool(
      "submit_verdict",
      {
        title: "Submit verdict",
        description:
          'Finish the audit. result "done" marks the item done with your one-line summary; ' +
          'result "insufficient" asks the worker for the missing proofs. Call exactly once ' +
          "when the evidence is settled.",
        inputSchema: {
          result: z
            .enum(["done", "insufficient"])
            .describe("done: evidence proves the brief. insufficient: proofs are missing."),
          summary: z
            .string()
            .trim()
            .min(1, "summary is required")
            .max(280, "summary must be at most 280 characters")
            .describe("One-line summary: what was asked, what was evidenced (or what is missing)."),
        },
      },
      async ({ result, summary }) => {
        if (callerAgentId === undefined) {
          throw new Error("submit_verdict requires an agent-scoped session");
        }
        return verifierDispatcher.handleSubmitVerdict(callerAgentId, { result, summary });
      },
    );
  }

  return toCatalog();
}

// How long fleet_send_prompt mode "queue" waits for a busy agent's in-flight
// run to settle before giving up with an actionable error.
const FLEET_QUEUE_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Bounded wait for an agent's in-flight run to settle (queue mode). Polls the
 * manager's run bookkeeping rather than listening for stream events so the
 * caller gets a deterministic "still busy" answer at the deadline.
 */
async function waitForAgentIdle(
  agentManager: AgentManager,
  agentId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!agentManager.hasInFlightRun(agentId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !agentManager.hasInFlightRun(agentId);
}

/**
 * Local delivery for fleet_send_prompt modes:
 * - steer: OMP live-steer (out-of-band, non-cancelling) when the agent is busy
 *   on the omp provider; an idle agent just runs the prompt. A busy agent on a
 *   provider WITHOUT a native steer path is INTERRUPTED (replaceRunning) —
 *   a steer's value is timely delivery, and queue-until-idle can sit for tens
 *   of minutes, so the fallback cancels and replaces rather than waiting.
 *   The returned value distinguishes the fallback ("steer-interrupt") from a
 *   native steer so callers/logs stay honest about what actually happened.
 * - queue: wait for idle, then stream without replacing.
 * - interrupt: today's replaceRunning behavior (sendPromptToAgent).
 *
 * Attachments ride along as prompt blocks (buildAgentPrompt) — descriptors
 * only, resolved by the daemon from the attachment store, never base64.
 *
 * Returns what ACTUALLY happened: "steer" (native out-of-band steer or a plain
 * run on an idle agent), "steer-interrupt" (steer requested, delivered as an
 * interrupt fallback on a busy non-OMP agent), "interrupt" (requested
 * interrupt), or "queue" (requested queue; waited for idle then ran).
 */
/**
 * The interrupt delivery path (dispatchLocalPromptMode mode "interrupt"):
 * cancel the running turn and replace it with the prompt. The superseded
 * run's terminal failure is attributed to `replaceOrigin` (default
 * "machinery" — dispatchLocalPromptMode's callers are machinery dispatches).
 */
async function dispatchInterrupt(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  promptWithAttachments: AgentPromptInput;
  classification: AgentTimelineUserMessageClassification;
  replaceOrigin?: "user" | "machinery";
  recordStopOrigin?: (agentId: string, origin: "user" | "machinery") => void;
  /** Client optimistic message id; rides the run so the echoed user row carries it. */
  messageId?: string;
  logger: Logger;
}): Promise<"interrupt"> {
  const {
    agentManager,
    agentStorage,
    agentId,
    promptWithAttachments,
    classification,
    replaceOrigin,
    recordStopOrigin,
    messageId,
    logger,
  } = params;
  // Interrupt turns echo the submitted prompt as a user row naturally; stamp
  // machinery classification onto that echo so it renders as a placeholder.
  if (classification === "machinery" && typeof promptWithAttachments === "string") {
    agentManager.expectPromptClassification(agentId, promptWithAttachments, "machinery");
  }
  if (agentManager.hasInFlightRun(agentId)) {
    recordStopOrigin?.(agentId, replaceOrigin ?? "machinery");
  }
  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId,
    prompt: promptWithAttachments,
    replaceOrigin,
    messageId,
    logger,
  });
  return "interrupt";
}

/**
 * Run options for a dispatched prompt: the superseding origin and the client's
 * optimistic message id, omitted entirely when neither applies so callers keep
 * the previous "no runOptions" shape.
 */
function dispatchRunOptions(input: {
  replaceOrigin?: "user" | "machinery";
  messageId?: string;
}): { runOptions: { replaceOrigin?: "user" | "machinery"; clientMessageId?: string } } | undefined {
  if (!input.replaceOrigin && !input.messageId) {
    return undefined;
  }
  return {
    runOptions: {
      ...(input.replaceOrigin ? { replaceOrigin: input.replaceOrigin } : {}),
      ...(input.messageId ? { clientMessageId: input.messageId } : {}),
    },
  };
}

export async function dispatchLocalPromptMode(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  prompt: string;
  mode: "steer" | "interrupt" | "queue";
  attachments?: AgentAttachment[];
  /**
   * The client's optimistic message id (the local user_message's
   * clientMessageId). Every user row this dispatch records or echoes carries
   * it so the client reconciles the row with its optimistic bubble — one row,
   * not two. Absent (older clients, machinery dispatches) → no dedupe,
   * exactly as before.
   */
  messageId?: string;
  /**
   * How the delivered prompt classifies on the agent's OWN timeline row:
   * "machinery" (status asks — stall nudges) vs "instruction" (Commander
   * direction changes, Verifier proof demands, recovery). Absent =
   * "instruction" (visible). Machinery rows render as a muted one-line
   * placeholder in the agent chat (verbose mode only); instruction rows must
   * always be visible — including steer deliveries, which otherwise record no
   * user row in Paseo's timeline at all.
   */
  classification?: AgentTimelineUserMessageClassification;
  /**
   * Who supersedes the in-flight run when this dispatch replaces one
   * (interrupt, or the steer→interrupt fallback on a busy non-OMP agent).
   * Machinery dispatches pass "machinery" so the superseded run's terminal
   * failure keeps the failure treatment (see AgentRunOptions.replaceOrigin).
   */
  replaceOrigin?: "user" | "machinery";
  /**
   * Mission Control stop-origin recorder, called exactly when this dispatch
   * replaces an in-flight run. Machinery callers wire their MC service/store
   * here so the superseded run's origin reads "machinery" — never "user".
   */
  recordStopOrigin?: (agentId: string, origin: "user" | "machinery") => void;
  /**
   * Honest-steer-delivery hook: called exactly when an out-of-band steer was
   * accepted by the provider runtime (tryRunOutOfBand returned handled). The
   * caller (mission-control) arms a delivery-verification window because
   * "handled" does not by itself prove the steer was processed — a wedged
   * omp loop can swallow the prompt while Paseo records "sent".
   */
  onOutOfBandSteer?: () => void;
  logger: Logger;
}): Promise<"steer" | "interrupt" | "queue" | "steer-interrupt"> {
  const { agentManager, agentStorage, agentId, prompt, mode, attachments, messageId, logger } =
    params;
  const classification = params.classification ?? "instruction";
  const replaceOrigin = params.replaceOrigin;
  const recordStopOrigin = params.recordStopOrigin;
  const promptWithAttachments = buildAgentPrompt(prompt, undefined, attachments);
  if (mode === "interrupt") {
    return dispatchInterrupt({
      agentManager,
      agentStorage,
      agentId,
      promptWithAttachments,
      classification,
      replaceOrigin,
      recordStopOrigin,
      messageId,
      logger,
    });
  }
  if (mode === "steer") {
    const busy = agentManager.hasInFlightRun(agentId);
    if (busy && agentManager.getAgent(agentId)?.provider === "omp") {
      // Live-steer is text-only; render attachments so the worker still sees
      // their content without base64 crossing the model boundary.
      const steerText =
        attachments && attachments.length > 0
          ? [prompt.trim(), ...attachments.map(renderPromptAttachmentAsText)]
              .filter(Boolean)
              .join("\n\n")
          : prompt;
      const handled = agentManager.tryRunOutOfBand(agentId, `/steer ${steerText}`);
      if (handled) {
        // The native steer runs inside the provider runtime and records NO
        // user row in Paseo's timeline (no turn, no echo). Record the prompt
        // ourselves so the agent's chat is never missing an instruction:
        // instruction rows render as a normal user message, machinery rows as
        // a muted one-line placeholder (verbose mode only).
        await agentManager.appendTimelineItem(agentId, {
          type: "user_message",
          text: steerText,
          classification,
          // The steer runs inside the provider runtime, so this appended row
          // is the ONLY daemon-side record of the prompt. Carry the client's
          // optimistic message id so the client reconciles this row with its
          // optimistic bubble instead of rendering a duplicate.
          ...(messageId ? { clientMessageId: messageId } : {}),
        });
        // Honest delivery: handled means the provider accepted the prompt —
        // NOT that the agent will act on it (a wedged omp loop can swallow
        // the steer entirely). The machinery caller verifies real activity
        // and escalates when none comes.
        params.onOutOfBandSteer?.();
        return "steer";
      }
    }
    if (!busy) {
      // No live in-flight run to steer against (idle agent, or a stored-only
      // record whose runtime is gone): start a FRESH run via the full send
      // path — which loads the agent from storage first — never queue behind
      // a phantom "running" record. Mirrors the interrupt guarantee: a
      // refused replace surfaces the error, never silently queues.
      if (classification === "machinery" && typeof promptWithAttachments === "string") {
        agentManager.expectPromptClassification(agentId, promptWithAttachments, "machinery");
      }
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt: promptWithAttachments,
        replaceOrigin,
        messageId,
        logger,
      });
      return "steer";
    }
    // Busy on a provider without a native steer path (or a "running" record
    // whose runtime is dead): interrupt (replace the running turn). Queueing
    // would sit behind a possibly-stuck run for up to ten minutes; the
    // steer's value is timely delivery, so cancel and replace. startAgentRun
    // still probes out-of-band first (harmless — the plain prompt has no
    // /steer prefix), then replaces the running turn.
    recordStopOrigin?.(agentId, replaceOrigin ?? "machinery");
    await startAgentRun(agentManager, agentId, promptWithAttachments, logger, {
      replaceRunning: true,
      ...dispatchRunOptions({ replaceOrigin, messageId }),
    });
    return "steer-interrupt";
  }
  const idle = await waitForAgentIdle(agentManager, agentId, FLEET_QUEUE_WAIT_TIMEOUT_MS);
  if (!idle) {
    throw new Error(
      `Agent ${agentId} is still busy after ${Math.round(FLEET_QUEUE_WAIT_TIMEOUT_MS / 60_000)} min; ` +
        "retry with mode 'interrupt' to cancel the running turn.",
    );
  }
  if (classification === "machinery" && typeof promptWithAttachments === "string") {
    agentManager.expectPromptClassification(agentId, promptWithAttachments, "machinery");
  }
  await startAgentRun(agentManager, agentId, promptWithAttachments, logger, {
    replaceRunning: false,
    ...dispatchRunOptions({ messageId }),
  });
  return "queue";
}

interface ArchiveWorktreeCommandContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager | null;
  logger: Logger;
}

function archiveWorktreeDependencies(
  options: PaseoToolHostDependencies,
  context: ArchiveWorktreeCommandContext,
): ArchiveCommandDependencies {
  if (!options.github) {
    throw new Error("GitHub service is required to archive worktrees");
  }
  if (!options.workspaceGitService) {
    throw new Error("WorkspaceGitService is required to archive worktrees");
  }
  if (!options.archiveWorkspaceRecord) {
    throw new Error("Workspace registry archiver is required to archive worktrees");
  }
  if (!options.findWorkspaceIdForCwd) {
    throw new Error("Workspace resolver is required to archive worktrees");
  }
  if (!options.listActiveWorkspaces) {
    throw new Error("Active workspace lister is required to archive worktrees");
  }
  if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
    throw new Error("Workspace update emitter is required to archive worktrees");
  }
  if (!options.markWorkspaceArchiving) {
    throw new Error("Workspace archiving marker is required to archive worktrees");
  }
  if (!options.clearWorkspaceArchiving) {
    throw new Error("Workspace archiving clearer is required to archive worktrees");
  }
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    github: options.github,
    workspaceGitService: options.workspaceGitService,
    agentManager: context.agentManager,
    agentStorage: context.agentStorage,
    findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
    listActiveWorkspaces: options.listActiveWorkspaces,
    archiveWorkspaceRecord: options.archiveWorkspaceRecord,
    emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
    markWorkspaceArchiving: options.markWorkspaceArchiving,
    clearWorkspaceArchiving: options.clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId: string) =>
      killTerminalsForWorkspace(
        {
          terminalManager: context.terminalManager,
          sessionLogger: context.logger,
        },
        workspaceId,
      ),
    sessionLogger: context.logger,
  };
}

/**
 * Verifier-tool gate. Launch contexts are built BEFORE the agent registers,
 * so the creation labels (callerLabels) must be honored first; the registry
 * lookup only covers already-registered sessions (e.g. the agent MCP
 * endpoint), never the create-time catalog build.
 */
function isVerifierCatalogCaller(
  options: PaseoToolHostDependencies,
  verifierDispatcher: PaseoToolHostDependencies["verifierDispatcher"] | null,
  callerAgentId: string | undefined,
): boolean {
  if (!verifierDispatcher || callerAgentId === undefined) {
    return false;
  }
  if (options.callerLabels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_VERIFIER_LABEL_VALUE) {
    return true;
  }
  return verifierDispatcher.isVerifierAgent(callerAgentId);
}
