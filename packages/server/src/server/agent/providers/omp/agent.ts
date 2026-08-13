import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { setImmediate as waitForImmediate, setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import stripAnsi from "strip-ansi";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentProviderNotice,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
  type ProviderRefreshContext,
  type ToolCallDetail,
} from "../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
import { importSessionFromPersistence } from "../../provider-session-import.js";
import { runProviderRefreshActivity } from "../../provider-refresh-deadline.js";
import { runProviderTurn } from "../provider-runner.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { composeSystemPromptParts, hasSignificantLaunchEnv } from "../../system-prompt.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "../diagnostic-utils.js";
import {
  formatOmpVersionSupport,
  mergeOmpRuntimeSettings,
  resolveOmpDiagnosticPaths,
  resolveOmpLaunchMode,
  resolveOmpProviderParams,
  OMP_MODES,
  type OmpModelRoleParams,
  type OmpRuntimeProviderParams,
} from "./provider-config.js";
export { formatOmpVersionSupport, resolveOmpDiagnosticPaths } from "./provider-config.js";
import { OmpSubagentCardTracker, type OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import { shouldDisplayOmpCustomMessage } from "./custom-message.js";
import { getUserMessageText } from "./message-history.js";
import { mapOmpSystemNoticeToToolCall } from "./system-notice.js";
import { materializeProviderImage } from "../provider-image-output.js";
import { OmpCliRuntime } from "./cli-runtime.js";
import {
  listOmpImportableSessions,
  readOmpImportSessionConfig,
  resolveOmpSessionFile,
} from "./session-descriptor.js";
import type { OmpRuntime, OmpRuntimeSession, OmpStartSessionInput } from "./runtime.js";
import { OmpWarmPool } from "./warm-pool.js";
import type {
  OmpAgentSessionEvent,
  OmpAgentMessage,
  OmpImageContent,
  OmpModel,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpThinkingLevel,
} from "./rpc-types.js";
import {
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";
import { mapOmpAvailableCommandsUpdate, mapOmpRuntimeSlashCommands } from "./commands.js";
import { streamOmpHistory } from "./history.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";
import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";
import { mapOmpAdvisorMessageToToolCall } from "./advisor-message.js";
import {
  clearOmpHostToolState,
  handleOmpHostToolRuntimeEvent,
  setOmpHostTools,
} from "./host-tools.js";
import { OmpSubagentIndex } from "./subagent-index.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { OmpUsagePoller, type OmpUsagePollScheduler } from "./usage-poller.js";
import {
  buildOmpRpcUiPermissionResponse,
  mapOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";
import { DEFAULT_OMP_THINKING_LEVEL, mapOmpModel } from "./map-omp-model.js";

const OMP_PROVIDER = "omp";
const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";
const OMP_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const COMBINED_ASK_USER_METADATA = "ask_user_select_optional_comment";

const OMP_CORE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

export interface OmpAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  runtime?: OmpRuntime;
  subagentCardScheduler?: OmpSubagentCardScheduler;
  providerIdleScheduler?: OmpProviderIdleScheduler;
  noTurnScheduler?: OmpNoTurnScheduler;
  usagePollScheduler?: OmpUsagePollScheduler;
}

export interface OmpProviderIdleScheduler {
  waitForRetry(): Promise<void>;
}

export interface OmpNoTurnScheduler {
  waitForSettle(signal: AbortSignal): Promise<void>;
}

// COMPAT(ompDelayedLocalOnlyResult): OMP 17.0.5 can report a regular prompt as
// local-only shortly before an extension-queued model turn starts. Added in
// v0.2.0-beta.1; remove after January 20, 2027 once the minimum OMP version
// guarantees prompt_result waits for queued extension work.
const OMP_NO_TURN_SETTLE_MS = 5_000;

// Upper bound on waiting for OMP to report a promptable RPC loop after
// agent_end. Generous because a large-context auto-compaction runs inside this
// window; bounded because `isStreaming` can stay stuck true forever on some
// terminal failures, and an unbounded wait means a permanently spinning agent.
const PROVIDER_IDLE_WAIT_TIMEOUT_MS = 10 * 60_000;

// Budget for the abort retry that runs after the interactive 1s ack window
// lapses. Wide enough to outlast an event-loop stall on a large context, since
// the alternative is killing an OMP process that is still working.
const OMP_BACKGROUND_ABORT_TIMEOUT_MS = 30_000;

interface OmpPromptPayload {
  text: string;
  images?: OmpImageContent[];
}

interface OmpModelReference {
  provider?: string;
  id: string;
}

interface OmpPersistenceMetadata {
  cwd?: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  toolAllowlist?: string[];
}

interface StartTurnResult {
  turnId: string;
}

interface OmpAgentSessionOptions {
  runtimeSession: OmpRuntimeSession;
  config: AgentSessionConfig;
  initialState: OmpSessionState;
  currentModeId?: string | null;
  logger: Logger;
  subagentCardScheduler?: OmpSubagentCardScheduler;
  providerIdleScheduler?: OmpProviderIdleScheduler;
  noTurnScheduler?: OmpNoTurnScheduler;
  usagePollScheduler?: OmpUsagePollScheduler;
  paseoTools?: PaseoToolCatalog;
  /**
   * When false (resumed sessions), replayed session events are dropped until
   * the first prompt or agent_start so history is not re-emitted as live
   * timeline items.
   */
  live?: boolean;
}

function createOmpProviderIdleScheduler(): OmpProviderIdleScheduler {
  return {
    waitForRetry: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

function createOmpNoTurnScheduler(): OmpNoTurnScheduler {
  return {
    waitForSettle: async (signal) => {
      await delay(OMP_NO_TURN_SETTLE_MS, undefined, { signal });
    },
  };
}

interface OmpResumeConfig {
  cwd: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  config: AgentSessionConfig;
}

interface ActiveAskUserDialog {
  allowComment: boolean;
  allowFreeform: boolean;
  allowMultiple: boolean;
}

interface PendingCombinedAskUserResponse {
  comment: string;
  freeform: string | null;
}

interface ExtensionUiMappingOptions {
  provider?: AgentProvider;
  label?: string;
  combineOptionalComment?: boolean;
  allowFreeform?: boolean;
}

interface OmpSlashCommandInvocation {
  commandName: string;
  args?: string;
}

type AutoCompactMode = boolean | "toggle" | "unknown";

function normalizeOmpModelLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/[_\s]+/g, " ");
  const vendorSeparatorIndex = normalizedLabel.indexOf(": ");
  if (vendorSeparatorIndex === -1) {
    return normalizedLabel;
  }

  return normalizedLabel.slice(vendorSeparatorIndex + 2).trim();
}

export function transformOmpModels(models: AgentModelDefinition[]): AgentModelDefinition[] {
  return models.map((model) => {
    if (!model.label.includes("/")) {
      return model;
    }

    const segments = model.label.split("/").filter((segment) => segment.length > 0);
    const rawLabel = segments.at(-1);
    if (!rawLabel) {
      return model;
    }

    return {
      ...model,
      label: normalizeOmpModelLabel(rawLabel),
      description: model.description ?? model.label,
    };
  });
}

function isOmpThinkingLevel(value: string | null | undefined): value is OmpThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function normalizeOmpThinkingOption(value: string | null | undefined): OmpThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isOmpThinkingLevel(value) ? value : null;
}

function parseAutoCompactMode(value: string | undefined): AutoCompactMode {
  const mode = (value ?? "toggle").trim().toLowerCase();
  if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") {
    return true;
  }
  if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") {
    return false;
  }
  if (mode === "toggle") {
    return "toggle";
  }
  return "unknown";
}

function ompModelSupportsImageInput(model: OmpModel | null | undefined): boolean {
  return model?.input?.includes("image") === true;
}

function renderTextOnlyImageHint(image: { data: string; mimeType: string }): string {
  try {
    const materialized = materializeProviderImage({
      data: image.data,
      mimeType: image.mimeType,
    });
    return `[Image available at: ${materialized.path}]`;
  } catch (error) {
    return `[Image attachment omitted: failed to write local file (${toDiagnosticErrorMessage(error)})]`;
  }
}

function convertPromptInput(
  prompt: AgentPromptInput,
  options: { model: OmpModel | null | undefined },
): OmpPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }

  const textParts: string[] = [];
  const images: OmpImageContent[] = [];
  const forwardImages = ompModelSupportsImageInput(options.model);

  for (const block of prompt) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      if (forwardImages) {
        images.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      } else {
        textParts.push(renderTextOnlyImageHint(block));
      }
      continue;
    }

    textParts.push(renderPromptAttachmentAsText(block));
  }

  const payload: OmpPromptPayload = {
    text: textParts.join("\n\n"),
  };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

function parseModelReference(modelId: string | null): OmpModelReference | null {
  if (!modelId) {
    return null;
  }
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (modelId.includes(":")) {
    const [provider, ...rest] = modelId.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: modelId };
}

function parsePersistenceMetadata(metadata: AgentMetadata | undefined): OmpPersistenceMetadata {
  if (!metadata) {
    return {};
  }
  return {
    ...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.thinkingOptionId === "string"
      ? { thinkingOptionId: metadata.thinkingOptionId }
      : {}),
    ...(typeof metadata.modeId === "string" ? { modeId: metadata.modeId } : {}),
    ...(typeof metadata.systemPrompt === "string" ? { systemPrompt: metadata.systemPrompt } : {}),
    ...(typeof metadata.systemPromptMode === "string"
      ? { systemPromptMode: metadata.systemPromptMode as "append" | "replace" }
      : {}),
    ...(Array.isArray(metadata.toolAllowlist) ? { toolAllowlist: metadata.toolAllowlist } : {}),
  };
}

function buildResumeConfig(
  metadata: OmpPersistenceMetadata,
  overrides: Partial<AgentSessionConfig> | undefined,
  provider: AgentProvider,
): OmpResumeConfig {
  const overrideConfig = overrides ?? {};
  const cwd = overrideConfig.cwd ?? metadata.cwd ?? process.cwd();
  const model = overrideConfig.model ?? metadata.model;
  const thinkingOptionId = overrideConfig.thinkingOptionId ?? metadata.thinkingOptionId;
  const modeId = overrideConfig.modeId ?? metadata.modeId;
  return {
    cwd,
    model,
    thinkingOptionId,
    modeId,
    config: {
      ...overrideConfig,
      provider,
      cwd,
      model,
      thinkingOptionId,
      modeId,
      systemPrompt: overrideConfig.systemPrompt ?? metadata.systemPrompt,
      systemPromptMode: overrideConfig.systemPromptMode ?? metadata.systemPromptMode,
      toolAllowlist: overrideConfig.toolAllowlist ?? metadata.toolAllowlist,
    },
  };
}

function buildResumeStartInput(input: {
  resumeConfig: OmpResumeConfig;
  sessionFile: string;
  launchContext: AgentLaunchContext | undefined;
  launchMode: { modeId: string | null; extraArgs?: string[] };
}): OmpStartSessionInput {
  return {
    cwd: input.resumeConfig.cwd,
    protocolMode: "rpc-ui",
    env: input.launchContext?.env,
    session: input.sessionFile,
    model: input.resumeConfig.model,
    thinkingOptionId: normalizeOmpThinkingOption(input.resumeConfig.thinkingOptionId) ?? undefined,
    ...(input.launchMode.modeId ? { modeId: input.launchMode.modeId } : {}),
    ...(input.launchMode.extraArgs ? { extraArgs: input.launchMode.extraArgs } : {}),
    systemPrompt:
      input.resumeConfig.config.systemPromptMode === "replace"
        ? input.resumeConfig.config.systemPrompt?.trim() || undefined
        : composeSystemPromptParts(
            input.resumeConfig.config.systemPrompt,
            input.resumeConfig.config.daemonAppendSystemPrompt,
          ),
    systemPromptMode: input.resumeConfig.config.systemPromptMode,
    toolAllowlist: input.resumeConfig.config.toolAllowlist,
  };
}

function readNativeMessageId(
  message: OmpAgentMessage & { id?: unknown; entryId?: unknown },
): string | undefined {
  if (typeof message.id === "string") {
    return message.id;
  }
  return typeof message.entryId === "string" ? message.entryId : undefined;
}

function withOmpCapabilities(): AgentCapabilityFlags {
  return {
    ...OMP_CORE_CAPABILITIES,
    supportsMcpServers: false,
    supportsNativePaseoTools: true,
  };
}

function isOmpRequestAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /\brequest was aborted\b|\babort(ed)?\b/i.test(toDiagnosticErrorMessage(error));
}

function resolveThinkingOptionId(
  cachedThinkingOptionId: string | null,
  sessionThinkingLevel: OmpThinkingLevel | undefined,
): OmpThinkingLevel | null {
  const currentThinking =
    normalizeOmpThinkingOption(sessionThinkingLevel) ?? cachedThinkingOptionId;
  return normalizeOmpThinkingOption(currentThinking);
}

function modelToId(model: OmpModel | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function ompAssistantText(message: Extract<OmpAgentMessage, { role: "assistant" }>): string | null {
  const text = message.content
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "thinking") {
        return [part.thinking];
      }
      return [];
    })
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function formatOmpErrorMessage(message: Extract<OmpAgentMessage, { role: "assistant" }>): string {
  const headline = message.errorMessage?.trim() || "OMP turn failed";
  const details = [
    message.stopReason ? `stopReason=${message.stopReason}` : null,
    message.provider && message.model ? `model=${message.provider}/${message.model}` : null,
    message.responseModel ? `responseModel=${message.responseModel}` : null,
    message.responseId ? `responseId=${message.responseId}` : null,
  ].filter((detail): detail is string => detail !== null);
  const partialText = ompAssistantText(message);
  if (partialText) {
    details.push(`partial=${JSON.stringify(partialText.slice(0, 500))}`);
  }
  return details.length > 0 ? `${headline} (${details.join(", ")})` : headline;
}

function isTerminalOmpAssistantFailure(
  message: Extract<OmpAgentMessage, { role: "assistant" }>,
): boolean {
  if (message.errorMessage?.trim()) {
    return true;
  }
  const stopReason = message.stopReason?.trim().toLowerCase();
  return stopReason === "error" || stopReason === "aborted";
}

function latestOmpErrorMessage(messages: OmpAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  if (!latestAssistant || !isTerminalOmpAssistantFailure(latestAssistant)) {
    return null;
  }
  return formatOmpErrorMessage(latestAssistant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Restrict the Paseo host-tool catalog to the allowlisted names. The filtered
 * catalog is what gets serialized to omp (the model never sees other tools)
 * and what the host-tool router executes against (defense in depth).
 */
function filterPaseoToolsByAllowlist(
  catalog: PaseoToolCatalog | undefined,
  allowlist: string[] | undefined,
): PaseoToolCatalog | undefined {
  if (!catalog || !allowlist?.length) {
    return catalog;
  }
  const allowed = new Set(allowlist);
  const tools = new Map([...catalog.tools].filter(([name]) => allowed.has(name)));
  if (tools.size === 0) {
    // An allowlist that matches ZERO catalog tools is indistinguishable from
    // no catalog: the session would launch --no-tools with nothing to serve
    // (live incident: a Commander whose allowlist named tools the running
    // build's catalog did not register came back with "Tool fleet_create_agent
    // not found" and only memory/skill builtins, silently — the empty catalog
    // was truthy so the warn below never fired). Returning undefined routes
    // this into the existing loud "no Paseo host-tool catalog is available"
    // warning instead of silently serving zero tools.
    return undefined;
  }
  return {
    tools,
    getTool: (name) => tools.get(name),
    executeTool: (name, input, context) => {
      if (!allowed.has(name)) {
        throw new Error(`Paseo tool not allowed: ${name}`);
      }
      return catalog.executeTool(name, input, context);
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readActiveAskUserDialog(toolName: string, args: unknown): ActiveAskUserDialog | null {
  if (toolName !== "ask_user" || !isRecord(args)) {
    return null;
  }
  return {
    allowComment: optionalBoolean(args.allowComment) ?? false,
    allowFreeform: optionalBoolean(args.allowFreeform) ?? true,
    allowMultiple: optionalBoolean(args.allowMultiple) ?? false,
  };
}

function isOptionalInputPlaceholder(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function getInputQuestionTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInputPlaceholder(placeholder)) {
    return title ?? "Enter a value";
  }
  if (/\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)) {
    return "Optional comment";
  }
  return "Optional response";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isOmpAskUserFreeformOption(option: string): boolean {
  return option === OMP_ASK_USER_FREEFORM_SENTINEL;
}

function mapExtensionUiRequestToPermission(
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  options: ExtensionUiMappingOptions = {},
): AgentPermissionRequest | null {
  const provider = options.provider ?? OMP_PROVIDER;
  const label = options.label ?? "OMP";
  switch (event.method) {
    case "select": {
      const selectOptions = readStringArray(event.options);
      if (options.combineOptionalComment) {
        return buildCombinedAskUserQuestionPermission(event, {
          provider,
          label,
          question: optionalString(event.title) ?? "Select an option",
          options: selectOptions,
          allowFreeform: options.allowFreeform === true,
        });
      }
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
        question: optionalString(event.title) ?? "Select an option",
        options: selectOptions,
        multiSelect: false,
      });
    }
    case "input": {
      const placeholder = optionalString(event.placeholder);
      const title = optionalString(event.title);
      const allowEmpty = isOptionalInputPlaceholder(placeholder);
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
        question: getInputQuestionTitle(title, placeholder),
        options: [],
        multiSelect: false,
        ...(placeholder ? { placeholder } : {}),
        ...(allowEmpty ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
        question: optionalString(event.title) ?? "Edit text",
        options: [],
        multiSelect: false,
      });
    case "confirm":
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
        question: [optionalString(event.title), optionalString(event.message)]
          .filter(Boolean)
          .join("\n\n"),
        options: ["Yes", "No"],
        multiSelect: false,
      });
    default:
      return null;
  }
}

function isExtensionUiRequestEvent(
  event: OmpRuntimeEvent,
): event is Extract<OmpRuntimeEvent, { type: "extension_ui_request" }> {
  return event.type === "extension_ui_request" && typeof event.id === "string";
}

function isProcessExitEvent(
  event: OmpRuntimeEvent,
): event is Extract<OmpRuntimeEvent, { type: "process_exit" }> {
  return event.type === "process_exit" && typeof event.error === "string";
}

function isOmpAgentSessionEvent(event: OmpRuntimeEvent): event is OmpAgentSessionEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_end":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "compaction_start":
    case "compaction_end":
    case "agent_end":
      return true;
    default:
      return false;
  }
}

function buildExtensionUiQuestionPermission(
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    provider: AgentProvider;
    label: string;
    question: string;
    options: string[];
    multiSelect: boolean;
    placeholder?: string;
    allowEmpty?: boolean;
    dismissLabel?: string;
  },
): AgentPermissionRequest {
  return {
    id: event.id,
    provider: input.provider,
    name: `${input.label} ${event.method}`,
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: input.options.map((label) => ({ label })),
          multiSelect: input.multiSelect,
          ...(input.placeholder ? { placeholder: input.placeholder } : {}),
          ...(input.allowEmpty ? { allowEmpty: true } : {}),
          ...(input.dismissLabel ? { dismissLabel: input.dismissLabel } : {}),
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
    },
  };
}

function buildCombinedAskUserQuestionPermission(
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    provider: AgentProvider;
    label: string;
    question: string;
    options: string[];
    allowFreeform: boolean;
  },
): AgentPermissionRequest {
  const visibleOptions = input.options.filter((option) => !isOmpAskUserFreeformOption(option));
  const allowOther = input.allowFreeform || visibleOptions.length !== input.options.length;
  return {
    id: event.id,
    provider: input.provider,
    name: `${input.label} ask_user`,
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: visibleOptions.map((label) => ({ label })),
          multiSelect: false,
          ...(allowOther ? { allowOther: true } : {}),
        },
        {
          question: "Optional comment",
          header: QUESTION_COMMENT_HEADER,
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
      commentHeader: QUESTION_COMMENT_HEADER,
      combinedAskUser: COMBINED_ASK_USER_METADATA,
      selectOptions: visibleOptions,
      ...(allowOther ? { freeformSentinel: OMP_ASK_USER_FREEFORM_SENTINEL } : {}),
    },
  };
}

function permissionAnswer(input: AgentMetadata | undefined, header: string): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const answer = answers[header];
  return typeof answer === "string" ? answer : null;
}

function firstPermissionAnswer(input: AgentMetadata | undefined): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const first = Object.values(answers).find((value) => typeof value === "string");
  return typeof first === "string" ? first : null;
}

function isCombinedAskUserPermission(request: AgentPermissionRequest): boolean {
  return request.metadata?.combinedAskUser === COMBINED_ASK_USER_METADATA;
}

function buildCombinedAskUserSelectionResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): {
  uiResponse: { value?: string; cancelled?: boolean };
  pendingResponse: PendingCombinedAskUserResponse | null;
} {
  if (response.behavior === "deny") {
    return { uiResponse: { cancelled: true }, pendingResponse: null };
  }

  const answer = permissionAnswer(response.updatedInput, QUESTION_RESPONSE_HEADER);
  if (answer === null) {
    return { uiResponse: { cancelled: true }, pendingResponse: null };
  }

  const selectOptions = readStringArray(request.metadata?.selectOptions);
  const freeformSentinel = optionalString(request.metadata?.freeformSentinel);
  const isFreeform = Boolean(freeformSentinel) && !selectOptions.includes(answer);
  const comment = permissionAnswer(response.updatedInput, QUESTION_COMMENT_HEADER) ?? "";
  return {
    uiResponse: { value: isFreeform ? freeformSentinel : answer },
    pendingResponse: {
      comment,
      freeform: isFreeform ? answer : null,
    },
  };
}

function buildExtensionUiResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): { value?: string; confirmed?: boolean; cancelled?: boolean } {
  if (response.behavior === "deny") {
    return { cancelled: true };
  }

  const method = optionalString(request.metadata?.extensionUiMethod);
  const answer = firstPermissionAnswer(response.updatedInput);
  if (answer === null) {
    return { cancelled: true };
  }

  if (method === "confirm") {
    return { confirmed: /^yes$/i.test(answer.trim()) };
  }
  return { value: answer };
}

function createRuntime(
  logger: Logger,
  runtimeSettings: ProviderRuntimeSettings | undefined,
): OmpRuntime {
  return new OmpCliRuntime({
    logger,
    runtimeSettings,
    command: ["omp"],
    commandsRpcName: "get_available_commands",
  });
}

export class OmpAgentSession implements AgentSession {
  readonly provider: AgentProvider = OMP_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = withOmpCapabilities();

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, OmpTrackedToolCall>();
  private readonly pendingExtensionUiRequests = new Map<string, AgentPermissionRequest>();
  private activeAskUserDialog: ActiveAskUserDialog | null = null;
  private pendingCombinedAskUserResponse: PendingCombinedAskUserResponse | null = null;
  private activeTurnId: string | null = null;
  private activeClientMessageId: string | null = null;
  /**
   * Survives false local-only `completeTurn` so a delayed native user echo can
   * still carry the submitted prompt's clientMessageId for timeline reconcile.
   * Cleared when a native user message with that binding is emitted, or when the
   * next `startTurn` replaces it.
   */
  private pendingClientMessageBinding: { clientMessageId: string; text: string } | null = null;
  private activeAssistantMessageId: string | null = null;
  private activeTurnTerminalAssistantMessage: OmpAgentMessage | null = null;
  private activeTurnStarted = false;
  private activeTurnHasUserMessage = false;
  /**
   * Bumped by `startTurn` and by every terminal turn emit. Lets the
   * provider-idle wait detect that its cycle was settled (or superseded) by
   * another path instead of guessing from the mutable turn fields.
   */
  private turnGeneration = 0;
  private activeNoTurnPromptText: string | null = null;
  private readonly pendingNoTurnOutputs: Array<{ turnId: string; message: string }> = [];
  private activePromptRequestId: string | null = null;
  private activePromptAgentInvoked: boolean | null = null;
  private readonly pendingPromptResults = new Map<string, boolean>();
  private pendingNoTurnCompletionAbort: AbortController | null = null;
  private lastKnownThinkingOptionId: string | null;
  private outOfBandCompactionEmit: ((event: AgentStreamEvent) => void) | null = null;
  private outOfBandCompactionStarted = false;
  private outOfBandCompactionCompleted = false;
  private commandCache: AgentSlashCommand[] | null = null;
  private readonly subagentIndex = new OmpSubagentIndex();
  private readonly subagentCardTracker: OmpSubagentCardTracker;
  private lastTodoItem: Extract<AgentTimelineItem, { type: "todo" }> | null = null;
  private state: OmpSessionState;
  private readonly currentModeId: string | null;
  private readonly providerIdleScheduler: OmpProviderIdleScheduler;
  private readonly noTurnScheduler: OmpNoTurnScheduler;
  private readonly usagePoller: OmpUsagePoller;
  private closed = false;
  // Set when the RPC child process is gone for good: an observed exit, or a
  // force-close after a hung abort. Distinct from `closed`, which only covers
  // teardown Paseo initiated — an OMP that crashes or is OOM-killed leaves
  // `closed` false with nothing behind the session.
  private runtimeExited = false;
  private live: boolean;
  // True once an abort missed its short ack window while the RPC process was
  // still alive. The next interrupt escalates to a force-close; a terminal turn
  // event clears it.
  private unackedAbort = false;
  private readonly emittedUserMessageIds = new Set<string>();

  constructor(options: OmpAgentSessionOptions) {
    this.runtimeSession = options.runtimeSession;
    this.config = options.config;
    this.state = options.initialState;
    this.currentModeId = options.currentModeId ?? null;
    this.logger = options.logger;
    this.paseoTools = options.paseoTools;
    this.live = options.live ?? true;
    this.providerIdleScheduler = options.providerIdleScheduler ?? createOmpProviderIdleScheduler();
    this.noTurnScheduler = options.noTurnScheduler ?? createOmpNoTurnScheduler();
    this.usagePoller = new OmpUsagePoller({
      scheduler: options.usagePollScheduler,
      readStats: () => this.runtimeSession.getSessionStats(),
      onUsage: (usage, turnId) => {
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          usage,
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
      onPollError: (error) => {
        this.logger.debug({ err: error }, "OMP context usage poll failed");
      },
    });
    this.subagentCardTracker = new OmpSubagentCardTracker({
      scheduler: options.subagentCardScheduler,
    });
    this.lastKnownThinkingOptionId =
      normalizeOmpThinkingOption(options.config.thinkingOptionId) ??
      this.state.thinkingLevel ??
      null;
    this.runtimeSession.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
    void this.runtimeSession.setSubagentSubscription("events").catch((eventsError: unknown) => {
      this.logger.debug(
        { err: eventsError },
        "OMP subagent event subscription unavailable; falling back to progress",
      );
      void this.runtimeSession
        .setSubagentSubscription("progress")
        .catch((progressError: unknown) => {
          this.logger.debug(
            { err: progressError },
            "OMP subagent progress subscription unavailable",
          );
        });
    });
  }

  private readonly runtimeSession: OmpRuntimeSession;
  private readonly config: AgentSessionConfig;
  private readonly logger: Logger;
  private readonly paseoTools?: PaseoToolCatalog;

  get id(): string | null {
    return this.state.sessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.state.sessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<StartTurnResult> {
    if (this.activeTurnId) {
      throw new Error("An OMP turn is already active");
    }

    const payload = convertPromptInput(prompt, { model: this.state.model });
    const turnId = randomUUID();
    this.turnGeneration += 1;
    this.live = true;
    this.activeTurnId = turnId;
    this.activeClientMessageId = options?.clientMessageId ?? null;
    this.pendingClientMessageBinding = options?.clientMessageId
      ? { clientMessageId: options.clientMessageId, text: payload.text }
      : null;
    this.activeAssistantMessageId = null;
    this.activeTurnTerminalAssistantMessage = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.activePromptRequestId = null;
    this.clearNoTurnBuffers();
    this.activeNoTurnPromptText = payload.text;
    this.usagePoller.startTurn();

    void (async () => {
      try {
        const ack = await this.runtimeSession.prompt(payload.text, payload.images);
        this.activePromptRequestId = ack.requestId ?? null;
        const correlatedResult = ack.requestId
          ? this.pendingPromptResults.get(ack.requestId)
          : undefined;
        if (ack.requestId) {
          this.pendingPromptResults.delete(ack.requestId);
        }
        this.activePromptAgentInvoked = correlatedResult ?? ack.agentInvoked ?? null;
        if (correlatedResult === false) {
          this.scheduleNoTurnPromptCompletion(turnId);
          return;
        }
        if (correlatedResult !== true && ack.agentInvoked === false) {
          await this.completeNoTurnPrompt(turnId);
          return;
        }
      } catch (error) {
        if (this.activeTurnId !== turnId) {
          return;
        }
        this.usagePoller.stopTurn();
        this.activeTurnId = null;
        this.activeClientMessageId = null;
        this.activeTurnStarted = false;
        this.activeTurnHasUserMessage = false;
        this.activeAssistantMessageId = null;
        this.activeTurnTerminalAssistantMessage = null;
        this.clearNoTurnBuffers();
        if (isOmpRequestAbortError(error)) {
          this.emitTurnTerminal({
            type: "turn_canceled",
            provider: this.provider,
            turnId,
            reason: toDiagnosticErrorMessage(error),
          });
          return;
        }
        this.emitTurnTerminal({
          type: "turn_failed",
          provider: this.provider,
          turnId,
          error: toDiagnosticErrorMessage(error),
        });
      }
    })();

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* streamOmpHistory({
      sessionFile: this.state.sessionFile,
      runtimeSession: this.runtimeSession,
      provider: this.provider,
    });
    for (const item of mapOmpTodoState(this.state)) {
      yield {
        type: "timeline",
        provider: this.provider,
        item,
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    await this.refreshState();
    return {
      provider: this.provider,
      sessionId: this.state.sessionId,
      model: modelToId(this.state.model),
      thinkingOptionId: resolveThinkingOptionId(
        this.lastKnownThinkingOptionId,
        this.state.thinkingLevel,
      ),
      modeId: this.currentModeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...OMP_MODES];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentModeId;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    if (!OMP_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`Invalid OMP mode '${modeId}'`);
    }
    return {
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingExtensionUiRequests.values()];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const request = this.pendingExtensionUiRequests.get(requestId);
    if (!request) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    this.pendingExtensionUiRequests.delete(requestId);

    if (isCombinedAskUserPermission(request)) {
      const combined = buildCombinedAskUserSelectionResponse(request, response);
      this.pendingCombinedAskUserResponse = combined.pendingResponse;
      this.runtimeSession.respondToExtensionUiRequest(requestId, combined.uiResponse);
    } else {
      this.runtimeSession.respondToExtensionUiRequest(
        requestId,
        buildOmpRpcUiPermissionResponse(request, response) ??
          buildExtensionUiResponse(request, response),
      );
    }
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.state.sessionId,
      nativeHandle: this.state.sessionFile,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId ? { thinkingOptionId: this.config.thinkingOptionId } : {}),
        ...(this.currentModeId ? { modeId: this.currentModeId } : {}),
        // The launch contract must survive a resume even when the resume
        // overrides omit it: buildResumeConfig merges handle metadata under
        // the overrides, so a session resumed with no overrides (or by a
        // caller that dropped the contract fields) keeps the allowlist and
        // replace-mode prompt instead of coming back with the default toolset
        // (live incident: a recreated Commander lost its fleet_* tools on a
        // resume variant that dropped systemPromptMode/toolAllowlist).
        ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
        ...(this.config.systemPromptMode ? { systemPromptMode: this.config.systemPromptMode } : {}),
        ...(this.config.toolAllowlist?.length ? { toolAllowlist: this.config.toolAllowlist } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    const unackedAbort = await this.abortForInterrupt(turnId);
    if (unackedAbort) {
      // The turn is still genuinely running, so leave it alone and surface the
      // failed stop. AgentManager reports "refused" and the pending retry
      // usually lands within a second; pressing Stop again escalates to a
      // force-close.
      throw unackedAbort;
    }
    try {
      this.terminalizeActiveWork();
      this.usagePoller.stopTurn();
      if (turnId && this.activeTurnId === turnId) {
        this.activeTurnId = null;
        this.activeClientMessageId = null;
        this.activeTurnStarted = false;
        this.activeTurnHasUserMessage = false;
        this.activeAssistantMessageId = null;
        this.activeTurnTerminalAssistantMessage = null;
        this.clearNoTurnBuffers();
        this.emitTurnTerminal({
          type: "turn_canceled",
          provider: this.provider,
          reason: "interrupted",
          turnId,
        });
      } else if (!turnId && this.activeTurnId == null) {
        // Lifecycle can remain "running" in AgentManager after the provider
        // process dies with no active turn id. Emit a bare cancel so cancel
        // settlement can clear the sticky busy state.
        this.emitTurnTerminal({
          type: "turn_canceled",
          provider: this.provider,
          reason: "interrupted",
        });
      }
    } catch (error) {
      // Interrupt must never throw: a dead OMP process is exactly when Stop
      // needs to succeed and clear sticky running.
      this.logger.warn(
        { err: error, turnId: turnId ?? undefined },
        "OMP interrupt failed; emitting forced cancel",
      );
      this.closed = true;
      this.terminalizeActiveWork();
      this.usagePoller.stopTurn();
      this.activeTurnId = null;
      this.activeClientMessageId = null;
      this.activeTurnStarted = false;
      this.activeTurnHasUserMessage = false;
      this.activeAssistantMessageId = null;
      this.activeTurnTerminalAssistantMessage = null;
      this.clearNoTurnBuffers();
      this.emitTurnTerminal({
        type: "turn_canceled",
        provider: this.provider,
        reason: "interrupted",
        ...(turnId ? { turnId } : {}),
      });
    }
  }

  /**
   * Sends `abort` for an interactive stop. Returns the error when the RPC
   * process is alive but missed the short ack window; in every other case the
   * runtime is already dead (or has just been force-closed here) and the caller
   * proceeds to cancel the turn locally.
   */
  private async abortForInterrupt(turnId: string | null): Promise<unknown> {
    try {
      await this.runtimeSession.abort();
      this.unackedAbort = false;
      return undefined;
    } catch (error) {
      // A missed ack means "slow", not "dead". OMP answers abort in tens of
      // milliseconds when healthy, so the 1s budget only lapses on an event-loop
      // stall — a large context on a loaded host is enough. Force-closing here
      // kills a session that is mid-turn, which is how a busy agent used to lose
      // its OMP process and then reject every following prompt with "OMP RPC
      // process is closed". Any other failure means the process really is gone.
      const ackTimedOut = /request timed out for abort/i.test(toDiagnosticErrorMessage(error));
      if (ackTimedOut && !this.unackedAbort) {
        this.unackedAbort = true;
        this.logger.warn(
          { err: error, turnId: turnId ?? undefined },
          "OMP abort did not acknowledge in time; retrying instead of closing",
        );
        this.retryAbortInBackground(turnId);
        return error;
      }
      // Either the RPC process is already gone, or a previous abort is still
      // unanswered and Stop was pressed again — a genuine hang. Force-close the
      // RPC process so stop/replace can settle instead of refusing forever. Do
      // not await the full tree-kill here: AgentManager only gives ~2s for
      // interrupt() to acknowledge, and kill can take longer.
      this.unackedAbort = false;
      this.logger.warn(
        { err: error, turnId: turnId ?? undefined },
        "OMP abort failed during interrupt; forcing runtime close",
      );
      this.closed = true;
      this.runtimeExited = true;
      this.clearOmpSessionState();
      void this.runtimeSession.close().catch((closeError: unknown) => {
        this.logger.warn(
          { err: closeError, turnId: turnId ?? undefined },
          "OMP force-close after failed abort also failed",
        );
      });
      return undefined;
    }
  }

  private retryAbortInBackground(turnId: string | null): void {
    void (async () => {
      try {
        await this.runtimeSession.abort(OMP_BACKGROUND_ABORT_TIMEOUT_MS);
        this.unackedAbort = false;
      } catch (error) {
        if (this.closed) {
          return;
        }
        this.logger.warn(
          { err: error, turnId: turnId ?? undefined },
          "OMP background abort retry failed",
        );
      }
    })();
  }

  isRuntimeAlive(): boolean {
    return !this.closed && !this.runtimeExited;
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Cannot rewind the OMP conversation while a turn is active");
    }
    const target = input.messageId.trim();
    if (!target) {
      throw new Error("OMP rewind requires a user message id");
    }
    await this.runtimeSession.branch(target);
    await this.refreshState();
    this.activeToolCalls.clear();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.usagePoller.close();
    this.cancelNoTurnPromptCompletion();
    try {
      await this.runtimeSession.close();
    } finally {
      this.clearOmpSessionState();
    }
  }

  private clearOmpSessionState(): void {
    this.subagentIndex.clear(this.runtimeSession);
    this.clearOmpTurnState();
  }

  private clearOmpTurnState(): void {
    clearOmpHostToolState(this.runtimeSession);
    this.subagentCardTracker.clear();
  }

  private terminalizeActiveWork(): void {
    for (const [toolCallId, toolCall] of this.activeToolCalls) {
      this.emitToolCallEvent(toolCallId, toolCall, "canceled", null, null);
    }
    this.activeToolCalls.clear();
    for (const event of this.subagentIndex.terminalizeRunning(this.runtimeSession)) {
      this.emit(event);
    }
    this.clearOmpTurnState();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    if (this.commandCache) {
      return this.commandCache;
    }
    const commands = await this.runtimeSession.getCommands();
    return mapOmpRuntimeSlashCommands(commands);
  }

  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): { run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void> } | null {
    if (typeof prompt !== "string") {
      return null;
    }
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) {
      return null;
    }
    this.live = true;
    const commandName = parsed.commandName.toLowerCase();
    if (commandName === "compact") {
      return {
        run: async ({ emit }) => {
          await this.executeCompactCommand(parsed.args, emit);
        },
      };
    }
    if (commandName === "autocompact") {
      return {
        run: async ({ emit }) => {
          await this.executeAutoCompactCommand(parsed.args, emit);
        },
      };
    }
    if (commandName === "steer" || commandName === "follow-up") {
      const message = parsed.args?.trim();
      if (!message) {
        return null;
      }
      return {
        run: async () => {
          if (commandName === "steer") {
            this.runtimeSession.steer(message);
          } else {
            this.runtimeSession.followUp(message);
          }
        },
      };
    }
    if (commandName === "handoff") {
      return {
        run: async ({ emit }) => {
          await this.executeHandoffCommand(parsed.args, emit);
        },
      };
    }
    return null;
  }

  async setModel(modelId: string | null): Promise<void> {
    const parsedReference = parseModelReference(modelId);
    if (!parsedReference) {
      return;
    }
    if (!parsedReference.provider) {
      throw new Error(`OMP model id must include a provider: ${modelId}`);
    }

    const model = await this.runtimeSession.setModel(parsedReference.provider, parsedReference.id);
    this.state = {
      ...this.state,
      model,
    };
    this.config.model = `${model.provider}/${model.id}`;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const thinkingLevel =
      normalizeOmpThinkingOption(thinkingOptionId) ?? DEFAULT_OMP_THINKING_LEVEL;
    await this.runtimeSession.setThinkingLevel(thinkingLevel);
    this.lastKnownThinkingOptionId = thinkingLevel;
    this.config.thinkingOptionId = thinkingLevel;
    this.state = {
      ...this.state,
      thinkingLevel,
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /**
   * Every terminal turn event MUST go through here. `turnGeneration` is the
   * "someone already settled the current provider cycle" token: the idle-wait
   * loop captures it on entry so it can tell "another path terminalized this
   * turn" from "I gave up silently". A silent give-up latches AgentManager at
   * lifecycle=running forever with no way back except an explicit Stop.
   */
  private emitTurnTerminal(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  ): void {
    this.turnGeneration += 1;
    // The turn is over, so a lapsed abort ack from it must not make the next
    // Stop escalate straight to a force-close.
    this.unackedAbort = false;
    this.emit(event);
  }

  private currentTurnIdForEvent(): string | undefined {
    return this.activeTurnId ?? undefined;
  }

  private scheduleNoTurnPromptCompletion(turnId: string): void {
    this.cancelNoTurnPromptCompletion();
    const abort = new AbortController();
    this.pendingNoTurnCompletionAbort = abort;
    void this.noTurnScheduler
      .waitForSettle(abort.signal)
      .then(async () => {
        if (this.pendingNoTurnCompletionAbort !== abort) {
          return undefined;
        }
        this.pendingNoTurnCompletionAbort = null;
        return await this.completeNoTurnPrompt(turnId);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.logger.debug({ err: error }, "OMP local-only settle wait failed");
        }
      });
  }

  private cancelNoTurnPromptCompletion(): void {
    this.pendingNoTurnCompletionAbort?.abort();
    this.pendingNoTurnCompletionAbort = null;
  }

  private async completeNoTurnPrompt(turnId: string): Promise<void> {
    await waitForImmediate();
    if (
      this.closed ||
      this.activeTurnId !== turnId ||
      this.activeTurnStarted ||
      this.activePromptAgentInvoked === true ||
      this.activeTurnHasUserMessage
    ) {
      return;
    }
    this.emitBufferedNoTurnOutputs(turnId);
    this.completeTurn(turnId, []);
  }

  private clearNoTurnBuffers(): void {
    this.cancelNoTurnPromptCompletion();
    this.activeNoTurnPromptText = null;
    this.activePromptRequestId = null;
    this.activePromptAgentInvoked = null;
    this.pendingNoTurnOutputs.splice(0, this.pendingNoTurnOutputs.length);
  }

  private resolveClientMessageIdForUserText(text: string): string | null {
    if (this.activeClientMessageId) {
      return this.activeClientMessageId;
    }
    const pending = this.pendingClientMessageBinding;
    if (pending && pending.text === text) {
      return pending.clientMessageId;
    }
    return null;
  }

  private clearPendingClientMessageBinding(clientMessageId: string | null | undefined): void {
    if (clientMessageId && this.pendingClientMessageBinding?.clientMessageId === clientMessageId) {
      this.pendingClientMessageBinding = null;
    }
  }

  private emitBufferedNoTurnOutputs(turnId: string): void {
    const promptText = this.activeNoTurnPromptText;
    const outputs = this.pendingNoTurnOutputs.filter((output) => output.turnId === turnId);
    this.clearNoTurnBuffers();
    if (promptText) {
      const clientMessageId = this.resolveClientMessageIdForUserText(promptText);
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "user_message",
          text: promptText,
          ...(clientMessageId ? { clientMessageId } : {}),
        },
      });
    }
    for (const output of outputs) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "assistant_message",
          text: output.message,
        },
      });
    }
  }

  private bufferNoTurnOutput(message: string): void {
    if (!this.activeTurnId || this.activeTurnStarted) {
      return;
    }
    this.pendingNoTurnOutputs.push({ turnId: this.activeTurnId, message });
  }

  private parseSlashCommandInput(text: string): OmpSlashCommandInvocation | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
  }

  private async executeCompactCommand(
    customInstructions: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    if (this.outOfBandCompactionEmit) {
      throw new Error("An OMP compact command is already running");
    }
    this.outOfBandCompactionEmit = emit;
    this.outOfBandCompactionStarted = false;
    this.outOfBandCompactionCompleted = false;
    try {
      await this.runtimeSession.compact(customInstructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.outOfBandCompactionEmit === emit &&
        this.outOfBandCompactionStarted &&
        !this.outOfBandCompactionCompleted
      ) {
        this.emitCompactionTimeline({
          turnId: undefined,
          item: {
            type: "compaction",
            status: "completed",
            trigger: "manual",
          },
        });
      }
      emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to compact context: ${message}`,
        },
      });
    } finally {
      if (this.outOfBandCompactionEmit === emit && !this.outOfBandCompactionStarted) {
        this.outOfBandCompactionEmit = null;
        this.outOfBandCompactionStarted = false;
        this.outOfBandCompactionCompleted = false;
      }
    }
  }

  private async executeAutoCompactCommand(
    mode: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    let enabled = parseAutoCompactMode(mode);
    if (enabled === "unknown") {
      emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "assistant_message",
          text: "[Error] Usage: /autocompact [on|off|toggle]",
        },
      });
      return;
    }
    if (enabled === "toggle") {
      const state = await this.runtimeSession.getState();
      if (typeof state.autoCompactionEnabled !== "boolean") {
        emit({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "assistant_message",
            text: "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
          },
        });
        return;
      }
      enabled = !state.autoCompactionEnabled;
    }

    try {
      await this.runtimeSession.setAutoCompaction(enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to set auto-compaction: ${message}`,
        },
      });
      return;
    }
    this.state = {
      ...this.state,
      autoCompactionEnabled: enabled,
    };
    emit({
      type: "timeline",
      provider: this.provider,
      item: {
        type: "assistant_message",
        text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
      },
    });
  }

  private async executeHandoffCommand(
    instructions: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    try {
      await this.runtimeSession.handoff(instructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to hand off turn: ${message}`,
        },
      });
    }
  }

  private handleExtensionUiRequest(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  ): void {
    const message = optionalString(event.message);
    if (event.method === "notify" && message) {
      this.bufferNoTurnOutput(message);
    }

    const sideEffectItem = this.mapExtensionUiSideEffect(event);
    if (sideEffectItem) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId: this.currentTurnIdForEvent(),
        item: sideEffectItem,
      });
      return;
    }

    if (this.respondToCombinedAskUserFollowUp(event)) {
      return;
    }

    const shouldCombineOptionalComment =
      event.method === "select" &&
      this.activeAskUserDialog?.allowComment === true &&
      this.activeAskUserDialog.allowMultiple === false;
    const request =
      mapOmpRpcUiPermissionRequest(event, { provider: this.provider }) ??
      mapExtensionUiRequestToPermission(event, {
        provider: this.provider,
        label: "OMP",
        combineOptionalComment: shouldCombineOptionalComment,
        allowFreeform: this.activeAskUserDialog?.allowFreeform,
      });
    if (!request) {
      return;
    }

    this.pendingExtensionUiRequests.set(request.id, request);
    this.emit({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  private mapExtensionUiSideEffect(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  ): AgentTimelineItem | null {
    if (event.method !== "open_url" || typeof event.url !== "string") {
      return null;
    }
    const lines = [`[Open URL](${event.url})`, `URL: ${event.url}`];
    if (typeof event.launchUrl === "string") {
      lines.push(`Launch URL: ${event.launchUrl}`);
    }
    if (typeof event.instructions === "string") {
      lines.push("", event.instructions);
    }
    return { type: "assistant_message", text: lines.join("\n") };
  }

  private respondToCombinedAskUserFollowUp(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  ): boolean {
    const pending = this.pendingCombinedAskUserResponse;
    if (!pending || event.method !== "input") {
      return false;
    }

    const placeholder = optionalString(event.placeholder);
    if (pending.freeform !== null && !isOptionalInputPlaceholder(placeholder)) {
      this.pendingCombinedAskUserResponse = {
        ...pending,
        freeform: null,
      };
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: pending.freeform });
      return true;
    }

    if (isOptionalInputPlaceholder(placeholder)) {
      this.pendingCombinedAskUserResponse = null;
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: pending.comment });
      return true;
    }

    return false;
  }

  private handleCommandOutput(textValue: unknown): void {
    if (!this.activeTurnId) {
      return;
    }
    const text = stripAnsi(optionalString(textValue) ?? "").trim();
    if (!text) {
      return;
    }
    if (!this.activeTurnStarted) {
      this.bufferNoTurnOutput(text);
      return;
    }
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId: this.currentTurnIdForEvent(),
      item: { type: "assistant_message", text },
    });
  }

  private handleExtraRuntimeEvent(event: OmpRuntimeEvent): boolean {
    if (
      handleOmpHostToolRuntimeEvent(event, {
        runtimeSession: this.runtimeSession,
        paseoTools: this.paseoTools,
        logger: this.logger,
      })
    ) {
      return true;
    }
    if (event.type === "subagent_lifecycle") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_lifecycle" }>).payload;
      if (payload.parentToolCallId && this.activeToolCalls.has(payload.parentToolCallId)) {
        this.subagentCardTracker.handleLifecycle(payload, (toolCallId) =>
          this.emitActiveToolCall(toolCallId),
        );
      }
      for (const mapped of this.subagentIndex.handleLifecycle(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "subagent_progress") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_progress" }>).payload;
      if (payload.parentToolCallId && this.activeToolCalls.has(payload.parentToolCallId)) {
        this.subagentCardTracker.handleProgress(payload, (toolCallId) =>
          this.emitActiveToolCall(toolCallId),
        );
      }
      for (const mapped of this.subagentIndex.handleProgress(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "subagent_event") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_event" }>).payload;
      for (const mapped of this.subagentIndex.handleEvent(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "todo_reminder") {
      const item = mapOmpTodoReminderEvent(event);
      if (item) {
        this.emitTodoItem(item);
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP todo reminder event");
      }
      return true;
    }
    if (event.type === "available_commands_update") {
      const commands = mapOmpAvailableCommandsUpdate(event);
      if (commands) {
        this.commandCache = commands;
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP command update event");
      }
      return true;
    }
    const mappedEvent = mapOmpRuntimeEventToTimelineItem(event);
    if (!mappedEvent.handled) {
      return false;
    }
    if (mappedEvent.item) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        item: mappedEvent.item,
      });
    } else {
      this.logger.debug(
        { event, reason: mappedEvent.logReason },
        "Dropped unsupported OMP runtime event",
      );
    }
    return true;
  }

  private emitActiveToolCall(toolCallId: string): boolean {
    const toolCall = this.activeToolCalls.get(toolCallId);
    return toolCall ? this.emitToolCallEvent(toolCallId, toolCall, "running", null, null) : false;
  }

  private emitTodoItem(item: AgentTimelineItem, turnId?: string): void {
    if (item.type === "todo") {
      const previous = this.lastTodoItem;
      const isDuplicate =
        previous?.items.length === item.items.length &&
        previous.items.every((previousItem, index) => {
          const nextItem = item.items[index];
          return (
            nextItem?.text === previousItem.text && nextItem.completed === previousItem.completed
          );
        });
      if (isDuplicate) {
        return;
      }
      this.lastTodoItem = item;
    }
    this.emit({ type: "timeline", provider: this.provider, turnId, item });
  }

  private handleRuntimeEvent(event: OmpRuntimeEvent): void {
    if (isExtensionUiRequestEvent(event)) {
      this.handleExtensionUiRequest(event);
      return;
    }
    if (isProcessExitEvent(event)) {
      this.handleProcessExit(event.error);
      return;
    }
    if (event.type === "command_output") {
      this.handleCommandOutput(event.text);
      return;
    }
    if (event.type === "prompt_result") {
      const requestId = optionalString("id" in event ? event.id : undefined);
      const agentInvoked =
        "agentInvoked" in event && typeof event.agentInvoked === "boolean"
          ? event.agentInvoked
          : undefined;
      if (requestId && agentInvoked !== undefined) {
        if (requestId === this.activePromptRequestId && this.activeTurnId) {
          this.activePromptAgentInvoked = agentInvoked;
          if (agentInvoked === false) {
            this.scheduleNoTurnPromptCompletion(this.activeTurnId);
          } else {
            this.cancelNoTurnPromptCompletion();
          }
        } else if (this.activePromptRequestId === null) {
          this.pendingPromptResults.set(requestId, agentInvoked);
        }
      }
      return;
    }
    if (this.handleExtraRuntimeEvent(event)) {
      return;
    }
    if (isOmpAgentSessionEvent(event)) {
      if (event.type === "agent_start") {
        this.live = true;
      } else if (!this.live) {
        // A resumed OMP process replays session events for pre-existing
        // conversation on startup; that content is delivered via
        // streamHistory, so replay must not re-enter the live timeline.
        // The mid-turn variant is the dangerous one: live never became true
        // (or flipped back) while a turn is active, so a terminal like
        // agent_end would be swallowed and the lifecycle stays running.
        if (this.activeTurnStarted) {
          this.logger.warn(
            {
              eventType: event.type,
              activeTurnStarted: this.activeTurnStarted,
              activeTurnId: this.activeTurnId ?? null,
            },
            "omp.turn.session_event_outside_live_run",
          );
        }
        return;
      }
      this.handleSessionEvent(event);
      return;
    }
    this.logger.warn(
      { eventType: (event as { type?: string }).type },
      "Dropped unknown OMP runtime event",
    );
  }

  private handleProcessExit(error: string): void {
    this.runtimeExited = true;
    this.usagePoller.stopTurn();
    this.terminalizeActiveWork();
    this.subagentIndex.clear(this.runtimeSession);
    if (!this.activeTurnId) {
      // A provider-started turn (agent_start with no Paseo turn id) leaves
      // AgentManager running with nothing to settle it. Emit a bare terminal so
      // a crashed OMP does not require a manual Stop. Suppressed once close()
      // has run: that exit is expected and the agent is being torn down.
      if (this.activeTurnStarted && !this.closed) {
        this.activeTurnStarted = false;
        this.activeTurnHasUserMessage = false;
        this.activeTurnTerminalAssistantMessage = null;
        this.clearNoTurnBuffers();
        this.logger.warn({ error }, "omp.turn.process_exit_without_turn_id");
        this.emitTurnTerminal({ type: "turn_failed", provider: this.provider, error });
      }
      return;
    }
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.activeClientMessageId = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.activeTurnTerminalAssistantMessage = null;
    this.clearNoTurnBuffers();
    this.emitTurnTerminal({
      type: "turn_failed",
      provider: this.provider,
      turnId,
      error,
    });
  }

  private handleSessionEvent(event: OmpAgentSessionEvent): void {
    const turnId = this.currentTurnIdForEvent();

    switch (event.type) {
      case "agent_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        this.emit({
          type: "thread_started",
          provider: this.provider,
          sessionId: this.state.sessionId,
        });
        return;
      case "turn_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        this.emit({
          type: "turn_started",
          provider: this.provider,
          turnId,
        });
        return;
      case "message_start":
        this.handleMessageStart(event);
        return;
      case "message_end":
        if (event.message.role === "user") {
          this.activeTurnHasUserMessage = true;
        }
        this.handleMessageEnd(event, turnId);
        return;
      case "message_update":
        this.handleMessageUpdate(event, turnId);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.activeAskUserDialog = readActiveAskUserDialog(event.toolName, event.args);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }

        const partialResult = parseToolResult(event.partialResult);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", partialResult, null);
        return;
      }
      case "tool_execution_end": {
        this.handleToolExecutionEnd(event, turnId);
        return;
      }
      case "compaction_start":
        this.emitCompactionTimeline({
          turnId,
          item: {
            type: "compaction",
            status: "loading",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "compaction_end":
        this.emitCompactionTimeline({
          turnId,
          item: {
            type: "compaction",
            status: "completed",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "agent_end":
        this.handleAgentEnd(event, turnId);
        return;
      default:
        return;
    }
  }

  private handleToolExecutionEnd(
    event: Extract<OmpAgentSessionEvent, { type: "tool_execution_end" }>,
    turnId: string | undefined,
  ): void {
    const toolCall =
      this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
    this.activeToolCalls.delete(event.toolCallId);

    if (event.toolName === "ask_user") {
      this.activeAskUserDialog = null;
      this.pendingCombinedAskUserResponse = null;
    }

    const result = parseToolResult(event.result);
    const error = event.isError ? event.result : null;
    const status = event.isError ? "failed" : "completed";
    this.emitToolCallEvent(event.toolCallId, toolCall, status, result, error);
    if (event.toolName === "task") {
      this.subagentCardTracker.delete(event.toolCallId);
    }
    if (event.toolName === "todo") {
      const item = mapOmpTodoToolResult(result);
      if (item) {
        this.emitTodoItem(item, turnId);
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP todo tool result");
      }
    }
  }

  private emitCompactionTimeline(input: {
    turnId: string | undefined;
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"];
  }): void {
    const emitOutOfBand = this.outOfBandCompactionEmit;
    if (emitOutOfBand && input.item.type === "compaction") {
      if (input.item.status === "loading") {
        this.outOfBandCompactionStarted = true;
      }
      if (input.item.status === "completed") {
        this.outOfBandCompactionCompleted = true;
      }
    }
    const event: AgentStreamEvent = {
      type: "timeline",
      provider: this.provider,
      ...(emitOutOfBand ? {} : { turnId: input.turnId }),
      item: input.item,
    };
    if (emitOutOfBand) {
      emitOutOfBand(event);
      if (input.item.type === "compaction" && input.item.status === "completed") {
        this.outOfBandCompactionEmit = null;
        this.outOfBandCompactionStarted = false;
        this.outOfBandCompactionCompleted = false;
      }
      return;
    }
    this.emit(event);
  }

  private handleMessageUpdate(
    event: Extract<OmpAgentSessionEvent, { type: "message_update" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      // Omp-compatible runtimes may emit updates without a preceding message_start.
      this.activeAssistantMessageId ??= event.message.responseId || randomUUID();
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "assistant_message",
          text: event.assistantMessageEvent.delta ?? "",
          messageId: this.activeAssistantMessageId,
        },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "reasoning",
          text: event.assistantMessageEvent.delta ?? "",
        },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "error") {
      // omp 17.2+ streams model-stream failures as message_update events with
      // assistantMessageEvent.type "error". These used to fail schema
      // validation and vanish (omp.rpc.schema_drop), leaving a stalled turn
      // with no error trail. Surface them so the timeline shows why the
      // stream stopped.
      const errorMessage =
        event.message.role === "assistant" ? event.message.errorMessage : undefined;
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "error",
          message:
            errorMessage?.slice(0, 64 * 1024) ??
            (event.assistantMessageEvent.reason === "aborted"
              ? "Agent turn aborted by the provider"
              : "Agent model stream failed"),
        },
      });
    }
  }

  private handleMessageStart(
    event: Extract<OmpAgentSessionEvent, { type: "message_start" }>,
  ): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = event.message.responseId || null;
    }
  }

  private handleMessageEnd(
    event: Extract<OmpAgentSessionEvent, { type: "message_end" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = null;
      if (turnId) {
        this.activeTurnTerminalAssistantMessage = event.message;
      } else {
        // No active turn id: this is a provider-initiated (autonomous) turn,
        // or the turn binding was lost. The terminal assistant message is not
        // recorded, so a later agent_end with an empty messages array cannot
        // settle the turn through the fallback below. Debug-only here — the
        // per-turn warning lives at agent_end (agent_end_without_assistant_message).
        this.logger.debug(
          {
            activeTurnStarted: this.activeTurnStarted,
            activeTurnId: this.activeTurnId ?? null,
          },
          "omp.turn.assistant_message_without_turn_id",
        );
      }
      return;
    }
    if (event.message.role === "custom") {
      if (shouldDisplayOmpCustomMessage(event.message)) {
        const text = getUserMessageText(event.message.content);
        if (text) {
          const item =
            mapOmpAdvisorMessageToToolCall(event.message, text) ??
            mapOmpSystemNoticeToToolCall(text);
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: item ?? { type: "assistant_message", text },
          });
        }
      }
      if (!this.activeTurnHasUserMessage) {
        this.completeTurn(turnId, []);
      }
      return;
    }

    if (event.message.role !== "user") {
      return;
    }
    const text = getUserMessageText(event.message.content);
    if (!text) {
      return;
    }
    const nativeMessage = event.message as OmpAgentMessage & { id?: unknown; entryId?: unknown };
    const messageId = readNativeMessageId(nativeMessage);
    const clientMessageId = this.resolveClientMessageIdForUserText(text);
    const emitUserMessage = (resolvedMessageId?: string): void => {
      if (resolvedMessageId) {
        // OMP re-emits user message_end frames for entries it has already
        // surfaced (e.g. after steer or a resumed process); emit each native
        // entry exactly once.
        if (this.emittedUserMessageIds.has(resolvedMessageId)) {
          return;
        }
        this.emittedUserMessageIds.add(resolvedMessageId);
      }
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "user_message",
          text,
          ...(resolvedMessageId ? { messageId: resolvedMessageId } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        },
      });
      // Native provider identity means the submitted prompt echo was observed;
      // drop the binding so a later same-text autonomous user message does not
      // inherit it. Keep the binding across false local-only buffered emits
      // (no messageId) until this native echo arrives.
      if (resolvedMessageId) {
        this.clearPendingClientMessageBinding(clientMessageId);
      }
    };
    if (messageId) {
      emitUserMessage(messageId);
      return;
    }
    void this.runtimeSession
      .getBranchMessages()
      .then((messages) =>
        emitUserMessage(messages.toReversed().find((message) => message.text === text)?.entryId),
      )
      .catch((error: unknown) => {
        this.logger.debug(
          { err: error, sessionFile: this.state.sessionFile },
          "OMP native user message ID lookup failed",
        );
        emitUserMessage();
      });
  }

  private emitToolCallEvent(
    toolCallId: string,
    toolCall: OmpTrackedToolCall,
    status: "running" | "completed" | "failed" | "canceled",
    result: OmpToolResult,
    error: unknown,
  ): boolean {
    const turnId = this.currentTurnIdForEvent();
    const detail = this.mapToolDetail(toolCallId, toolCall, result);
    if (!detail) {
      return false;
    }
    const baseItem = {
      type: "tool_call" as const,
      callId: toolCallId,
      name: resolveToolCallName(toolCall, result),
      detail,
    };
    const item =
      status === "failed" ? { ...baseItem, status, error } : { ...baseItem, status, error: null };
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item,
    });
    return true;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: OmpTrackedToolCall,
    result: OmpToolResult,
  ): ToolCallDetail | null {
    return mapOmpToolDetail(toolCall, result, {
      toolCallId,
      mapSubagentDetail: (detail) =>
        this.subagentCardTracker.detailFor(toolCallId, detail) ?? detail,
    });
  }

  private handleAgentEnd(
    event: Extract<OmpAgentSessionEvent, { type: "agent_end" }>,
    turnId: string | undefined,
  ): void {
    const messages = event.messages ?? [];
    let terminalMessages: OmpAgentMessage[] | null = null;
    if (messages.some((message) => message.role === "assistant")) {
      terminalMessages = messages;
    } else if (this.activeTurnTerminalAssistantMessage) {
      terminalMessages = [this.activeTurnTerminalAssistantMessage];
    }
    // OMP can end an internal extension-notice cycle before it starts the
    // model turn for the same prompt. Ignore only cycles where neither the
    // terminal payload nor the live stream contained an assistant message.
    if (!terminalMessages) {
      this.logger.debug(
        {
          turnId,
          activeTurnStarted: this.activeTurnStarted,
          activeTurnId: this.activeTurnId ?? null,
          activeTurnTerminalAssistantMessage: this.activeTurnTerminalAssistantMessage !== null,
          messageCount: messages.length,
          messageRoles: messages.map((message) => message.role),
        },
        "omp.turn.agent_end_without_assistant_message",
      );
      return;
    }
    // Provider-idle waiting is for successful turns that still look busy
    // (stream/compact flags lag). Terminal failures — especially Anthropic
    // overloaded_error — can leave isStreaming stuck true forever. Fail
    // closed immediately so the UI surfaces [System Error] and leaves running.
    if (latestOmpErrorMessage(terminalMessages)) {
      this.completeTurn(turnId, terminalMessages);
      return;
    }
    // A state request is processed after OMP's RPC loop becomes promptable,
    // so do not advertise Paseo idle until it reports that transition.
    void this.completeTurnAfterProviderIdle(turnId, terminalMessages);
  }

  private completeTurn(turnId: string | undefined, messages: OmpAgentMessage[]): void {
    this.activeTurnId = null;
    this.activeClientMessageId = null;
    this.activeAssistantMessageId = null;
    this.activeTurnTerminalAssistantMessage = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.clearNoTurnBuffers();
    const errorMessage = latestOmpErrorMessage(messages);
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      this.usagePoller.stopTurn();
      this.emitTurnTerminal({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: errorMessage,
      });
      return;
    }
    const finalUsage = this.usagePoller.completeTurn(turnId);
    this.emitTurnTerminal({
      type: "turn_completed",
      provider: this.provider,
      turnId,
    });
    void this.refreshAfterTurn(finalUsage);
  }

  /**
   * `agent_end` is OMP's only signal that a turn is over, and this wait is the
   * only route from it to a terminal turn event. Bailing out without emitting
   * one latches AgentManager at lifecycle=running with no tracked turn: the
   * timeline is complete, the provider is idle, and the UI spins forever until
   * someone presses Stop. So every exit terminalizes unless another path
   * already did (turnGeneration moved) or the session is gone.
   */
  private async completeTurnAfterProviderIdle(
    turnId: string | undefined,
    messages: OmpAgentMessage[],
  ): Promise<void> {
    const generation = this.turnGeneration;
    const startedAt = Date.now();
    let lastState: OmpSessionState | null = null;
    let stateError: unknown;
    while (!this.closed && this.activeTurnStarted && this.currentTurnIdForEvent() === turnId) {
      try {
        const state = await this.runtimeSession.getState();
        this.state = state;
        lastState = state;
        stateError = undefined;
        if (!state.isStreaming && !state.isCompacting) {
          this.completeTurn(turnId, messages);
          return;
        }
      } catch (error) {
        stateError = error;
        this.logger.debug({ err: error }, "OMP state unavailable while waiting for provider idle");
      }
      if (Date.now() - startedAt >= PROVIDER_IDLE_WAIT_TIMEOUT_MS) {
        break;
      }
      await this.providerIdleScheduler.waitForRetry();
    }
    if (this.turnGeneration !== generation) {
      return;
    }
    if (this.closed) {
      this.logger.warn(
        { turnId, waitedMs: Date.now() - startedAt },
        "omp.turn.idle_wait_abandoned_closed",
      );
      return;
    }
    this.logger.warn(
      {
        turnId,
        waitedMs: Date.now() - startedAt,
        activeTurnStarted: this.activeTurnStarted,
        activeTurnId: this.activeTurnId,
        isStreaming: lastState?.isStreaming ?? null,
        isCompacting: lastState?.isCompacting ?? null,
        ...(stateError ? { err: stateError } : {}),
      },
      "omp.turn.idle_wait_abandoned_terminalizing",
    );
    this.completeTurn(turnId, messages);
  }

  private async refreshState(): Promise<void> {
    this.state = await this.runtimeSession.getState();
    if (this.state.thinkingLevel) {
      const normalized = normalizeOmpThinkingOption(this.state.thinkingLevel);
      if (normalized) {
        this.lastKnownThinkingOptionId = normalized;
      }
    }
  }

  private async refreshAfterTurn(finalUsage: Promise<void>): Promise<void> {
    await Promise.all([this.refreshState().catch(() => undefined), finalUsage]);
  }
}

export class OmpAgentClient implements AgentClient {
  readonly provider: AgentProvider = OMP_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = withOmpCapabilities();

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly providerParams: OmpRuntimeProviderParams;
  private readonly modelRoleParams: OmpModelRoleParams;
  private readonly subagentCardScheduler?: OmpSubagentCardScheduler;
  private readonly providerIdleScheduler?: OmpProviderIdleScheduler;
  private readonly noTurnScheduler?: OmpNoTurnScheduler;
  private readonly usagePollScheduler?: OmpUsagePollScheduler;
  private readonly runtime: OmpRuntime;
  private readonly warmPool: OmpWarmPool;

  constructor(options: OmpAgentClientOptions) {
    const { runtimeProviderParams, modelRoleParams } = resolveOmpProviderParams(
      options.providerParams,
    );
    const runtimeSettings = mergeOmpRuntimeSettings(
      {
        command: {
          mode: "replace",
          argv: ["omp"],
        },
      },
      options.runtimeSettings,
    );
    this.logger = options.logger;
    this.runtimeSettings = runtimeSettings;
    this.providerParams = runtimeProviderParams;
    this.modelRoleParams = modelRoleParams;
    this.subagentCardScheduler = options.subagentCardScheduler;
    this.providerIdleScheduler = options.providerIdleScheduler;
    this.noTurnScheduler = options.noTurnScheduler;
    this.usagePollScheduler = options.usagePollScheduler;
    this.runtime = options.runtime ?? createRuntime(options.logger, runtimeSettings);
    this.warmPool = new OmpWarmPool({ runtime: this.runtime, logger: this.logger });
    this.warmPool.start();
  }

  private async configureNativePaseoTools(
    runtimeSession: OmpRuntimeSession,
    catalog: PaseoToolCatalog | undefined,
  ): Promise<void> {
    if (!catalog) {
      return;
    }
    await setOmpHostTools(runtimeSession, catalog);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const launchMode = this.resolveLaunchMode(config.modeId);
    const systemPrompt = this.composeLaunchSystemPrompt(config);
    const paseoTools = filterPaseoToolsByAllowlist(launchContext?.paseoTools, config.toolAllowlist);
    if (!paseoTools && config.toolAllowlist?.length) {
      this.logger.warn(
        { provider: this.provider, allowlist: config.toolAllowlist },
        "Agent restricts tools to an allowlist but no Paseo host-tool catalog is available; only builtin/MCP tools will load",
      );
    }
    const runtimeSession = await this.startRuntimeSession(
      config,
      launchContext,
      launchMode,
      systemPrompt,
    );
    try {
      await this.configureNativePaseoTools(runtimeSession, paseoTools);
      return new OmpAgentSession({
        runtimeSession,
        config,
        initialState: await runtimeSession.getState(),
        currentModeId: launchMode.modeId,
        logger: this.logger,
        subagentCardScheduler: this.subagentCardScheduler,
        providerIdleScheduler: this.providerIdleScheduler,
        noTurnScheduler: this.noTurnScheduler,
        usagePollScheduler: this.usagePollScheduler,
        paseoTools,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * The system prompt handed to the omp process. Replace mode uses the
   * per-agent prompt verbatim — the daemon append prompt is append-only and
   * must not leak into a replaced harness.
   */
  private composeLaunchSystemPrompt(config: AgentSessionConfig): string | undefined {
    if (config.systemPromptMode === "replace") {
      return config.systemPrompt?.trim() || undefined;
    }
    return composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt);
  }

  /**
   * Launch (or hand off from the warm pool) the omp process backing a new
   * agent create. A pooled process is re-targeted to this create's workspace,
   * model and thinking level over RPC, so only launch-fixed differences force
   * a cold start: internal agents, per-create env, and custom system prompts.
   */
  private async startRuntimeSession(
    config: AgentSessionConfig,
    launchContext: AgentLaunchContext | undefined,
    launchMode: { modeId: string; extraArgs: string[] },
    systemPrompt: string | undefined,
  ): Promise<OmpRuntimeSession> {
    const thinking = normalizeOmpThinkingOption(config.thinkingOptionId) ?? undefined;
    const model = config.model;
    const poolEligible =
      config.internal !== true &&
      !hasSignificantLaunchEnv(launchContext?.env) &&
      !config.systemPrompt?.trim() &&
      // An allowlist is launch-fixed: pooled processes boot without the
      // tool-restriction flags and the --config overlay (appendOmpLaunchArgs),
      // and claims re-target over RPC only — they can never gain the
      // restriction after the fact. Allowlist sessions must cold start.
      !config.toolAllowlist?.length &&
      typeof model === "string" &&
      model.includes("/");
    if (poolEligible) {
      const pooled = await this.warmPool.claim({
        cwd: config.cwd,
        modeId: launchMode.modeId,
        extraArgs: launchMode.extraArgs,
        systemPrompt: systemPrompt ?? "",
        env: launchContext?.env,
      });
      if (pooled) {
        try {
          const slash = model.indexOf("/");
          await pooled.newSession();
          await pooled.setModel(model.slice(0, slash), model.slice(slash + 1));
          if (thinking) {
            await pooled.setThinkingLevel(thinking);
          }
          return pooled;
        } catch (error) {
          // The handoff left the pooled process in an unknown state; close it
          // and fall back to a cold launch rather than risk a broken agent.
          this.logger.warn(
            { err: error, provider: this.provider },
            "OMP warm pool handoff failed; cold starting",
          );
          await pooled.close().catch(() => undefined);
        }
      }
    }
    return this.runtime.startSession({
      cwd: config.cwd,
      protocolMode: "rpc-ui",
      model: config.model,
      thinkingOptionId: thinking,
      noSession: config.internal === true,
      modeId: launchMode.modeId,
      extraArgs: launchMode.extraArgs,
      systemPrompt,
      systemPromptMode: config.systemPromptMode,
      toolAllowlist: config.toolAllowlist,
      env: launchContext?.env,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const rawSessionFile = handle.nativeHandle;
    if (!rawSessionFile) {
      throw new Error("OMP resume requires a native session file handle");
    }
    const sessionFile = await resolveOmpSessionFile(rawSessionFile);

    const persistenceMetadata = parsePersistenceMetadata(handle.metadata);
    const resumeConfig = buildResumeConfig(persistenceMetadata, overrides, this.provider);

    const launchMode = this.resolveLaunchMode(resumeConfig.modeId);
    const runtimeSession = await this.runtime.startSession(
      buildResumeStartInput({
        resumeConfig,
        sessionFile,
        launchContext,
        launchMode,
      }),
    );
    try {
      const paseoTools = filterPaseoToolsByAllowlist(
        launchContext?.paseoTools,
        resumeConfig.config.toolAllowlist,
      );
      if (!paseoTools && resumeConfig.config.toolAllowlist?.length) {
        this.logger.warn(
          { provider: this.provider, allowlist: resumeConfig.config.toolAllowlist },
          "Resumed agent restricts tools to an allowlist but no Paseo host-tool catalog is available; only builtin/MCP tools will load",
        );
      }
      await this.configureNativePaseoTools(runtimeSession, paseoTools);
      return new OmpAgentSession({
        runtimeSession,
        config: resumeConfig.config,
        initialState: await runtimeSession.getState(),
        currentModeId: launchMode.modeId,
        logger: this.logger,
        subagentCardScheduler: this.subagentCardScheduler,
        providerIdleScheduler: this.providerIdleScheduler,
        noTurnScheduler: this.noTurnScheduler,
        usagePollScheduler: this.usagePollScheduler,
        paseoTools,
        live: false,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      throw error;
    }
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const launchMode = this.resolveLaunchMode(undefined);
    let runtimeSession: OmpRuntimeSession | undefined;
    let closePromise: Promise<void> | undefined;
    const closeSession = () => {
      if (!runtimeSession) return Promise.resolve();
      closePromise ??= runtimeSession.close();
      return closePromise;
    };
    const handleAbort = () => void closeSession().catch(() => undefined);
    context?.signal.addEventListener("abort", handleAbort, { once: true });
    try {
      await runProviderRefreshActivity(context, "runtime.start", async () => {
        runtimeSession = await this.runtime.startSession({
          cwd: options.scope === "global" ? homedir() : options.cwd,
          protocolMode: "rpc-ui",
          modeId: launchMode.modeId,
          extraArgs: launchMode.extraArgs,
          signal: context?.signal,
        });
        if (context?.signal.aborted) await closeSession();
      });
      if (!runtimeSession) throw new Error("OMP catalog runtime did not start");
      const catalogSession = runtimeSession;
      const models = transformOmpModels(
        (
          await runProviderRefreshActivity(context, "get_available_models", () =>
            catalogSession.getAvailableModels(null),
          )
        ).map((model) => mapOmpModel(model, this.provider)),
      );
      return { models, modes: [...OMP_MODES] };
    } finally {
      context?.signal.removeEventListener("abort", handleAbort);
      await closeSession();
    }
  }

  async listFeatures(_config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [];
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return await listOmpImportableSessions({
      ...options,
      sessionDir: this.providerParams.sessionDir,
      runtimeSettings: this.runtimeSettings,
    });
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const importConfig = await readOmpImportSessionConfig(input.providerHandleId);
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
      config: importConfig,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveOmpLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolveOmpLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const binaryRows = await buildBinaryDiagnosticRows(launch, availability, {
        versionCommand: {
          command: availability.resolvedPath ?? launch.command,
          args: [...launch.args, "--version"],
          env: this.runtimeSettings?.env,
        },
      });
      const version = binaryRows.find((row) => row.label === "Version")?.value ?? "unknown";
      const env = { ...process.env, ...this.runtimeSettings?.env };
      const paths = resolveOmpDiagnosticPaths(env);
      const bunVersion =
        (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unavailable";

      return {
        diagnostic: formatProviderDiagnostic("Oh My Pi (OMP)", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["omp", launch.command],
            pathValue: env.PATH ?? env.Path,
          })),
          ...binaryRows,
          { label: "Version support", value: formatOmpVersionSupport(version) },
          { label: "Active profile", value: paths.profile },
          { label: "Config root", value: paths.configRoot },
          { label: "Agent directory", value: paths.agentDir },
          {
            label: "Agent database",
            value: `${paths.agentDb} (${existsSync(paths.agentDb) ? "found" : "not found"})`,
          },
          { label: "XDG data root", value: paths.xdgDataRoot },
          { label: "XDG state root", value: paths.xdgStateRoot },
          { label: "XDG cache root", value: paths.xdgCacheRoot },
          {
            label: "Bun runtime",
            value: `${bunVersion}; npm-installed OMP requires Bun >= 1.3.14`,
          },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "OMP diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Oh My Pi (OMP)", error),
      };
    }
  }

  private resolveLaunchMode(modeId: string | undefined): {
    modeId: string;
    extraArgs: string[];
  } {
    try {
      return resolveOmpLaunchMode(modeId, this.modelRoleParams);
    } catch (error) {
      // A stored modeId can outlive a provider switch (e.g. claude
      // `bypassPermissions` persisted before the agent moved to omp). Fall
      // back to the default mode instead of failing the launch outright.
      this.logger.warn(
        { err: error, modeId },
        "Unsupported OMP mode; falling back to the default mode",
      );
      return resolveOmpLaunchMode(undefined, this.modelRoleParams);
    }
  }

  private async resolveOmpLaunch(): Promise<ResolvedProviderLaunch> {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: "omp",
    });
  }

  /**
   * Release pool-owned processes at daemon shutdown. Called via
   * AgentClient.shutdown (shutdownAgentClients) — must be idempotent.
   */
  async shutdown(): Promise<void> {
    await this.warmPool.closeAll();
  }
}
