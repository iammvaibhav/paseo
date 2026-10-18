import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { isAbsolute } from "node:path";
import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
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
import { AgentProfileSchema } from "@getpaseo/protocol/messages";
import { slugify } from "@getpaseo/protocol/branch-slug";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
  type AgentAttachment,
} from "../../messages.js";
import type { AgentListItemPayload } from "../../messages.js";
import {
  buildStoredAgentPayload,
  normalizeLabels,
  toAgentListItemPayload,
  toAgentPayload,
} from "../agent-projections.js";
import { curateAgentActivity } from "../activity-curator.js";
import { selectItemsByProjectedLimit } from "../timeline-projection.js";
import type { AgentStorage } from "../agent-storage.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { seedStoredTimeline, registerFleetTranscriptTool } from "./fleet-transcript.js";
import {
  FleetAttachmentInputSchema,
  FleetImageInputSchema,
  forwardUploadedFilesToPeer,
  registerFleetFileTools,
  resolveFleetAttachments,
  resolveFleetImages,
} from "./fleet-files.js";
import type { ChunkedUploadSessions } from "../../file-upload/index.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
  type CreateAgentFromMcpInput,
} from "../create-agent/create.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { canonicalProviderModel } from "@getpaseo/protocol/provider-model";
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
  startAgentRun,
  waitForAgentRunStartWithTimeout,
} from "../agent-prompt.js";
import { setupFinishNotification } from "../finish-watches.js";
import { buildAgentPrompt, renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { stripAgentNamePrefix } from "../../mission-control/spawn-title.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import {
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { registerPageTools } from "../../page-tools/tools.js";
import type { PagePreviewBrowser } from "../../page-tools/preview-browser.js";
import type { PageStore } from "../../page-tools/page-store.js";
import { buildPeerUnreachableError, type PeerManager } from "../../peers/peer-manager.js";
import { registerDocThreadTools } from "../../doc-threads/tools.js";
import type { DocThreadsService } from "../../doc-threads/service.js";
import { registerFleetControlTools } from "./fleet-control-tools.js";
import { registerFleetUnarchiveTools } from "./fleet-unarchive-tools.js";
import {
  executeFleetToolOnPeer,
  readCurrentTurn,
  registerFleetWaitTools,
  resolvePromptedTurn,
} from "./fleet-wait.js";
import type { MissionControlProposalSpawnPlan } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import { MissionControlModelsSchema } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlModels } from "@getpaseo/protocol/mission-control/types";
import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import {
  buildSplitMetaPlan,
  resolveMetaTargetHost,
  type SplitMetaToolArgs,
} from "../../mission-control/fleet-meta.js";
import type { ResolvedMetaTarget } from "../../mission-control/meta-actions.js";
import { scheduleAgentSelfMove } from "./self-move.js";
import type { MissionControlService } from "../../mission-control/service.js";
import {
  buildFleetContextData,
  buildLocalModels,
  OMP_MODEL_ROLES_KEY,
  resolveDefaultWorkerModel,
} from "../../mission-control/context.js";
import { MissionControlReportStatusInputSchema } from "@getpaseo/protocol/mission-control/types";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { FleetIdIndex } from "../../mission-control/fleet-id-index.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "./types.js";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { RoutingService } from "../../routing/routing-service.js";
import type { MemoryService } from "../../memory/service.js";
import { registerMemoryTools } from "./memory-tools.js";
import { fillPlacement } from "./placement-fill.js";
import { AGENT_MODE_IDS, type AgentModeId } from "@getpaseo/protocol/agent-modes";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";

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
  /** Broadcast an agent's removal to every session (cross-host move source). */
  emitAgentRemoved?: (agentId: string) => Promise<void>;
  /**
   * Restore an archived workspace like the app's Restore (record, project, a
   * worktree Paseo removed) and publish it. Absent → fleet_unarchive_* cannot
   * restore on this host.
   */
  restoreWorkspace?: (workspaceId: string) => Promise<void>;
  /** Push a stored (not live) agent record to every session. */
  emitStoredAgentUpdate?: (record: StoredAgentRecord) => Promise<void>;
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
  /** Page tools (`show_page`, `preview_page`) are registered only when both are present. */
  pagePreviewBrowser?: PagePreviewBrowser | null;
  pageStore?: PageStore | null;
  peerManager?: PeerManager | null;
  missionControlService?: MissionControlService | null;
  itsaplanTicketize?: {
    ticketizeAgent: (
      agentId: string,
      options?: { ticket?: string; ask?: string },
    ) => Promise<{ issueId: number; url: string } | { error: string }>;
  } | null;
  resolveDocThreads?: (() => DocThreadsService) | null;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  paseoHome?: string;
  /** Daemon-wide chunked uploads behind fleet_upload_file; absent → the tool is not offered. */
  chunkedUploads?: ChunkedUploadSessions | null;
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
  fleetIdIndex?: FleetIdIndex | null;
  /** Placement routing (suggest_placement). Absent → the tool is not offered. */
  routingService?: RoutingService | null;
  /** fleet-memory (memory_search/get/write, fleet_playbook). Absent → not offered. */
  memoryService?: MemoryService | null;
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

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
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
  const providerInput = canonicalProviderModel(params.provider?.trim() || params.defaultProvider);
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
  const providerInput = params.provider ? canonicalProviderModel(params.provider) : undefined;
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

/**
 * Token filter for fleet_list_inventory, same convention as
 * matchesHistorySearch: every whitespace-separated token must appear as a
 * case-insensitive substring in at least one of the candidate fields (project
 * title/id, workspace title/id/cwd, host name/alias). A caller passes the
 * already-lowercased tokens so the query is normalized once.
 */
function matchesFleetInventoryQuery(
  tokens: readonly string[],
  ...fields: Array<string | null | undefined>
): boolean {
  const haystack = fields
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (haystack.length === 0) {
    return false;
  }
  return tokens.every((token) => haystack.some((field) => field.includes(token)));
}

/** Agent id family: a bare UUID (fleet-unique). Titles and mcp_ ids never match. */
const AGENT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compact display id for candidate listings, e.g. "wks_a0fd…". */
function shortFleetId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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
  const { currentModeId } = await seedStoredTimeline(input);
  const rows = input.agentManager.fetchTimeline(input.agentId, {
    direction: "tail",
    limit: 0,
  }).rows;
  return {
    timeline: rows.map((row) => row.item),
    currentModeId,
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
 * closed agents without a buffered timeline report null. Stored (non-live)
 * agents have no live timeline to read — enrichment is best-effort
 * ("when one is known"), so they report null instead of failing the roster.
 */
function lastUserMessageFor(agentManager: AgentManager, agentId: string): string | null {
  let timeline: AgentTimelineItem[];
  try {
    timeline = agentManager.getTimeline(agentId);
  } catch {
    return null;
  }
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

interface SpawnPlanInput {
  host: string;
  provider: string;
  model: string | undefined;
  title?: string;
  summary: string;
  initialPrompt?: string;
  images?: Array<{ data: string; mimeType: string }>;
  cwd?: string;
  workspaceId?: string;
  settings?: {
    modeId?: string;
    agentMode?: AgentModeId;
    thinkingOptionId?: string;
    features?: Record<string, unknown>;
  };
  labels?: Record<string, string>;
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

const DISPATCH_BRANCH_FALLBACK = "dispatch";

/** Name a dispatch's branch after what was asked for, so the workspace is recognisable. */
function deriveDispatchBranchName(input: { title?: string; initialPrompt?: string }): string {
  return slugify(input.title ?? input.initialPrompt ?? "") || DISPATCH_BRANCH_FALLBACK;
}

/**
 * Every fleet_create_agent dispatch gets its own worktree. A caller opts out only by
 * naming an existing workspace or asking for isolation "local"; there is no
 * implicit "run in the shared checkout".
 *
 * branchName is set unconditionally because the peer path needs it:
 * CreateAgentWorktreeTarget requires `newBranch`, so a plan without a branch
 * name reached a peer host as a plain directory create and silently landed the
 * agent in the shared checkout. Local branch collisions are resolved by the
 * worktree service.
 */
function resolveSpawnWorktreePlan(input: {
  worktree?: SpawnPlanInput["worktree"];
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  workspaceId?: string;
  title?: string;
  initialPrompt?: string;
}): SpawnPlanInput["worktree"] | undefined {
  if (input.worktree) {
    return input.worktree;
  }
  if (input.workspaceId || input.isolation === "local") {
    return undefined;
  }
  return {
    action: "branch-off",
    ...(input.worktreeSlug ? { worktreeName: input.worktreeSlug } : {}),
    branchName: input.branchName ?? deriveDispatchBranchName(input),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
  };
}

function resolveSpawnPlanSettings(settings?: SpawnPlanInput["settings"]) {
  if (!settings) return {};
  return {
    ...(settings.modeId ? { mode: settings.modeId } : {}),
    ...(settings.agentMode ? { agentMode: settings.agentMode } : {}),
    ...(settings.thinkingOptionId ? { thinking: settings.thinkingOptionId } : {}),
    ...(settings.features ? { features: settings.features } : {}),
  };
}

/** The spawn plan fleet_create_agent executes on this host. */
function buildSpawnPlan(input: SpawnPlanInput): MissionControlProposalSpawnPlan {
  const {
    host,
    provider,
    model,
    title,
    summary,
    initialPrompt,
    images,
    cwd,
    workspaceId,
    settings,
    labels,
    isolation,
  } = input;
  const resolvedWorktree = resolveSpawnWorktreePlan(input);
  return {
    host,
    provider,
    ...(model ? { model } : {}),
    ...(title ? { title: stripAgentNamePrefix(title) ?? title } : {}),
    summary,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...resolveSpawnPlanSettings(settings),
    ...(labels ? { labels } : {}),
    ...(isolation ? { isolation } : {}),
    ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
  };
}

interface McpSpawnInput {
  serverId: string;
  host: string;
  provider: string;
  title?: string;
  initialPrompt?: string;
  images?: Array<{ data: string; mimeType: string }>;
  cwd?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  settings?: {
    model?: string | null;
    modeId?: string;
    agentMode?: AgentModeId;
    thinkingOptionId?: string;
    features?: Record<string, unknown>;
  };
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

/** The spawn plan fleet_create_agent executes for a remote MCP client on this host. */
export function buildMcpSpawnPlan(input: McpSpawnInput): MissionControlProposalSpawnPlan {
  const {
    host,
    provider,
    settings,
    title,
    initialPrompt,
    images,
    cwd,
    workspaceId,
    labels,
    isolation,
    baseBranch,
    branchName,
    worktreeSlug,
    worktree,
  } = input;
  const slash = provider.indexOf("/");
  const model = slash > 0 ? provider.slice(slash + 1) : (settings?.model ?? undefined);
  const cleanProvider = slash > 0 ? provider.slice(0, slash) : provider;
  return buildSpawnPlan({
    host,
    provider: cleanProvider,
    model,
    title,
    summary: `Spawn ${title ?? "an agent"} (${provider}) on ${host}`,
    initialPrompt,
    images,
    cwd,
    workspaceId,
    settings,
    labels,
    isolation,
    baseBranch,
    branchName,
    worktreeSlug,
    worktree,
  });
}

interface PeerCreateAgentSettings {
  modeId?: string;
  agentMode?: AgentModeId;
  thinkingOptionId?: string;
  features?: Record<string, unknown>;
}

export function buildPeerCreateAgentPayload(args: {
  provider: string;
  cwd?: string;
  workspaceId?: string;
  initialPrompt?: string;
  images?: Array<{ data: string; mimeType: string }>;
  title?: string;
  labels?: Record<string, string>;
  settings?: PeerCreateAgentSettings;
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  worktree?: SpawnPlanInput["worktree"];
}): CreateAgentRequestOptions {
  const { provider, cwd, workspaceId, initialPrompt, images, title, labels, settings } = args;
  const providerSlash = provider.indexOf("/");
  const resolvedWorktree = resolveSpawnWorktreePlan(args);
  return {
    provider: (providerSlash > 0 ? provider.slice(0, providerSlash) : provider) as AgentProvider,
    ...(providerSlash > 0 ? { model: provider.slice(providerSlash + 1) } : {}),
    cwd: cwd ?? ".",
    workspaceId,
    initialPrompt,
    ...(images && images.length > 0 ? { images } : {}),
    title,
    ...(labels && Object.keys(labels).length > 0 ? { labels: normalizeLabels(labels) } : {}),
    ...buildPeerWorktreeFields(resolvedWorktree),
    ...buildPeerCreateSettings(settings),
  };
}

/**
 * The worktree fields of a peer create. The `worktree` target and the legacy
 * `worktreeName` each create a worktree on the peer, so send exactly one: the
 * target when the plan names a branch, `worktreeName` only for a slug-only plan.
 */
function buildPeerWorktreeFields(
  plan: SpawnPlanInput["worktree"] | undefined,
): Pick<CreateAgentRequestOptions, "worktree" | "worktreeName"> {
  if (plan?.branchName) {
    return {
      worktree: {
        mode: "branch-off",
        newBranch: plan.branchName,
        ...(plan.baseBranch ? { base: plan.baseBranch } : {}),
      },
    };
  }
  if (plan?.worktreeName) {
    return { worktreeName: plan.worktreeName };
  }
  return {};
}

/** The create-request fields a peer derives from fleet_create_agent `settings`. */
function buildPeerCreateSettings(
  settings: PeerCreateAgentSettings | undefined,
): Pick<CreateAgentRequestOptions, "modeId" | "agentMode" | "thinkingOptionId" | "featureValues"> {
  if (!settings) return {};
  return {
    ...(settings.modeId ? { modeId: settings.modeId } : {}),
    ...(settings.agentMode ? { agentMode: settings.agentMode } : {}),
    ...(settings.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
    ...(settings.features ? { featureValues: settings.features } : {}),
  };
}

/**
 * Extra `createAgentCommand` MCP-input fields the `create_agent` tool derives
 * from the resolved placement and parsed settings/labels. Only attaches
 * `workspaceId` when no worktree is being created (a worktree creates its own
 * fresh workspace; passing both would attach the agent to the wrong one).
 */
function buildMcpCreateAgentInputExtras(input: {
  worktree: CreateAgentFromMcpInput["worktree"];
  workspaceId: string | undefined;
  settings?: {
    modeId?: string;
    agentMode?: AgentModeId;
    thinkingOptionId?: string;
    features?: Record<string, unknown>;
  };
  labels?: Record<string, string>;
}): Pick<
  CreateAgentFromMcpInput,
  "workspaceId" | "thinking" | "features" | "labels" | "agentMode"
> {
  const extras: Pick<
    CreateAgentFromMcpInput,
    "workspaceId" | "thinking" | "features" | "labels" | "agentMode"
  > = {};
  if (!input.worktree && input.workspaceId) {
    extras.workspaceId = input.workspaceId;
  }
  if (input.settings?.thinkingOptionId) {
    extras.thinking = input.settings.thinkingOptionId;
  }
  if (input.settings?.features) {
    extras.features = input.settings.features;
  }
  if (input.settings?.agentMode) {
    extras.agentMode = input.settings.agentMode;
  }
  if (input.labels) {
    extras.labels = input.labels;
  }
  return extras;
}

/**
 * The catalog's default fleet-id index: resolves ids against the local
 * registries and cached peer snapshots, with a fleet-context-backed refresh.
 * Callers may inject their own index via options.fleetIdIndex instead.
 */
function buildCatalogFleetIdIndex(
  options: PaseoToolHostDependencies,
  hostLabel: string,
): FleetIdIndex {
  const {
    agentManager,
    agentStorage,
    peerManager,
    providerSnapshotManager,
    daemonConfigStore,
    serverId,
    logger,
  } = options;
  return new FleetIdIndex({
    agentStorage,
    agentManager,
    workspaceRegistry: options.workspaceRegistry,
    projectRegistry: options.projectRegistry,
    peerManager,
    fleetContext: async () =>
      buildFleetContextData({
        agentManager,
        agentStorage,
        workspaceRegistry: (options.workspaceRegistry ?? { list: async () => [] }) as Pick<
          WorkspaceRegistry,
          "list"
        >,
        projectRegistry: (options.projectRegistry ?? { list: async () => [] }) as Pick<
          ProjectRegistry,
          "list"
        >,
        providerSnapshotManager,
        ...(peerManager ? { peerManager } : {}),
        daemonConfigStore:
          daemonConfigStore ?? ({ get: () => ({}) } as unknown as Pick<DaemonConfigStore, "get">),
        serverId: serverId ?? "",
        hostName: hostLabel,
        logger,
      }),
    logger,
  });
}

// Fleet-tool host normalization: "local", this daemon's own serverId /
// hostname / hostAlias (case-insensitive trim) all route to the LOCAL branch
// of a fleet tool; a peer name routes to the peer client. One shared resolver
// with the meta executor and the spawn executor — never a second fleet map
// interpretation.
function isFleetLocalTargetHelper(
  host: string,
  resolve: (host: string) => ResolvedMetaTarget,
): boolean {
  const resolved = resolve(host);
  return resolved.ok && resolved.kind === "local";
}

function catalogHostsMatch(
  hostA: string,
  hostB: string,
  isLocal: (host: string) => boolean,
): boolean {
  if (isLocal(hostA) && isLocal(hostB)) return true;
  return hostA.trim().toLowerCase() === hostB.trim().toLowerCase();
}

/** The caller agent's voice context (null when the caller is not a voice
 * session or no resolver is wired). */
function resolveCatalogCallerContext(
  callerAgentId: string | undefined,
  resolveCallerContext: ((callerAgentId: string) => VoiceCallerContext | null) | undefined,
): VoiceCallerContext | null {
  return callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;
}

const CREATED_AGENT_SCHEMA = z.object({ agentId: z.string() }).loose();

const ARCHIVE_PREVIEW_AGENT_SCHEMA = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    host: z.string(),
    status: z.string(),
    bucket: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    archivedAt: z.string().nullable().optional(),
  })
  .loose();

/** The roster field an archive target is matched on. */
const ARCHIVE_TARGET_FIELD: Partial<
  Record<MissionControlMetaPlan["action"], "id" | "workspaceId" | "projectId">
> = {
  archive_agent: "id",
  archive_workspace: "workspaceId",
  archive_project: "projectId",
};

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
  const isFleetLocalTarget = (host: string): boolean =>
    isFleetLocalTargetHelper(host, (h) =>
      resolveMetaTargetHost(
        {
          serverId: serverId ?? "",
          hostAlias: options.hostAlias,
          peerManager: peerManager ?? null,
        },
        h,
      ),
    );
  const hostsMatch = (hostA: string, hostB: string): boolean =>
    catalogHostsMatch(hostA, hostB, isFleetLocalTarget);
  const fleetIdIndex = options.fleetIdIndex ?? buildCatalogFleetIdIndex(options, hostLabel);
  const childLogger = logger.child({ module: "agent", component: "paseo-tool-catalog" });
  // Every createAgentCommand call in this catalog shares these. getWorkspace
  // makes a named workspace's directory authoritative over the caller's
  // (defaulted) cwd, so a workspaceId-only spawn lands in that workspace.
  const createAgentDependencies: CreateAgentCommandDependencies = {
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
    getWorkspace: async (workspaceId) => {
      const record = await options.workspaceRegistry?.get(workspaceId);
      return record ? { cwd: record.cwd, archivedAt: record.archivedAt } : null;
    },
  };
  const callerContext = resolveCatalogCallerContext(callerAgentId, resolveCallerContext);

  // Remote MCP clients (/mcp/fleet) act for a bot, not for an agent in this
  // daemon: their spawns are top-level, never children of a caller agent.
  const isMcpClient = callerLabels?.["paseo.mcp-client"] !== undefined;
  /**
   * Apply a meta plan directly on its host. Errors return as {ok:false} results.
   */
  const applyMeta = async (metaPlan: MissionControlMetaPlan): Promise<PaseoToolResult> => {
    if (!missionControlService) {
      throw new Error("Mission Control is not enabled on this host");
    }
    const result = await missionControlService.applyMetaPlanDirect(metaPlan);
    return {
      content: [],
      structuredContent: ensureValidJson(
        result.ok
          ? {
              ok: true,
              status: "applied",
              guidance: `Meta action applied on ${result.metaAppliedOnHost ?? hostLabel}.`,
            }
          : { ok: false, error: result.error },
      ),
    };
  };
  /**
   * Threaded file comments: every agent gets reply_to_thread, list_threads
   * and comment_on_file, scoped to the calling agent. Kept out of the
   * catalog body so createPaseoToolCatalog stays under the complexity budget.
   */
  const registerDocThreadToolsIfAvailable = (input: {
    registerTool: typeof registerTool;
    resolveDocThreads: PaseoToolHostDependencies["resolveDocThreads"];
    callerAgentId: string | undefined;
  }): void => {
    if (!input.resolveDocThreads) return;
    registerDocThreadTools({
      registerTool: input.registerTool,
      resolveService: input.resolveDocThreads,
      callerAgentId: input.callerAgentId,
    });
  };

  /**
   * The shared path for the split meta tools (and the fleet_meta alias): every
   * tool resolves its bare id, builds the metaPlan (buildSplitMetaPlan)
   * and applies it directly on its host. Output shape {ok, status, guidance?}.
   */
  /**
   * What an archive would take with it, read from the fleet roster: the agents
   * in the target (running ones flagged) so the caller can confirm first.
   */
  const previewArchive = async (metaPlan: MissionControlMetaPlan): Promise<PaseoToolResult> => {
    // includeArchived also returns agents whose provider is unavailable on
    // their host; those archive too, so the preview must list them.
    const listed = await toCatalog().executeTool("fleet_list_agents", {
      includeArchived: true,
      sinceHours: 24 * 30,
      limit: 200,
    });
    const roster = z
      .object({ agents: z.array(ARCHIVE_PREVIEW_AGENT_SCHEMA) })
      .parse(listed.structuredContent).agents;
    const field = ARCHIVE_TARGET_FIELD[metaPlan.action];
    const affected = field
      ? roster.filter((agent) => !agent.archivedAt && agent[field] === metaPlan.targetId)
      : [];
    const running = affected.filter((agent) => agent.status === "running").length;
    return {
      content: [],
      structuredContent: ensureValidJson({
        ok: true,
        status: "dry_run",
        wouldArchive: {
          action: metaPlan.action,
          targetId: metaPlan.targetId,
          targetLabel: metaPlan.targetLabel,
          agents: affected.map(({ id, title, host, status, bucket }) => ({
            id,
            title,
            host,
            status,
            bucket,
          })),
        },
        guidance:
          `Nothing was archived. ${affected.length} agent(s) would be archived` +
          (running > 0 ? `, ${running} of them running now (their runs stop)` : "") +
          ". Call again without dryRun to archive.",
      }),
    };
  };

  const runMetaGate = async (input: SplitMetaToolArgs & { toolName: string; dryRun?: boolean }) => {
    if (!missionControlService) {
      throw new Error("Mission Control is not enabled on this host");
    }
    const metaWorkspaceRegistry = options.workspaceRegistry;
    const metaProjectRegistry = options.projectRegistry;
    if (!metaWorkspaceRegistry || !metaProjectRegistry) {
      throw new Error(
        `${input.toolName} is unavailable: workspace/project registries are not configured on this daemon`,
      );
    }
    if (
      !isMcpClient &&
      input.action === "move_agent" &&
      callerAgentId &&
      input.targetId?.trim() === callerAgentId &&
      input.destination
    ) {
      const guidance = await scheduleAgentSelfMove(
        {
          agentManager,
          agentStorage,
          workspaceRegistry: metaWorkspaceRegistry,
          peerManager: peerManager ?? null,
          emitAgentRemove: options.emitAgentRemoved,
          emitWorkspaceUpdates: options.emitWorkspaceUpdatesForWorkspaceIds,
          resolveFleetId: (id) => fleetIdIndex.resolveFleetId(id),
          logger: childLogger,
        },
        { agentId: callerAgentId, workspaceId: input.destination },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ ok: true, status: "scheduled", guidance }),
      };
    }
    const metaPlan = await buildSplitMetaPlan(
      {
        serverId: serverId ?? "",
        hostAlias: options.hostAlias,
        peerManager: peerManager ?? null,
        lookup: {
          agentManager,
          agentStorage,
          workspaceRegistry: metaWorkspaceRegistry,
          projectRegistry: metaProjectRegistry,
        },
        resolveFleetId: (id) => fleetIdIndex.resolveFleetId(id),
        hostLabel,
      },
      input,
    );
    return input.dryRun ? previewArchive(metaPlan) : applyMeta(metaPlan);
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
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) {
      return;
    }
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
    agentMode?: AgentModeId;
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
          ...(params?.agentMode ? { agentMode: params.agentMode } : {}),
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
        ...(params?.agentMode ? { agentMode: params.agentMode } : {}),
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
    .refine((value) => canonicalProviderModel(value).includes("/"), {
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
  const PromptAgentModeInputSchema = z
    .enum(AGENT_MODE_IDS)
    .optional()
    .describe(
      "Agent mode for this prompt: solo (do it yourself), orchestrator, plan, research, review, debug. Applies from this prompt on; omit to keep the agent's current mode.",
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      agentMode: z
        .enum(AGENT_MODE_IDS)
        .optional()
        .describe(
          "How the agent works: solo (do it yourself, default), orchestrator, plan, research, review, debug. suggest_placement recommends one.",
        ),
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
    labels: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .transform((v) => (v ? normalizeLabels(v) : undefined))
      .describe("Labels to set on the agent"),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
    images: z
      .array(z.object({ data: z.string(), mimeType: z.string() }))
      .optional()
      .describe(
        "Native images to attach to the new agent's first prompt, same shape as composer paste. Use when the user or a ticket attached screenshots the worker should see.",
      ),
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
    mode: z
      .enum(["steer", "interrupt"])
      .optional()
      .describe(
        'Omit (default "steer"): a busy agent takes the prompt into its live turn without ' +
          'cancelling it. "interrupt": only when the user explicitly asked to cancel the running turn.',
      ),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
    agentMode: PromptAgentModeInputSchema,
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

  registerPageTools({
    registerTool,
    previewBrowser: options.pagePreviewBrowser,
    pageStore: options.pageStore,
    resolveCallerCwd: () =>
      callerAgentId ? (agentManager.getAgent(callerAgentId)?.cwd ?? null) : null,
  });

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
          .describe(
            "Local directory or source checkout. Defaults to your current workspace. Local isolation adopts an existing directory and never creates one.",
          ),
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
        if (!(await isExistingDirectory(cwd))) {
          throw new Error(`Directory not found: ${cwd}`);
        }
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
      } = await createAgentCommand(createAgentDependencies, {
        kind: "mcp",
        provider: parsedArgs.provider,
        title: parsedArgs.title,
        initialPrompt: parsedArgs.initialPrompt,
        ...(parsedArgs.images && parsedArgs.images.length > 0 ? { images: parsedArgs.images } : {}),
        config: inheritedConfig,
        cwd: resolvedArgs.cwd,
        ...buildMcpCreateAgentInputExtras({
          worktree: resolvedArgs.worktree,
          workspaceId: resolvedArgs.workspaceId,
          settings: parsedArgs.settings,
          labels: parsedArgs.labels,
        }),
        mode: parsedArgs.settings?.modeId,
        background: requestedBackground,
        notifyOnFinish,
        detached: resolvedArgs.detached,
        callerAgentId,
        callerContext,
        worktree,
      });

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

  const PROMPTED_AGENT_NOTIFICATION_GUIDANCE =
    "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.";

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Always use the default mode steer: a busy agent takes the " +
        "prompt into its live turn without cancelling it. Pass interrupt only when the user explicitly " +
        "asked to cancel the running turn. Agent-scoped callers run in background by default; " +
        "top-level callers wait for the agent to finish by default.",
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
      mode = "steer",
      sessionMode,
      agentMode,
      background = Boolean(callerAgentId),
      notifyOnFinish = Boolean(callerAgentId),
    }) => {
      function armFinishNotification(): boolean {
        if (!callerAgentId || !notifyOnFinish) {
          return false;
        }
        setupFinishNotification({
          agentManager,
          agentStorage,
          childAgentId: agentId,
          callerAgentId,
          logger: childLogger,
        });
        return true;
      }

      // Agent-originated (Commander/Verifier/worker) sends that supersede a
      // busy run are machinery-originated: the superseded run keeps the
      // failure treatment, never reads as a user interruption. A steer that
      // falls back to replacing the turn carries the same origin through
      // replaceOrigin.
      if (mode === "interrupt" && agentManager.hasInFlightRun(agentId)) {
        missionControlService?.recordStopOrigin(agentId, "machinery");
      }
      const { disposition } = await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        replaceOrigin: "machinery",
        ...(mode === "steer" ? { activeTurnBehavior: "steer" as const } : {}),
        sessionMode,
        ...(agentMode ? { agentMode } : {}),
        logger: childLogger,
      });

      // If not running in background, wait for completion
      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });
        // The wait ran out while the agent keeps working, so its result arrives as a
        // finish notification instead of in this response.
        const notifying =
          result.timedOut &&
          agentManager.getAgent(agentId)?.lifecycle === "running" &&
          armFinishNotification();

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
          ...(notifying ? { guidance: PROMPTED_AGENT_NOTIFICATION_GUIDANCE } : {}),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }

      const notifying = armFinishNotification();

      // Return once the provider has accepted the turn, so the status reports it running.
      if (disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(agentManager, agentId);
      }
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
        ...(notifying ? { guidance: PROMPTED_AGENT_NOTIFICATION_GUIDANCE } : {}),
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
      // Remote MCP clients see the whole host; agents default to their own
      // workspace subtree. An explicit `cwd` argument always filters.
      const callerCwd = callerAgentId && !isMcpClient ? resolveCallerAgent()?.cwd : undefined;
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
        labels: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .transform((v) => (v ? normalizeLabels(v) : undefined))
          .describe("Labels to set on the agent"),
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
        agentMode: z
          .enum(AGENT_MODE_IDS)
          .optional()
          .describe(
            "Agent mode for each scheduled agent: solo (do it yourself, default), orchestrator, plan, research, review, debug.",
          ),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({
      prompt,
      cron,
      timezone,
      name,
      provider,
      cwd,
      isolation,
      agentMode,
      maxRuns,
      expiresIn,
    }) => {
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
        target: resolveNewAgentScheduleTarget({ provider, cwd, isolation, agentMode }),
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
      const visibleModels = daemonConfigStore?.get().visibleModels;
      const filteredModels =
        visibleModels && visibleModels.length > 0
          ? models.filter((model) => visibleModels.includes(`${provider}:${model.id}`))
          : models;
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models: filteredModels,
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
        'Silence between milestones; never send progress updates. Send "completed" only when everything asked is conclusively done — back ' +
        'completion claims with proofs. When you are blocked on a decision, send "blocked". Use the optional "kind" field ' +
        "(finding, fix, milestone, decision, progress) to flavor the card. " +
        "Prefer hub-wait over sleep/timeout polling loops. Rate limited to one report per minute per agent. " +
        "Identity rules: description is a living 2-3 sentence 'what this agent is doing now' — send a FRESH description on EVERY report " +
        "(replaced, never appended, under ~400 characters); the daemon nags when your record lacks one. Title is WRITE-ONCE: your record " +
        "already has one (frozen at registration) — never resend or retitle it; a title sent when the record has one is ignored with the " +
        "notice 'title is fixed; description updated', and the only rename path is fleet_rename_agent_title. Send title ONLY as backfill " +
        "when the daemon tells you the record has none. The result echoes your stored title/description only when they drifted from what " +
        "you sent (changed externally), and carries a notice when your title was ignored or your description is missing.",
      inputSchema: MissionControlReportStatusInputSchema.extend({
        headline: z
          .string()
          .max(120)
          .describe("Plain-language headline, at most 120 characters, no markdown."),
        learnings: z
          .array(
            z.object({
              title: z
                .string()
                .trim()
                .min(3)
                .max(120)
                .describe("Topic, e.g. 'notifyOnFinish callbacks'."),
              body: z
                .string()
                .trim()
                .min(1)
                .describe("What to remember; cite tickets, PRs, commits."),
              kind: z
                .enum(["decision", "fact", "howto", "owner", "runbook", "preference", "learning"])
                .optional(),
            }),
          )
          .max(5)
          .optional()
          .describe(
            "With status completed: reusable learnings and decisions from this run. Each becomes a fleet " +
              "memory note (same title → an update). Skip routine details; never include secrets.",
          ),
      }),
      outputSchema: {
        ok: z.boolean(),
        eventId: z.string().optional(),
        reason: z.string().optional(),
        error: z.string().optional(),
        // Additive guidance: frozen-title notice or missing-description nag.
        notice: z.string().optional(),
        // Learnings queued for fleet memory (vault notes).
        learningsQueued: z.number().optional(),
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
      const { learnings, ...report } = input;
      const result = await missionControlService.reportSelfStatus(callerAgentId, report);
      let learningsQueued = 0;
      if (result.ok && learnings?.length && options.memoryService) {
        const agentName = (await options.agentStorage.get(callerAgentId))?.name;
        for (const learning of learnings) {
          const queued = options.memoryService.queueNote({
            title: learning.title,
            body: learning.body,
            kind: learning.kind ?? "learning",
            about: { agent: callerAgentId },
            source: {
              agent_id: callerAgentId,
              ...(agentName ? { agent_name: agentName } : {}),
              host: options.hostAlias ?? "local",
            },
          });
          if (queued) learningsQueued += 1;
        }
      }
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
          ...(learningsQueued > 0 ? { learningsQueued } : {}),
          // Additive guidance: frozen-title notice / missing-description nag.
          ...(result.notice ? { notice: result.notice } : {}),
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
        .optional()
        .describe(
          "Target host: a peer name. Omit to let Paseo place the agent from the prompt (a host, " +
            "project, or model the prompt names wins; then the fleet rules). Derived from workspaceId when given.",
        ),
      ...canonicalTopLevelInputSchema,
      provider: ProviderModelInputSchema.optional().describe(
        "provider/model, e.g. omp/anthropic/claude-opus-5-5. Omit to use the model the prompt names, else the default.",
      ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Return the placement (host, cwd, isolation, model, agent mode, alternatives) without creating anything.",
        ),
      ticket: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "The agent's itsaplan ticket: \"new\" creates one on the project's board, a key like PASEO-71 links " +
            "an existing one. Omit for a one-off question (no ticket).",
        ),
      ask: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Vaibhav's ask, verbatim. With ticket, it is commented on the ticket (and is a new ticket's description).",
        ),
      workspaceId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Existing workspace id (wks_…) to place the agent in — fleet-wide, no host needed. " +
            "When provided, host is derived automatically.",
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory on the target host. Required when targeting a peer without workspaceId.",
        ),
      isolation: z
        .enum(["local", "worktree"])
        .optional()
        .describe(
          "Workspace isolation: 'worktree' creates a new git worktree workspace (default for git checkouts when workspaceId is omitted); 'local' uses the directory directly.",
        ),
      baseBranch: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Base branch/ref for a new worktree. Defaults to the repository default branch."),
      branchName: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional branch name for the new worktree."),
      worktreeSlug: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional worktree directory slug."),
      worktree: z
        .object({
          worktreeName: z.string().optional(),
          branchName: z.string().optional(),
          baseBranch: z.string().optional(),
          refName: z.string().optional(),
          action: z.enum(["branch-off", "checkout"]).optional(),
          githubPrNumber: z.number().optional(),
        })
        .optional(),
      images: z
        .array(FleetImageInputSchema)
        .optional()
        .describe(
          "Native images for the new agent's first prompt: inline {data, mimeType} (base64) or {fileId} from fleet_upload_file. Use when the user or a ticket attached screenshots the worker should see.",
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
      .describe(
        "Explicit recency window in hours; windows every returned row. Omitted: filtered calls (bucket/statuses/query) are unwindowed over the 30-day retention; the plain roster always shows needs_you/running/ready and trims done/idle rows to 48h.",
      ),
    statuses: z
      .array(z.enum(["initializing", "idle", "running", "error", "closed"]))
      .optional()
      .describe(
        "Filter to these agent lifecycle statuses: initializing, idle, running, error, closed.",
      ),
    bucket: z
      .enum(["needs_you", "running", "ready", "done", "idle"])
      .optional()
      .describe(
        "Filter to rows in this lifecycle bucket (closed enum): needs_you, running, ready, done, idle.",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "Fuzzy agent-name resolution: case-insensitive token/substring match against agent name, title, and id. Omitted → all agents.",
      ),
    limit: z.number().int().positive().max(200).optional().default(50),
  };

  const fleetAgentListItemSchema = AgentListItemPayloadSchema.extend({
    host: z.string(),
    // Roster enrichment: the agent's last report_status headlines (cap 5,
    // oldest -> newest) and its last non-system user message, when known.
    reportStatus: z.array(z.string()).max(5).optional(),
    lastUserMessage: z.string().nullable().optional(),
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

  /** The hosts this daemon knows, for host-hint mismatch errors (spec 03). */
  const knownFleetHostsText = (): string => {
    const peers = peerManager?.getPeerStatuses().map((status) => status.name) ?? [];
    return ["local", ...peers].join(", ");
  };

  /**
   * Error-contract guidance for a UUID-shaped but unknown agent (spec 03):
   * the rejection names live candidates on this host and the resolver tool,
   * so the model self-corrects in one step.
   */
  const buildUnknownAgentError = async (agentId: string): Promise<string> => {
    const candidates: string[] = [];
    try {
      for (const agent of agentManager.listAgents()) {
        if (agent.id === agentId) {
          continue;
        }
        candidates.push(agent.name ?? agent.id);
        if (candidates.length >= 3) {
          break;
        }
      }
    } catch {
      // Candidate collection is best-effort; never mask the unknown-agent error.
    }
    if (candidates.length < 3) {
      try {
        const records = await agentStorage.list();
        for (const record of records) {
          if (record.internal || record.id === agentId || candidates.length >= 3) {
            continue;
          }
          candidates.push(record.name ?? record.title ?? record.id);
        }
      } catch {
        // Best-effort, same as above.
      }
    }
    const nearest =
      candidates.length > 0
        ? ` Nearest agents on this host: ${candidates.map((name) => `'${name}'`).join(", ")}.`
        : "";
    return (
      `Agent ${shortFleetId(agentId)} not found on any reachable host.` +
      `${nearest} Call fleet_list_agents(query) to resolve the agent id.`
    );
  };

  /**
   * Call-time spawn-target validation (spec 03): the workspace must be a live
   * wks_* on the resolved host, cwd must be absolute, and the peer reachable —
   * all BEFORE a proposal is created, so a bad spawn is rejected with
   * candidates the model can act on in one step. The approval-time checks
   * (spawn-executor / create-agent) stay as the second line of defense.
   */
  const buildLiveWorkspaceCandidates = async (
    registry: Pick<WorkspaceRegistry, "list">,
  ): Promise<string> => {
    const workspaces = await registry.list();
    const live = workspaces.filter((workspace) => !workspace.archivedAt);
    if (live.length === 0) {
      return "no live workspaces on this host";
    }
    return live
      .map((workspace) => `${shortFleetId(workspace.workspaceId)} '${workspace.displayName}'`)
      .join(", ");
  };

  const validateSpawnTargetAtCallTime = async (input: {
    host: string;
    cwd?: string;
    workspaceId?: string;
    workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list"> | null;
  }): Promise<void> => {
    const { host, cwd, workspaceId } = input;
    // The host that runs the agent creates a missing cwd, so it must be absolute.
    if (cwd && !isAbsolute(cwd)) {
      throw new Error(`Spawn cwd must be an absolute path (got "${cwd}")`);
    }
    if (!isFleetLocalTarget(host)) {
      // Peer target: reachability throws for offline/unconfigured hosts; the
      // workspace must be live on the peer's own registry.
      const client = resolveFleetHost(host);
      if (!client) {
        throw new Error(
          `Host "${host}" is not a configured peer; this daemon knows: ${knownFleetHostsText()}`,
        );
      }
      if (!workspaceId) {
        return;
      }
      const payload = await client.fetchWorkspaces({ page: { limit: 200 } });
      const entry = payload.entries.find((candidate) => candidate.id === workspaceId);
      if (!entry) {
        const live = payload.entries.filter((candidate) => !candidate.archivingAt);
        const candidates =
          live.length > 0
            ? live
                .map(
                  (candidate) =>
                    `${shortFleetId(candidate.id)} '${candidate.title ?? candidate.name}'`,
                )
                .join(", ")
            : "no live workspaces on this host";
        throw new Error(
          `workspace not found: ${workspaceId} is not a live workspace on host "${host}"; available workspaces: ${candidates}`,
        );
      }
      if (entry.archivingAt) {
        const live = payload.entries.filter((candidate) => !candidate.archivingAt);
        throw new Error(
          `workspace ${workspaceId} is archived; pick a live workspace on host "${host}": ${
            live.length > 0
              ? live
                  .map(
                    (candidate) =>
                      `${shortFleetId(candidate.id)} '${candidate.title ?? candidate.name}'`,
                  )
                  .join(", ")
              : "none"
          }`,
        );
      }
      return;
    }
    if (!workspaceId) {
      return;
    }
    const registry = input.workspaceRegistry;
    if (!registry) {
      return;
    }
    const workspace = await registry.get(workspaceId);
    if (!workspace) {
      const candidates = await buildLiveWorkspaceCandidates(registry);
      throw new Error(
        `workspace not found: ${workspaceId} is not a live workspace on host "${hostLabel}"; available workspaces: ${candidates}`,
      );
    }
    if (workspace.archivedAt) {
      const candidates = await buildLiveWorkspaceCandidates(registry);
      throw new Error(`workspace ${workspaceId} is archived; pick a live workspace: ${candidates}`);
    }
  };

  registerTool(
    "fleet_list_agents",
    {
      title: "List agents across hosts",
      description:
        "List agents on this daemon and every reachable peer host, tagged with the host each agent runs on. " +
        "Unreachable hosts are omitted; use mission_control.peers.list or the board for host status. " +
        "bucketCounts is always fleet truth over the full 30-day retention. Filtered calls (bucket/statuses/query) " +
        "return unwindowed rows; the plain roster always shows needs_you/running/ready rows and trims done/idle rows to 48h.",
      inputSchema: fleetListAgentsInputSchema,
      outputSchema: {
        agents: z.array(fleetAgentListItemSchema),
        // Closed loop: the applied row window, the pre-limit match count, and
        // full-retention bucket counts ride the result so answers never state
        // a windowed count as fleet truth.
        appliedSinceHours: z.number(),
        totalMatches: z.number(),
        bucketCounts: z.record(z.string(), z.number()),
        // Hosts whose agents are missing from this roster (down or not
        // answering). Empty when every peer answered.
        warnings: z.array(z.string()),
      },
    },
    async ({ includeArchived = false, sinceHours, statuses, bucket, query, limit = 50 }) => {
      // One window model for every roster surface (user decision 2026-08-17):
      // - The candidate set is ALWAYS the full 30-day retention, so the
      //   payload's `bucketCounts` is fleet truth on every call.
      // - Filtered calls (bucket/statuses/query) are deterministic lookups:
      //   rows are unwindowed unless the caller passes sinceHours.
      // - The plain roster windows only the collapsible buckets: needs_you/
      //   running/ready rows always show; done/idle rows only from the last
      //   48h. (A silent 48h window on a bucket call once turned 21 ready
      //   agents into a spoken "13 agents ready for review".)
      const RETENTION_HOURS = 24 * 30;
      const PLAIN_BULK_WINDOW_HOURS = 48;
      const isFiltered = Boolean(bucket || query || (statuses && statuses.length > 0));
      // Statuses filter is applied post-hoc (not at fetch) so bucketCounts
      // never shrinks to the caller's status subset.
      const localResult = await toCatalog().executeTool("list_agents", {
        includeArchived,
        sinceHours: RETENTION_HOURS,
        limit: 200,
      });
      const localAgents = z
        .object({ agents: z.array(AgentListItemPayloadSchema) })
        .parse(localResult.structuredContent).agents;
      // Roster enrichment: each row gains the agent's last report_status
      // headlines (cap 5, oldest -> newest) and its last non-system user
      // message when one is known. Local rows read the local store + live
      // timeline; peer rows fetch one events payload per host. Placement
      // (workspaceId/projectId/serverId) rides on the snapshot restore;
      // projectId and serverId resolve from the host registries below.
      const localReports = collectReportStatusHeadlines(missionControlService?.fetchEvents() ?? []);
      const agents: Array<
        AgentListItemPayload & {
          host: string;
          reportStatus?: string[];
          lastUserMessage?: string | null;
        }
      > = [];
      // workspaceId -> projectId for LOCAL rows (the workspace registry the
      // agent actually lives in; peer rows resolve projectId via the resolver).
      let localWorkspaceProject: Map<string, string> | null = null;
      if (options.workspaceRegistry) {
        const workspaces = await options.workspaceRegistry.list();
        localWorkspaceProject = new Map(
          workspaces.map((workspace) => [workspace.workspaceId, workspace.projectId]),
        );
      }
      const localServerId = serverId ?? "";
      // Canonical lifecycle bucket (spec 03): the snapshot pipeline stamps it
      // once the owning daemon computes it; until then (or when the service is
      // unavailable) the row simply omits it — a bucket filter never matches
      // a bucket-less row. This fallback covers local rows when the snapshot
      // pipeline has not stamped one yet.
      const getLocalBucket =
        typeof missionControlService?.getLifecycleBucket === "function"
          ? (agentId: string) => missionControlService.getLifecycleBucket(agentId)
          : null;
      // Local rows: roster enrichment (report headlines, last user message),
      // project attribution from the local workspace registry, serverId, and
      // the canonical bucket fallback when the snapshot pipeline has not
      // stamped one yet.
      const appendLocalRosterRows = async (): Promise<void> => {
        for (const agent of localAgents) {
          const reports = localReports.get(agent.id);
          const extra: Record<string, unknown> = {};
          if (agent.workspaceId && localWorkspaceProject?.has(agent.workspaceId)) {
            extra.projectId = localWorkspaceProject.get(agent.workspaceId);
          }
          if (localServerId) {
            extra.serverId = localServerId;
          }
          if (!agent.bucket && getLocalBucket) {
            extra.bucket = await getLocalBucket(agent.id);
          }
          if (reports) {
            extra.reportStatus = reports;
          }
          agents.push({
            ...agent,
            host: hostLabel,
            ...extra,
            lastUserMessage: lastUserMessageFor(agentManager, agent.id),
          });
        }
      };
      // Peer rows: one events payload per host for the report-status
      // headlines, plus the peer's serverId when the peer map knows it.
      const peerWarnings: string[] = [];
      const appendPeerRosterRows = async (): Promise<void> => {
        if (!peerManager) {
          return;
        }
        const sinceMs = Date.now() - RETENTION_HOURS * 60 * 60 * 1000;
        // Peer host identity: the serverId of the host each agent runs on
        // (absent when the peer map does not know it yet — additive).
        const getPeerServerId =
          typeof peerManager.getPeerServerId === "function"
            ? (name: string) => peerManager.getPeerServerId(name)
            : null;
        for (const peerStatus of peerManager.getPeerStatuses()) {
          if (peerStatus.state !== "online") {
            peerWarnings.push(
              buildPeerUnreachableError(peerStatus.name, peerStatus.lastSeenAt).message,
            );
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
            const peerServerId = getPeerServerId?.(peerStatus.name) ?? null;
            for (const agent of peerAgents) {
              const reports = peerReports.get(agent.id);
              agents.push({
                ...agent,
                ...(peerServerId ? { serverId: peerServerId } : {}),
                ...(reports ? { reportStatus: reports } : {}),
              });
            }
          } catch (error) {
            childLogger.warn(
              { err: error, peer: peerStatus.name },
              "Failed to list agents on peer",
            );
            peerWarnings.push(
              `Host "${peerStatus.name}" did not answer (${error instanceof Error ? error.message : String(error)}); its agents are not included.`,
            );
          }
        }
      };
      await appendLocalRosterRows();
      await appendPeerRosterRows();

      // Roster filters (spec 03): raw statuses, an optional lifecycle bucket
      // (closed enum), and a fuzzy agent-name query — the resolver for spoken
      // agent names. Rows without a bucket (pre-bucket daemons) never match a
      // bucket filter and are absent from bucketCounts.
      const queryTokens = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hasQuery = queryTokens.length > 0;
      const statusFilter = statuses && statuses.length > 0 ? new Set<string>(statuses) : null;
      // Fleet truth: bucket counts over the whole retained candidate set,
      // before any caller filter or row window.
      const bucketCounts: Record<string, number> = {};
      for (const agent of agents) {
        if (agent.bucket) {
          bucketCounts[agent.bucket] = (bucketCounts[agent.bucket] ?? 0) + 1;
        }
      }
      const rowWindowHours = sinceHours ?? (isFiltered ? RETENTION_HOURS : PLAIN_BULK_WINDOW_HOURS);
      const rowCutoffMs = Date.now() - rowWindowHours * 60 * 60 * 1000;
      const withinWindow = (updatedAt: string): boolean => Date.parse(updatedAt) >= rowCutoffMs;
      // Buckets you act on are never windowed out of a plain roster; only the
      // collapsible bulk (done/idle/bucketless) rows are recency-trimmed.
      const ALWAYS_SHOWN_BUCKETS: Record<string, true> = {
        needs_you: true,
        running: true,
        ready: true,
      };
      const filtered = agents
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !bucket || agent.bucket === bucket)
        .filter(
          (agent) =>
            !hasQuery || matchesFleetInventoryQuery(queryTokens, agent.name, agent.title, agent.id),
        )
        .filter((agent) => {
          if (sinceHours !== undefined || isFiltered) {
            // Explicit window, or a deterministic lookup (default: unwindowed).
            return withinWindow(agent.updatedAt);
          }
          return (
            (agent.bucket && ALWAYS_SHOWN_BUCKETS[agent.bucket] === true) ||
            withinWindow(agent.updatedAt)
          );
        });

      filtered.sort(compareAgentListItems);
      return {
        content: [],
        structuredContent: ensureValidJson({
          agents: filtered.slice(0, limit),
          appliedSinceHours: rowWindowHours,
          totalMatches: filtered.length,
          bucketCounts,
          warnings: peerWarnings,
        }),
      };
    },
  );

  registerTool(
    "fleet_list_models",
    {
      title: "List models on a host",
      description:
        "List the invocable provider/model strings available on a host ('local' or a peer name), plus that host's " +
        "default worker model — the composer's last provider/model pick (daemon.composerPreferences) when set, else " +
        "the omp task role resolved to an invocable provider/model, falling back to the first available model when " +
        "the role's model is missing from the snapshot. host is optional and defaults to this daemon. Read-only; never gated.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe(
            "Target host: a peer name from the daemon peers config, or 'local' for this daemon. Omitted → this daemon.",
          ),
      },
      outputSchema: {
        host: z.string(),
        models: MissionControlModelsSchema,
        defaultWorkerModel: z.string().nullable(),
      },
    },
    async ({ host }) => {
      const target = host?.trim() || "local";
      const local = isFleetLocalTarget(target);
      let models: MissionControlModels;
      let composerPreferences: ComposerPreferences | undefined;
      if (local) {
        // Same models + default-worker derivation the world snapshot uses —
        // one implementation shared by the Commander and Voice. The composer's
        // last pick (daemon.composerPreferences) outranks the omp task role.
        models = await buildLocalModels({ providerSnapshotManager, daemonConfigStore });
        const visibleModels = daemonConfigStore?.get().visibleModels;
        if (visibleModels && visibleModels.length > 0) {
          const visibleSet = new Set(visibleModels);
          const filtered: MissionControlModels = {};
          for (const [providerName, modelIds] of Object.entries(models)) {
            if (providerName === OMP_MODEL_ROLES_KEY) {
              filtered[providerName] = modelIds;
              continue;
            }
            const matching = modelIds.filter((id) => visibleSet.has(`${providerName}:${id}`));
            if (matching.length > 0) {
              filtered[providerName] = matching;
            }
          }
          models = filtered;
        }
        composerPreferences = daemonConfigStore?.get().composerPreferences;
      } else {
        const client = resolveFleetHost(target);
        if (!client) {
          throw new Error(`Host "${target}" is not a configured peer`);
        }
        const payload = await client.missionControlContextFetch();
        models = payload.models;
        composerPreferences = payload.composerPreferences;
      }
      const { invocable } = resolveDefaultWorkerModel(models, composerPreferences);
      return {
        content: [],
        structuredContent: ensureValidJson({
          host: local ? hostLabel : target,
          models,
          defaultWorkerModel: invocable,
        }),
      };
    },
  );

  registerMemoryTools({
    registerTool,
    memoryService: options.memoryService,
    callerAgentId,
    resolveAgentName: async (agentId) => (await options.agentStorage.get(agentId))?.name ?? null,
    hostLabel,
  });

  registerTool(
    "fleet_list_inventory",
    {
      title: "List fleet hosts, projects, and workspaces",
      description:
        "THE resolver: resolve any spoken project/workspace name before acting; act only on returned ids. " +
        "Lists every project and workspace across this daemon and its peers, grouped by host. " +
        "query is a case-insensitive fuzzy filter (project title/id, workspace title/id/cwd, host " +
        "name/alias) for resolving a spoken name — a name is never assumed to be a " +
        "host. host restricts to one peer name or 'local'; omitted = every host. Unreachable hosts " +
        "appear with reachable:false and an empty project list. Every workspace row carries its " +
        "wks_ id, its prj_ project id, and its cwd path (a path is never emitted as an id). " +
        "Read-only; never gated.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Fuzzy filter: case-insensitive substring/token match against project title, project id, " +
              "workspace title, workspace id, cwd, host name, and host alias. Omitted → full inventory.",
          ),
        host: z
          .string()
          .optional()
          .describe(
            "Restrict to one host: a peer name from the daemon peers config, or 'local'. Omitted → all hosts.",
          ),
      },
      outputSchema: {
        hosts: z.array(
          z.object({
            host: z.string(),
            reachable: z.boolean(),
            projects: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                description: z.string().optional(),
                commanderInstructions: z.string().optional(),
                workspaces: z.array(
                  z.object({
                    id: z.string(),
                    title: z.string(),
                    kind: z.string(),
                    cwd: z.string(),
                  }),
                ),
              }),
            ),
          }),
        ),
      },
    },
    async ({ query, host }) => {
      // One shared fleet assembly — the same buildFleetContextData the
      // Commander snapshot uses, so the inventory is never fetched twice.
      const context = await buildFleetContextData({
        agentManager,
        agentStorage,
        workspaceRegistry: (options.workspaceRegistry ?? { list: async () => [] }) as Pick<
          WorkspaceRegistry,
          "list"
        >,
        projectRegistry: (options.projectRegistry ?? { list: async () => [] }) as Pick<
          ProjectRegistry,
          "list"
        >,
        providerSnapshotManager,
        ...(peerManager ? { peerManager } : {}),
        daemonConfigStore:
          daemonConfigStore ?? ({ get: () => ({}) } as unknown as Pick<DaemonConfigStore, "get">),
        serverId: serverId ?? "",
        // machineName is fleet-map display only and never surfaced by this
        // tool; the alias-or-local label stands in for the hostname.
        hostName: hostLabel,
        logger,
      });

      const tokens = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hasQuery = tokens.length > 0;

      let hosts = context.hosts;
      if (host) {
        const target = host.trim();
        if (isFleetLocalTarget(target)) {
          hosts = hosts.filter((entry) => entry.hostName === "local");
        } else {
          const peer = hosts.filter((entry) => entry.hostName === target);
          if (peer.length === 0) {
            throw new Error(
              `Host "${target}" is not a configured peer; this daemon knows: ${knownFleetHostsText()}`,
            );
          }
          hosts = peer;
        }
      }

      return {
        content: [],
        structuredContent: ensureValidJson({
          hosts: hosts.map((entry) => {
            const hostHit =
              hasQuery && matchesFleetInventoryQuery(tokens, entry.hostName, entry.alias);
            const projects: Array<{
              id: string;
              title: string;
              workspaces: Array<{ id: string; title: string; kind: string; cwd: string }>;
            }> = [];
            for (const project of entry.inventory.projects) {
              const projectHit = matchesFleetInventoryQuery(tokens, project.title, project.id);
              const workspaceHit = project.workspaces.some((workspace) =>
                matchesFleetInventoryQuery(tokens, workspace.title, workspace.id, workspace.cwd),
              );
              if (hasQuery && !hostHit && !projectHit && !workspaceHit) {
                continue;
              }
              // A host or project hit keeps the project whole (its workspaces
              // are the answer); a workspace-only hit narrows to the match.
              const workspaces =
                hostHit || projectHit
                  ? project.workspaces
                  : project.workspaces.filter((workspace) =>
                      matchesFleetInventoryQuery(
                        tokens,
                        workspace.title,
                        workspace.id,
                        workspace.cwd,
                      ),
                    );
              projects.push({
                id: project.id,
                title: project.title,
                ...(project.description ? { description: project.description } : {}),
                ...(project.commanderInstructions
                  ? { commanderInstructions: project.commanderInstructions }
                  : {}),
                workspaces: workspaces.map((workspace) => ({
                  id: workspace.id,
                  title: workspace.title,
                  kind: workspace.kind,
                  cwd: workspace.cwd,
                })),
              });
            }
            return {
              host: entry.hostName === "local" ? (entry.alias ?? "local") : entry.hostName,
              reachable: entry.reachable,
              projects,
            };
          }),
        }),
      };
    },
  );

  registerTool(
    "fleet_create_agent",
    {
      title: "Create agent on a host",
      description:
        "Create an agent in the fleet. Anything left out is placed from the prompt (host, project, " +
        "isolation, model, agent mode); a git project root always gets a fresh worktree. workspaceId puts it " +
        "in that existing workspace. dryRun returns the placement without creating anything. ticket links " +
        "or creates its itsaplan ticket, with ask commented on it.",
      inputSchema: fleetCreateAgentInputSchema,
      outputSchema: {
        agentId: z.string().optional(),
        type: AgentProviderEnum.optional(),
        status: AgentStatusEnum.optional(),
        cwd: z.string().optional(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable().optional(),
        availableModes: z.array(ProviderModeSchema).optional(),
        lastMessage: z.string().nullable().optional(),
        // The turn the initial prompt runs in; pass it to fleet_wait_agent.
        turnId: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        proposalId: z.string().optional(),
        guidance: z.string().optional(),
        ticket: z.record(z.string(), z.unknown()).optional(),
        ticketError: z.string().optional(),
        // dryRun: the placement that would be used; nothing is created.
        dryRun: z.boolean().optional(),
        plan: z.record(z.string(), z.unknown()).nullable().optional(),
      },
    },
    async (inputArgs, context) => {
      const { dryRun, ...requested } = inputArgs;
      const { args: rawArgs, plan: placementPlan } = await fillPlacement(
        options.routingService ?? null,
        requested,
        dryRun === true,
      );
      if (dryRun) {
        return {
          content: [],
          structuredContent: ensureValidJson({ dryRun: true, plan: placementPlan }),
        };
      }
      if (!rawArgs.provider) {
        throw new Error(
          "provider is required: no model named in the prompt and no default model configured",
        );
      }
      // fileId images become inline images here, so every path below (gate,
      // local create, peer create) carries bytes the target host can use.
      const resolvedImages = await resolveFleetImages(rawArgs.images, options.paseoHome);
      // Canonical once, so the gate, dedupe key, proposal card and the peer
      // payload (buildPeerCreateAgentPayload splits on "/" itself) all agree.
      const args = {
        ...rawArgs,
        provider: canonicalProviderModel(rawArgs.provider),
        images: resolvedImages,
      };
      const {
        host: rawHost,
        cwd,
        workspaceId,
        provider,
        initialPrompt,
        images,
        title,
        labels,
        settings,
        isolation,
        baseBranch,
        branchName,
        worktreeSlug,
        worktree,
        ticket,
        ask,
      } = args;
      // Resolve the spawn's target host: when workspaceId is present, host is
      // optional and derived from the workspace via the fleet index (a host
      // hint is validated against the workspace's actual host); otherwise the
      // host is required.
      const resolveSpawnTargetHost = async (): Promise<string> => {
        if (workspaceId) {
          const resolution = await fleetIdIndex.resolveFleetId(workspaceId);
          if (rawHost) {
            if (resolution.kind !== "unknown" && !hostsMatch(rawHost, resolution.host)) {
              const actualHost = resolution.host === "local" ? hostLabel : resolution.host;
              throw new Error(
                `Workspace "${workspaceId}" is on host "${actualHost}", not "${rawHost}"`,
              );
            }
            return rawHost;
          }
          if (resolution.kind === "unknown") {
            throw new Error(resolution.guidance);
          }
          return resolution.host;
        }
        if (!rawHost) {
          throw new Error(
            "host is required when workspaceId is omitted (a new worktree must land on a specific host)",
          );
        }
        return rawHost;
      };
      const host = await resolveSpawnTargetHost();
      // Fail fast (spec 03): the spawn target is validated at call time —
      // the workspace must be a live wks_* on the resolved host (candidates
      // listed on rejection), cwd absolute, and the peer reachable — before
      // any proposal is created. Approval-time checks stay as the second line.
      await validateSpawnTargetAtCallTime({
        host,
        cwd,
        workspaceId,
        workspaceRegistry: options.workspaceRegistry ?? null,
      });
      // A remote MCP client spawning on this host: run the spawn plan
      // (placement, worktree, settings) as a top-level agent. Delegating to
      // create_agent would make it a child of the calling agent.
      const createLocallyForMcpClient = async (): Promise<PaseoToolResult> => {
        const spawnPlan = buildMcpSpawnPlan({
          serverId: serverId ?? "",
          host,
          provider,
          title,
          initialPrompt,
          images,
          cwd,
          workspaceId,
          labels,
          settings,
          isolation,
          baseBranch,
          branchName,
          worktreeSlug,
          worktree,
        });
        const plan = spawnPlan;
        const { snapshot } = await createAgentCommand(createAgentDependencies, {
          kind: "mcp",
          provider,
          title: plan.title ?? "Agent",
          ...(plan.initialPrompt ? { initialPrompt: plan.initialPrompt } : {}),
          ...(plan.images && plan.images.length > 0 ? { images: plan.images } : {}),
          ...(plan.cwd ? { cwd: plan.cwd } : {}),
          ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
          ...(plan.thinking ? { thinking: plan.thinking } : {}),
          ...(plan.features ? { features: plan.features } : {}),
          ...(plan.labels ? { labels: plan.labels } : {}),
          ...(plan.mode ? { mode: plan.mode } : {}),
          agentMode: plan.agentMode,
          ...(plan.worktree ? { worktree: plan.worktree } : {}),
          ...(plan.isolation ? { isolation: plan.isolation } : {}),
          background: true,
          notifyOnFinish: false,
        });
        const turn = plan.initialPrompt
          ? await resolvePromptedTurn({
              agentManager,
              agentId: snapshot.id,
              previousTurnId: null,
              joinsCurrentTurn: false,
            })
          : null;
        return {
          content: [],
          structuredContent: ensureValidJson({
            agentId: snapshot.id,
            type: snapshot.provider,
            status: snapshot.lifecycle,
            cwd: snapshot.cwd,
            ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
            currentModeId: snapshot.currentModeId,
            availableModes: snapshot.availableModes,
            lastMessage: null,
            permission: null,
            turnId: turn?.turnId ?? null,
          }),
        };
      };
      // The agent's ticket: linked or created on the agent's host once it
      // exists, with Vaibhav's ask commented. A failure is reported, not thrown:
      // the agent is already running.
      const withTicket = async (created: PaseoToolResult): Promise<PaseoToolResult> => {
        const createdAgent = CREATED_AGENT_SCHEMA.safeParse(created.structuredContent);
        if (!ticket || created.isError || !createdAgent.success) return created;
        const ticketResult = await toCatalog()
          .executeTool("fleet_ticketize_agent", {
            agentId: createdAgent.data.agentId,
            host,
            ...(ticket === "new" ? {} : { ticket }),
            ...(ask ? { ask } : {}),
          })
          .then((result) => ({ ticket: result.structuredContent }))
          .catch((error: unknown) => ({ ticketError: String(error) }));
        return {
          ...created,
          structuredContent: ensureValidJson({ ...createdAgent.data, ...ticketResult }),
        };
      };
      if (isMcpClient && isFleetLocalTarget(host)) {
        return withTicket(await createLocallyForMcpClient());
      }
      if (isFleetLocalTarget(host)) {
        const { cwd: _cwd, ticket: _ticket, ask: _ask, ...localArgs } = args;
        return withTicket(await toCatalog().executeTool("create_agent", localArgs, context));
      }
      // Peer create path: the peer create RPC is the SESSION create path —
      // `provider` must be a plain provider id with `model` passed separately
      // (the local create_agent path splits "provider/model" itself).
      const createAgentOnPeerHost = async (): Promise<PaseoToolResult> => {
        const client = resolveFleetHost(host);
        if (!client) {
          throw new Error(
            `Host "${host}" is not a configured peer; this daemon knows: ${knownFleetHostsText()}`,
          );
        }
        if (!cwd && !workspaceId) {
          throw new Error(`cwd or workspaceId is required to place the agent on host "${host}"`);
        }
        if (settings?.agentMode) {
          assertPeerSupportsAgentModes(client, host);
        }
        const snapshot = await client.createAgent(buildPeerCreateAgentPayload(args));
        const turn = initialPrompt
          ? await resolvePromptedTurn({
              client,
              agentId: snapshot.id,
              previousTurnId: null,
              joinsCurrentTurn: false,
            })
          : null;
        const structuredContent = ensureValidJson({
          agentId: snapshot.id,
          type: snapshot.provider,
          status: snapshot.status,
          cwd: snapshot.cwd,
          ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
          lastMessage: null,
          permission: sanitizePermissionRequest(snapshot.pendingPermissions[0] ?? null),
          turnId: turn?.turnId ?? null,
        });
        return { content: [], structuredContent };
      };
      return withTicket(await createAgentOnPeerHost());
    },
  );

  registerTool(
    "fleet_get_agent_activity",
    {
      title: "Get agent activity",
      description:
        "Return recent agent timeline entries as a curated summary, on this daemon ('local') or a peer host. " +
        "agentId is fleet-wide; host is optional and resolved automatically via the fleet index. " +
        "Same shape as the local get_agent_activity tool; proxied over peering so any caller can read any " +
        "worker's timeline from its own host.",
      inputSchema: {
        agentId: z
          .string()
          .describe("Agent UUID from fleet_list_agents data — fleet-wide, no host needed."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
              "When omitted, resolved automatically via the fleet index.",
          ),
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
    async ({ host, agentId: requestedAgentId, limit }) => {
      // The index expands a short id to the full id; route with that.
      const resolution = await fleetIdIndex.resolveFleetId(requestedAgentId);
      const agentId = resolution.kind === "unknown" ? requestedAgentId : resolution.id;
      let targetHost = host;
      if (targetHost) {
        if (resolution.kind !== "unknown" && !hostsMatch(targetHost, resolution.host)) {
          const actualHost = resolution.host === "local" ? hostLabel : resolution.host;
          throw new Error(`Agent "${agentId}" is on host "${actualHost}", not "${targetHost}"`);
        }
      } else {
        if (resolution.kind === "unknown") {
          throw new Error(resolution.guidance);
        }
        targetHost = resolution.host;
      }
      if (isFleetLocalTarget(targetHost)) {
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
      const client = resolveFleetHost(targetHost);
      if (!client) {
        throw new Error(`Host "${targetHost}" is not a configured peer`);
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
    "fleet_send_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to an agent across the fleet. agentId is fleet-wide; host is optional and resolved " +
        "automatically via the fleet index. Returns immediately in every mode; it never waits for a busy " +
        'agent. Always use the default mode "steer": it wakes a closed or archived agent and runs the ' +
        "prompt, and on a busy agent it joins the live turn without cancelling it (OMP live-steer; a busy " +
        'non-OMP agent is interrupted so the message lands promptly). Pass "interrupt" only when the user ' +
        "explicitly asked to cancel the running turn and replace it.",
      inputSchema: {
        agentId: z
          .string()
          .describe("Agent UUID from fleet_list_agents data — fleet-wide, no host needed."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
              "When omitted, resolved automatically via the fleet index.",
          ),
        prompt: z.string(),
        mode: z
          .enum(["steer", "interrupt"])
          .optional()
          .describe(
            'Omit (default "steer"): wakes closed/archived agents and joins a live turn without ' +
              'cancelling. "interrupt": only when the user explicitly asked to cancel the running turn.',
          ),
        agentMode: PromptAgentModeInputSchema,
        images: z
          .array(FleetImageInputSchema)
          .optional()
          .describe(
            "Native images for the agent: inline {data, mimeType} (base64) or {fileId} from fleet_upload_file. " +
              "Delivered in every mode, to local and peer agents.",
          ),
        // Composer paste-through: the Commander forwards user attachments
        // (uploaded_file, github_pr, review, ...) as descriptors.
        attachments: z
          .array(FleetAttachmentInputSchema)
          .optional()
          .describe(
            "Attachments to forward to the agent (composer paste-through). An uploaded_file is given as " +
              '{type: "uploaded_file", id: fileId} (fileId from fleet_upload_file) or as a full descriptor whose ' +
              "path exists on this host; the agent gets the file's name, path and size as text and opens it " +
              "itself. Agents on another host get a copy in their host's upload store. A missing file is an error.",
          ),
      },
      outputSchema: {
        success: z.boolean(),
        deliveryMode: z.enum(["steer", "interrupt", "steer-interrupt"]),
        // The agent was idle and its new run was seen starting before this
        // returned, so a fleet_wait_agent after it waits on the new run.
        runStarted: z.boolean().optional(),
        // The turn this prompt runs in (a live steer joins the current turn);
        // pass it to fleet_wait_agent/fleet_wait_agents to bind the wait.
        turnId: z.string().nullable().optional(),
        // Approval-flow outcome (spec 03): the proposal id when a send is
        // pending (or deduplicated onto an existing one) and guidance.
        // Additive.
        proposalId: z.string().optional(),
        status: z.literal("pending-approval").optional(),
        guidance: z.string().optional(),
      },
    },
    async ({
      host,
      agentId,
      prompt,
      mode,
      images: imageInputs,
      attachments: attachmentInputs,
      agentMode,
    }) => {
      // Fail fast (spec 03): agentId is the UUID agent id family — a title or
      // an mcp_ proposal id is never an agent. Reject at call time with
      // guidance so the model self-corrects in one step.
      if (!AGENT_UUID_PATTERN.test(agentId)) {
        throw new Error(
          `agentId must be a UUID (the agent id from fleet_list_agents data); got "${agentId}". ` +
            "Titles and proposal ids are not agent ids — call fleet_list_agents(query) to resolve.",
        );
      }
      // Resolve the agent's target host: the id is authoritative, host is a
      // hint to validate against (never a routing key); unknown ids name live
      // candidates so the model can pick the right agent (spec 03 contract).
      const resolveSendTargetHost = async (): Promise<string> => {
        if (host) {
          const resolution = await fleetIdIndex.resolveFleetId(agentId);
          if (resolution.kind !== "unknown" && !hostsMatch(host, resolution.host)) {
            const actualHost = resolution.host === "local" ? hostLabel : resolution.host;
            throw new Error(`Agent "${agentId}" is on host "${actualHost}", not "${host}"`);
          }
          return host;
        }
        const resolution = await fleetIdIndex.resolveFleetId(agentId);
        if (resolution.kind === "unknown") {
          // UUID-shaped but unknown anywhere: name live candidates so the
          // model can pick the right agent (spec 03 error contract).
          throw new Error(await buildUnknownAgentError(agentId));
        }
        return resolution.host;
      };
      const targetHost = await resolveSendTargetHost();
      // Resolved on this host before any delivery: fileIds become bytes or
      // store descriptors, and a file that is not here fails the send.
      const images = await resolveFleetImages(imageInputs, options.paseoHome);
      const attachments = await resolveFleetAttachments(attachmentInputs, options.paseoHome);
      const requirePeerClient = (peerHost: string): DaemonClient => {
        const client = resolveFleetHost(peerHost);
        if (!client) {
          throw new Error(
            `Host "${peerHost}" is not a configured peer; this daemon knows: ${knownFleetHostsText()}`,
          );
        }
        return client;
      };
      const effectiveMode = mode ?? "steer";
      // Local dispatch: a Commander/Verifier dispatch superseding a busy
      // worker's run is machinery-originated — the superseded run must keep
      // the failure treatment, never read as a user interruption.
      const dispatchLocalPrompt = async (): Promise<PaseoToolResult> => {
        let deliveredAs: string;
        const wasIdle = agentManager.getAgent(agentId)?.lifecycle !== "running";
        // A "steer" result on an agent with a run in flight was a live steer
        // into that run (an idle agent's steer starts a new one).
        const wasBusy = agentManager.hasInFlightRun(agentId);
        const before = await readCurrentTurn({ agentManager, agentId }).catch(() => null);
        try {
          deliveredAs = await dispatchLocalPromptMode({
            agentManager,
            agentStorage,
            agentId,
            prompt,
            mode: effectiveMode,
            attachments,
            images,
            replaceOrigin: "machinery",
            recordStopOrigin: (stopAgentId, origin) =>
              missionControlService?.recordStopOrigin(stopAgentId, origin),
            ...(agentMode ? { agentMode } : {}),
            logger: childLogger,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes(`Agent ${agentId} not found`)) {
            throw new Error(await buildUnknownAgentError(agentId), { cause: error });
          }
          throw error;
        }
        const turn = await resolvePromptedTurn({
          agentManager,
          agentId,
          previousTurnId: before?.active ?? before?.last ?? null,
          joinsCurrentTurn: deliveredAs === "steer" && wasBusy,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({
            success: true,
            deliveryMode: deliveredAs,
            runStarted: wasIdle && turn.started,
            turnId: turn.turnId,
          }),
        };
      };
      if (isFleetLocalTarget(targetHost)) {
        return dispatchLocalPrompt();
      }
      const client = requirePeerClient(targetHost);
      const before = await Promise.resolve()
        .then(() => client.fetchAgent(agentId))
        .catch(() => null);
      const beforeTurn = await readCurrentTurn({ client, agentId }).catch(() => null);
      const peerAttachments = await forwardUploadedFilesToPeer(attachments, client);
      if (agentMode) {
        await selectAgentModeOnPeer(client, targetHost, agentId, agentMode);
      }
      await client.sendAgentMessage(agentId, prompt, {
        dispatchMode: effectiveMode,
        ...(images ? { images } : {}),
        ...(peerAttachments ? { attachments: peerAttachments } : {}),
      });
      const wasIdle = before?.agent.status !== "running";
      const turn = await resolvePromptedTurn({
        client,
        agentId,
        previousTurnId: beforeTurn?.active ?? beforeTurn?.last ?? null,
        // A busy omp agent takes a steer into its live turn.
        joinsCurrentTurn: effectiveMode === "steer" && !wasIdle && before?.agent.provider === "omp",
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          deliveryMode: effectiveMode,
          runStarted: wasIdle && turn.started,
          turnId: turn.turnId,
        }),
      };
    },
  );

  const fleetControlOptions = {
    registerTool,
    agentManager,
    agentStorage,
    fleetIdIndex,
    isFleetLocalTarget,
    hostsMatch,
    resolveFleetHost,
    knownFleetHostsText,
    hostLabel,
    logger: childLogger,
    missionControlService,
  };
  registerFleetControlTools(fleetControlOptions);
  registerFleetUnarchiveTools({
    ...fleetControlOptions,
    workspaceRegistry: options.workspaceRegistry,
    restoreWorkspace: options.restoreWorkspace,
    emitStoredAgentUpdate: options.emitStoredAgentUpdate,
  });
  registerFleetTranscriptTool(fleetControlOptions);
  registerFleetWaitTools(fleetControlOptions);
  registerFleetFileTools({
    ...fleetControlOptions,
    paseoHome: options.paseoHome,
    chunkedUploads: options.chunkedUploads,
  });

  // The split meta tools share one output contract with fleet_meta. "scheduled"
  // is an agent's move of itself, applied when its turn ends; "applied" is any
  // other action, applied on its host. pending/sent/proposalId stay in the
  // schema for old callers and are never returned.
  const META_TOOL_OUTPUT_SCHEMA = {
    ok: z.boolean(),
    status: z.enum(["pending", "sent", "scheduled", "applied", "dry_run"]).optional(),
    proposalId: z.string().optional(),
    wouldArchive: z.record(z.string(), z.unknown()).optional(),
    guidance: z.string().optional(),
    error: z.string().optional(),
  };
  const META_GATE_NOTE = "Applies immediately on the target's host.";
  const TICKET_REF_SCHEMA = z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("An existing itsaplan ticket to link, e.g. PASEO-71 (or its numeric issue id).");
  const ASK_SCHEMA = z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Vaibhav's ask, verbatim. Commented on the ticket; a new ticket also uses it as its description.",
    );
  const ARCHIVE_DRY_RUN_SCHEMA = z
    .boolean()
    .optional()
    .describe(
      "Preview only: list the agents the archive would take with it (running ones flagged); nothing is archived.",
    );
  const PROJECT_ID_SCHEMA = z
    .string()
    .regex(
      /^prj_[0-9a-f]{16}$/,
      "projectId must be a project id (prj_ + 16 hex) from fleet_list_inventory data — fleet-wide, no host needed",
    );
  const WORKSPACE_ID_SCHEMA = z
    .string()
    .regex(
      /^wks_[0-9a-f]{16}$/,
      "workspaceId must be a workspace id (wks_ + 16 hex) from fleet_list_inventory data — fleet-wide, no host needed",
    );
  const AGENT_ID_SCHEMA = z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "agentId must be an agent UUID from fleet_list_agents data — fleet-wide, no host needed",
    );
  const HOST_HINT_SCHEMA = z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
        "When omitted, resolved automatically via the fleet index.",
    );
  const PROJECT_PATH_SCHEMA = z
    .string()
    .refine(
      (value) => isAbsolute(value),
      "path must be an absolute filesystem path (e.g. /home/user/project) where the project root will be created",
    );

  registerTool(
    "fleet_rename_project",
    {
      title: "Rename a project",
      description:
        "Rename a project across the fleet. projectId is a prj_ id from fleet_list_inventory — " +
        `fleet-wide, no host needed. ${META_GATE_NOTE}`,
      inputSchema: {
        projectId: PROJECT_ID_SCHEMA,
        title: z.string().min(1).describe("The new project name."),
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ projectId, title, host }) =>
      runMetaGate({
        toolName: "fleet_rename_project",
        action: "rename_project",
        kind: "project",
        targetId: projectId,
        newValue: title,
        host,
      }),
  );

  registerTool(
    "fleet_rename_workspace",
    {
      title: "Rename a workspace",
      description:
        "Rename a workspace across the fleet. workspaceId is a wks_ id from fleet_list_inventory — " +
        `fleet-wide, no host needed. ${META_GATE_NOTE}`,
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        title: z.string().min(1).describe("The new workspace name."),
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ workspaceId, title, host }) =>
      runMetaGate({
        toolName: "fleet_rename_workspace",
        action: "rename_workspace",
        kind: "workspace",
        targetId: workspaceId,
        newValue: title,
        host,
      }),
  );

  registerTool(
    "fleet_rename_agent_title",
    {
      title: "Rename an agent's title",
      description:
        "Change an agent's TITLE across the fleet (agent names are write-once and never touched). " +
        "agentId is an agent UUID from fleet_list_agents data — fleet-wide, no host needed. " +
        META_GATE_NOTE,
      inputSchema: {
        agentId: AGENT_ID_SCHEMA,
        title: z.string().min(1).describe("The new agent title."),
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ agentId, title, host }) =>
      runMetaGate({
        toolName: "fleet_rename_agent_title",
        action: "rename_agent_title",
        kind: "agent",
        targetId: agentId,
        newValue: title,
        host,
      }),
  );

  registerTool(
    "fleet_archive_project",
    {
      title: "Archive a project",
      description:
        "Archive a project across the fleet (its workspaces and their agents archive with it). " +
        "projectId is a prj_ id from fleet_list_inventory — fleet-wide, no host needed. " +
        "DESTRUCTIVE: ask Vaibhav before archiving anything he did not name.",
      inputSchema: {
        projectId: PROJECT_ID_SCHEMA,
        host: HOST_HINT_SCHEMA,
        dryRun: ARCHIVE_DRY_RUN_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ projectId, host, dryRun }) =>
      runMetaGate({
        toolName: "fleet_archive_project",
        dryRun,
        action: "archive_project",
        kind: "project",
        targetId: projectId,
        host,
      }),
  );

  registerTool(
    "fleet_archive_workspace",
    {
      title: "Archive a workspace",
      description:
        "Archive a workspace across the fleet (its agents archive with it). workspaceId is a wks_ id " +
        "from fleet_list_inventory — fleet-wide, no host needed. DESTRUCTIVE: ask Vaibhav " +
        "before archiving anything he did not name.",
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        host: HOST_HINT_SCHEMA,
        dryRun: ARCHIVE_DRY_RUN_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ workspaceId, host, dryRun }) =>
      runMetaGate({
        toolName: "fleet_archive_workspace",
        dryRun,
        action: "archive_workspace",
        kind: "workspace",
        targetId: workspaceId,
        host,
      }),
  );

  registerTool(
    "fleet_archive_agent",
    {
      title: "Archive an agent",
      description:
        "Archive an agent across the fleet. agentId is an agent UUID from fleet_list_agents/fleet_search " +
        "data — fleet-wide, no host needed. DESTRUCTIVE: ask Vaibhav before archiving anything he did not name.",
      inputSchema: {
        agentId: AGENT_ID_SCHEMA,
        host: HOST_HINT_SCHEMA,
        dryRun: ARCHIVE_DRY_RUN_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ agentId, host, dryRun }) =>
      runMetaGate({
        toolName: "fleet_archive_agent",
        dryRun,
        action: "archive_agent",
        kind: "agent",
        targetId: agentId,
        host,
      }),
  );

  registerTool(
    "fleet_create_project",
    {
      title: "Create a project",
      description:
        "Create a project at an absolute root path on a host. host is REQUIRED — the new project root " +
        `must land somewhere (a peer name from the daemon peers config, or 'local'). ${META_GATE_NOTE}`,
      inputSchema: {
        host: z
          .string()
          .min(1)
          .describe(
            "Target host: a peer name from the daemon peers config, or 'local' for this daemon.",
          ),
        path: PROJECT_PATH_SCHEMA,
        title: z
          .string()
          .optional()
          .describe("Optional project display name (defaults to the root path's basename)."),
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ host, path, title }) =>
      runMetaGate({
        toolName: "fleet_create_project",
        action: "create_project",
        kind: "create-project",
        host,
        destination: path,
        newValue: title,
      }),
  );

  registerTool(
    "fleet_move_agent",
    {
      title: "Move an agent to another workspace",
      description:
        "Move an agent to another workspace, including across projects or across hosts in the fleet. agentId is an " +
        "agent UUID from fleet_list_agents data; workspaceId is a wks_ id from " +
        "fleet_list_inventory — both fleet-wide, no host needed. Refuses another agent while it is running. " +
        "To move yourself, omit agentId: the move applies when your current turn ends and your next " +
        `turn runs in the new workspace directory, with no approval card. ${META_GATE_NOTE}`,
      inputSchema: {
        agentId: AGENT_ID_SCHEMA.optional().describe(
          "The agent to move. Omit to move yourself (the calling agent).",
        ),
        workspaceId: WORKSPACE_ID_SCHEMA,
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ agentId, workspaceId, host }) =>
      runMetaGate({
        toolName: "fleet_move_agent",
        action: "move_agent",
        kind: "agent",
        targetId: agentId ?? callerAgentId,
        destination: workspaceId,
        host,
      }),
  );

  registerTool(
    "fleet_promote_workspace",
    {
      title: "Promote an experiment workspace to its own project",
      description:
        "Promote a workspace in the per-host experiments project (~/experiments) to its own project. " +
        "workspaceId is a wks_ id from fleet_list_inventory — fleet-wide, no host needed. " +
        META_GATE_NOTE,
      inputSchema: {
        workspaceId: WORKSPACE_ID_SCHEMA,
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: META_TOOL_OUTPUT_SCHEMA,
    },
    async ({ workspaceId, host }) =>
      runMetaGate({
        toolName: "fleet_promote_workspace",
        action: "promote_workspace",
        kind: "workspace",
        targetId: workspaceId,
        host,
      }),
  );

  registerTool(
    "fleet_ticketize_agent",
    {
      title: "Create an itsaplan ticket for an agent",
      description:
        "Create an itsaplan ticket from an agent's title and description, link the agent to the ticket with an itsaplan.issue label, " +
        "and post a deep-link comment. Ticket column matches the agent's current lifecycle bucket (running/needs_you -> In Progress, " +
        "ready -> Ready to review, done -> completed, idle -> unstarted/Todo). Idempotent: returns existing ticket if already labeled. " +
        "Pass ticket to link an existing ticket instead, and ask to comment Vaibhav's words on it. " +
        "agentId is an agent UUID from fleet_list_agents data. Runs on this host; peers run it for their own agents.",
      inputSchema: {
        agentId: AGENT_ID_SCHEMA,
        ticket: TICKET_REF_SCHEMA,
        ask: ASK_SCHEMA,
        host: HOST_HINT_SCHEMA,
      },
      outputSchema: {
        ok: z.boolean(),
        issueId: z.number().optional(),
        url: z.string().optional(),
        error: z.string().optional(),
      },
    },
    async ({ agentId, ticket, ask, host }) => {
      // The agent's labels live on its host, so the ticket is made there.
      const resolution = host ? null : await fleetIdIndex.resolveFleetId(agentId);
      const agentHost = host ?? (resolution?.kind === "unknown" ? "local" : resolution?.host);
      if (agentHost && !isFleetLocalTarget(agentHost)) {
        const client = resolveFleetHost(agentHost);
        if (!client) {
          throw new Error(`Host "${agentHost}" is not a configured peer`);
        }
        const peerResult = await executeFleetToolOnPeer(client, "fleet_ticketize_agent", {
          agentId,
          ...(ticket ? { ticket } : {}),
          ...(ask ? { ask } : {}),
        });
        if (!peerResult.ok) {
          throw new Error(
            `fleet_ticketize_agent on host "${agentHost}" failed: ${peerResult.error}`,
          );
        }
        return { content: [], structuredContent: ensureValidJson(peerResult.structuredContent) };
      }
      const ticketize = options.itsaplanTicketize;
      if (!ticketize) {
        throw new Error(
          "fleet_ticketize_agent is unavailable: the itsaplan bridge is not configured on this daemon",
        );
      }
      const result = await ticketize.ticketizeAgent(agentId, { ticket, ask });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          ok: true,
          issueId: result.issueId,
          url: result.url,
        }),
      };
    },
  );

  registerTool(
    "itsaplan_ticketize",
    {
      title: "Create an itsaplan ticket for an agent (alias)",
      description:
        "Alias for fleet_ticketize_agent. Create an itsaplan ticket from an agent's title and description.",
      inputSchema: {
        agentId: AGENT_ID_SCHEMA,
      },
      outputSchema: {
        ok: z.boolean(),
        issueId: z.number().optional(),
        url: z.string().optional(),
        error: z.string().optional(),
      },
    },
    async (args, context) => {
      const tool = tools.get("fleet_ticketize_agent");
      if (!tool) {
        throw new Error("fleet_ticketize_agent not found");
      }
      return tool.handler(args, context);
    },
  );

  registerDocThreadToolsIfAvailable({
    registerTool,
    resolveDocThreads: options.resolveDocThreads,
    callerAgentId,
  });

  /**
   * fleet_agent_status for an agent on a peer: the status lives in the owning
   * host's Mission Control store, so the same tool runs there (fresh:true
   * steers and waits on that host).
   */
  const fetchPeerAgentStatus = async (
    targetHost: string,
    agentId: string,
    fresh: boolean,
    notify: boolean = false,
    requestId?: string,
  ): Promise<PaseoToolResult> => {
    const client = resolveFleetHost(targetHost);
    if (!client) {
      throw new Error(
        `Host "${targetHost}" is not a configured peer; this daemon knows: ${knownFleetHostsText()}`,
      );
    }
    const peerResult = await executeFleetToolOnPeer(
      client,
      "fleet_agent_status",
      { agentId, fresh, notify, ...(requestId ? { requestId } : {}) },
      fresh && !notify ? FRESH_STATUS_WAIT_TIMEOUT_MS + 15_000 : undefined,
    );
    if (!peerResult.ok) {
      throw new Error(`fleet_agent_status on host "${targetHost}" failed: ${peerResult.error}`);
    }
    const peerRecord = peerResult.structuredContent;
    if (typeof peerRecord !== "object" || peerRecord === null) {
      throw new Error(`fleet_agent_status on host "${targetHost}" returned no status`);
    }
    return {
      content: [],
      structuredContent: ensureValidJson({ ...peerRecord, host: targetHost }),
    };
  };

  const handleFreshStatusReport = async (
    agentId: string,
    record: Record<string, unknown>,
    targetHost: string,
    projectId: string | null,
    notify: boolean,
    requestedRequestId?: string,
  ): Promise<PaseoToolResult> => {
    const effectiveHost = targetHost === "local" ? hostLabel : targetHost;
    if (notify) {
      const effectiveRequestId = requestedRequestId ?? `req_${randomUUID()}`;
      const steer = await missionControlService!.requestFreshStatusSteer(agentId, { notify: true });
      if (!steer.ok) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ...record,
            projectId,
            host: effectiveHost,
            fresh: false,
            requested: false,
            requestId: effectiveRequestId,
            note: `status-ask not delivered: ${steer.error}`,
          }),
        };
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          ...record,
          projectId,
          host: effectiveHost,
          fresh: false,
          requested: true,
          requestId: effectiveRequestId,
        }),
      };
    }
    const freshReportPromise = waitForFreshAgentReport(
      missionControlService!,
      agentId,
      FRESH_STATUS_WAIT_TIMEOUT_MS,
    );
    const steer = await missionControlService!.requestFreshStatusSteer(agentId);
    if (!steer.ok) {
      return {
        content: [],
        structuredContent: ensureValidJson({
          ...record,
          projectId,
          host: hostLabel,
          fresh: false,
          note: `status-ask not delivered: ${steer.error}`,
        }),
      };
    }
    const freshReport = await freshReportPromise;
    if (!freshReport) {
      return {
        content: [],
        structuredContent: ensureValidJson({
          ...record,
          projectId,
          host: hostLabel,
          fresh: false,
          note: `No fresh report_status within ${Math.round(FRESH_STATUS_WAIT_TIMEOUT_MS / 1000)}s; showing the last known status.`,
        }),
      };
    }
    return {
      content: [],
      structuredContent: ensureValidJson({
        ...record,
        projectId,
        host: hostLabel,
        fresh: true,
        lastReport: {
          headline: freshReport.headline,
          detail: freshReport.detail ?? null,
          ts: freshReport.ts,
          reportKind: freshReport.reportKind ?? null,
        },
      }),
    };
  };

  registerTool(
    "fleet_agent_status",
    {
      title: "Check on one agent",
      description:
        "One call answers 'how is X doing': record identity (name, title, description), the canonical lifecycle " +
        "bucket, lastStatus, running-turn info, the last report_status headline/detail/ts, and workspaceId/" +
        "projectId/host. fresh:true steers the agent to post a fresh report_status (user-invisible machinery " +
        "envelope) and waits up to 60s for it; on timeout it returns the stale data with fresh:false and a note. " +
        "Passing notify:true (only valid with fresh:true) returns immediately with requested:true and a requestId, " +
        "without the 60s wait, and POSTs paseo.agent.status_reported to your configured webhook when the report lands " +
        "(or with status no_report on 5-min timeout or turn end). The only mid-run status mechanism — fires only on " +
        "explicit request. Read-only; never approval-gated.",
      inputSchema: {
        agentId: z
          .string()
          .describe("Agent UUID from fleet_list_agents data — fleet-wide, no host needed."),
        fresh: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Steer the agent for a fresh report_status and wait up to 60s. Only on explicit request.",
          ),
        notify: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true (only valid with fresh:true), return immediately with requested:true and a requestId, " +
              "and POST paseo.agent.status_reported to your configured webhook when the report lands (or status no_report on 5-min timeout / turn end).",
          ),
        notifyContext: z
          .string()
          .max(2000)
          .optional()
          .describe("Free-form tag echoed back verbatim as context in the webhook payload."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
              "Omitted → resolved via the fleet index.",
          ),
        requestId: z
          .string()
          .optional()
          .describe("Optional request ID to bind the notification to."),
      },
      outputSchema: {
        agentId: z.string(),
        name: z.string().nullable(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        bucket: z.enum(["needs_you", "running", "ready", "done", "idle"]),
        lastStatus: z.string().nullable(),
        running: z
          .object({
            lifecycle: z.string(),
            activeTurnId: z.string().nullable(),
            activeTurnStartedAt: z.string().nullable(),
            modeId: z.string().nullable(),
            pendingPermissionCount: z.number(),
          })
          .nullable(),
        lastReport: z
          .object({
            headline: z.string(),
            detail: z.string().nullable(),
            ts: z.string(),
            reportKind: z.string().nullable(),
          })
          .nullable(),
        workspaceId: z.string().nullable(),
        projectId: z.string().nullable(),
        host: z.string(),
        fresh: z.boolean(),
        requested: z.boolean().optional(),
        requestId: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async ({
      agentId: requestedAgentId,
      fresh = false,
      notify = false,
      notifyContext: _notifyContext,
      requestId: requestedRequestId,
      host,
    }: {
      agentId: string;
      fresh?: boolean;
      notify?: boolean;
      notifyContext?: string;
      requestId?: string;
      host?: string;
    }) => {
      if (!missionControlService) {
        throw new Error("Mission Control is not enabled on this host");
      }
      if (notify && !fresh) {
        throw new Error("notify: true is only valid when fresh: true");
      }
      // Resolve the agent's host via the fleet index (spec 02): the id is
      // authoritative, host is a hint to validate against, never a routing key.
      // A short id expands to the full id, which every later lookup uses.
      const resolution = await fleetIdIndex.resolveFleetId(requestedAgentId);
      if (resolution.kind === "unknown") {
        throw new Error(resolution.guidance);
      }
      const agentId = resolution.id;
      const targetHost = resolution.host;
      if (host !== undefined) {
        if (!hostsMatch(targetHost, host)) {
          const actualHost = targetHost === "local" ? hostLabel : targetHost;
          throw new Error(`Agent "${agentId}" is on host "${actualHost}", not "${host}"`);
        }
      }
      if (!isFleetLocalTarget(targetHost)) {
        return fetchPeerAgentStatus(targetHost, agentId, fresh, notify, requestedRequestId);
      }
      const record = await missionControlService.getAgentStatusRecord(agentId);
      // Project attribution: resolve the workspace's project via the local
      // registry when available (absent registry → projectId stays null).
      let projectId: string | null = null;
      if (record.workspaceId && options.workspaceRegistry) {
        try {
          const workspace = await options.workspaceRegistry.get(record.workspaceId);
          projectId = workspace?.projectId ?? null;
        } catch {
          // Registry hiccup: projectId is additive, never a hard failure.
        }
      }
      if (!fresh) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ...record,
            projectId,
            host: hostLabel,
            fresh: false,
          }),
        };
      }
      return handleFreshStatusReport(
        agentId,
        record as unknown as Record<string, unknown>,
        targetHost,
        projectId,
        notify,
        requestedRequestId,
      );
    },
  );

  return toCatalog();
}

// How long a machinery "queue" delivery (approval proposals, fleet_agent_status
// notify) waits for a busy agent's in-flight run to settle before giving up
// with an actionable error. fleet_send_prompt never takes queue: it would block
// the tool call until the agent goes idle.
const FLEET_QUEUE_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * How long fleet_agent_status fresh:true waits for the steered agent's
 * report_status to land (spec 03: bounded 60s) before returning the stale
 * data with fresh:false.
 */
const FRESH_STATUS_WAIT_TIMEOUT_MS = 60_000;

/**
 * Bounded wait for the agent's next self-sourced report event. The listener
 * is armed BEFORE the status-ask steer goes out so no report can slip
 * between subscription and delivery; a timeout resolves null (the caller
 * falls back to stale data + fresh:false note).
 */
function waitForFreshAgentReport(
  missionControlService: MissionControlService,
  agentId: string,
  timeoutMs: number,
): Promise<MissionControlEvent | null> {
  const { promise, resolve } = Promise.withResolvers<MissionControlEvent | null>();
  const unsubscribe = missionControlService.subscribeSelfReports((event) => {
    if (event.agentId === agentId) {
      unsubscribe();
      resolve(event);
    }
  });
  const timer = setTimeout(() => {
    unsubscribe();
    resolve(null);
  }, timeoutMs);
  timer.unref?.();
  return promise;
}

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
 * Local delivery for fleet_send_prompt and Mission Control proposal modes:
 * - steer: OMP live-steer (out-of-band, non-cancelling) when the agent is busy
 *   on the omp provider; an idle agent just runs the prompt. A busy agent on a
 *   provider WITHOUT a native steer path is INTERRUPTED (replaceRunning) —
 *   a steer's value is timely delivery, and queue-until-idle can sit for tens
 *   of minutes, so the fallback cancels and replaces rather than waiting.
 *   The returned value distinguishes the fallback ("steer-interrupt") from a
 *   native steer so callers/logs stay honest about what actually happened.
 * - queue: wait for idle, then stream without replacing. Machinery only (it
 *   blocks until idle); fleet_send_prompt never takes it.
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

function assertPeerSupportsAgentModes(client: DaemonClient, host: string): void {
  if (client.getLastServerInfoMessage()?.features?.agentModes !== true) {
    throw new Error(`Host "${host}" does not support agent modes; update Paseo on that host.`);
  }
}

/**
 * Select an agent mode on a peer-hosted agent before a prompt is sent to it, so
 * the peer's run start carries the mode block on that prompt.
 */
export async function selectAgentModeOnPeer(
  client: DaemonClient,
  host: string,
  agentId: string,
  agentMode: AgentModeId,
): Promise<void> {
  assertPeerSupportsAgentModes(client, host);
  await client.setAgentAgentMode(agentId, agentMode);
}

async function tryOmpLiveSteer(params: {
  agentManager: AgentManager;
  agentId: string;
  prompt: string;
  attachments?: AgentAttachment[];
  images?: Array<{ data: string; mimeType: string }>;
  classification: AgentTimelineUserMessageClassification;
  messageId?: string;
  onOutOfBandSteer?: () => void;
}): Promise<"steer" | null> {
  const { agentManager, agentId, prompt, attachments, images, classification, messageId } = params;
  if (!agentManager.hasInFlightRun(agentId)) {
    return null;
  }
  if (agentManager.getAgent(agentId)?.provider !== "omp") {
    return null;
  }
  const steerBody =
    attachments && attachments.length > 0
      ? [prompt.trim(), ...attachments.map(renderPromptAttachmentAsText)]
          .filter(Boolean)
          .join("\n\n")
      : prompt;
  // A pending agent mode rides the steer, so it applies to the turn it joins.
  const moded = agentManager.withAgentModePrefix(agentId, steerBody);
  // OMP trims the `/steer` argument, so its echo carries the trimmed text; the
  // recorded row must match it for the echo to reconcile.
  const steerText = (typeof moded.prompt === "string" ? moded.prompt : steerBody).trim();
  // Native images ride OMP `/steer` as a structured prompt.
  const steerPrompt: AgentPromptInput =
    images && images.length > 0
      ? [
          { type: "text", text: `/steer ${steerText}` },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : `/steer ${steerText}`;
  const handled = agentManager.tryRunOutOfBand(agentId, steerPrompt);
  if (!handled) {
    return null;
  }
  // OMP echoes the steered message as a native user message once it joins the
  // turn. Record the row as a submitted prompt (it always carries a
  // clientMessageId) so the manager reconciles that echo into this row by text
  // instead of appending a second copy. appendTimelineItem records the row
  // synchronously, before the runtime can echo it.
  await agentManager.appendTimelineItem(agentId, {
    type: "user_message",
    text: steerText,
    classification,
    clientMessageId: messageId ?? randomUUID(),
    ...(images && images.length > 0 ? { images } : {}),
  });
  if (moded.carriesMode) {
    await agentManager.markAgentModeApplied(agentId);
  }
  params.onOutOfBandSteer?.();
  return "steer";
}

export async function dispatchLocalPromptMode(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  prompt: string;
  mode: "steer" | "interrupt" | "queue";
  attachments?: AgentAttachment[];
  images?: Array<{ data: string; mimeType: string }>;
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
   * always be visible.
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
  /**
   * Agent mode for this prompt. Selected before delivery so its block rides
   * this prompt in every mode (live steer, steer, interrupt, queue).
   */
  agentMode?: AgentModeId;
  logger: Logger;
}): Promise<"steer" | "interrupt" | "queue" | "steer-interrupt"> {
  const {
    agentManager,
    agentStorage,
    agentId,
    prompt,
    mode,
    attachments,
    images,
    messageId,
    logger,
  } = params;
  const classification = params.classification ?? "instruction";
  const replaceOrigin = params.replaceOrigin;
  const recordStopOrigin = params.recordStopOrigin;
  const promptWithAttachments = buildAgentPrompt(prompt, images, attachments);
  if (params.agentMode) {
    await ensureAgentLoaded(agentId, { agentManager, agentStorage, logger });
    await agentManager.selectAgentMode(agentId, params.agentMode);
  }
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
    const liveSteer = await tryOmpLiveSteer({
      agentManager,
      agentId,
      prompt,
      attachments,
      images,
      classification,
      messageId,
      onOutOfBandSteer: params.onOutOfBandSteer,
    });
    if (liveSteer) {
      return liveSteer;
    }
    const busy = agentManager.hasInFlightRun(agentId);
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
  // The full send path, so a closed or archived agent is restored and loaded
  // first, as steer and interrupt do; queue only differs by never replacing.
  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId,
    prompt: promptWithAttachments,
    replaceRunning: false,
    messageId,
    logger,
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
    projectRegistry: options.projectRegistry,
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
