import { fileURLToPath } from "node:url";

import type {
  OmpAgentMessage,
  OmpModel,
  OmpPromptAck,
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpSubagentSubscriptionLevel,
  OmpThinkingLevel,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

/**
 * Config overlay that pins omp's harness-utility feature gates off
 * (allowlist-overlay.yml). omp registers learn/manage_skill (autolearn),
 * checkpoint/rewind (checkpoint) and the SDK-injected tts custom tool
 * (speechgen) OUTSIDE the builtin catalog, so `--no-tools`/`--tools` cannot
 * remove them; the overlay forces the gates off for sessions that carry a
 * toolAllowlist. Loaded via `--config`, which outranks the user's global
 * config.yml for this process only.
 */
export const TOOL_ALLOWLIST_CONFIG_OVERLAY = fileURLToPath(
  new URL("./allowlist-overlay.yml", import.meta.url),
);

export interface OmpRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}

export interface OmpStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  toolAllowlist?: string[];
  extraArgs?: string[];
}

export interface OmpRuntimeSession {
  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(timeoutMs?: number): Promise<void>;
  getState(): Promise<OmpSessionState>;
  getMessages(): Promise<OmpAgentMessage[]>;
  getAvailableModels(timeoutMs?: number): Promise<OmpModel[]>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: OmpThinkingLevel): Promise<void>;
  /**
   * Reset the session in place: mints a fresh session file in the process's
   * session directory and clears conversational state. Used by the warm pool
   * to hand a booted process to a new agent create.
   */
  newSession(): Promise<void>;
  getSessionStats(): Promise<OmpSessionStats>;
  getCommands(): Promise<OmpRpcSlashCommand[]>;
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpRpcHostToolResult): void;
  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void;
  branch(entryId: string): Promise<{ text: string }>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  activeBranchEntryId?: string;
  steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): void;
  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession>;
}

export function buildOmpLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: OmpStartSessionInput;
}): OmpRuntimeLaunch {
  const command =
    input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]
      ? input.runtimeSettings.command.argv
      : input.command;
  const argv = [...command];

  const protocolMode = input.session.protocolMode ?? "rpc";
  const systemPrompt = input.session.systemPrompt?.trim();
  appendOmpLaunchArgs(argv, input.session, protocolMode, systemPrompt);

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    protocolMode,
    modeId: input.session.modeId,
    session: input.session.session,
    noSession: input.session.noSession,
    systemPrompt,
    extraArgs: input.session.extraArgs,
  };
}

function appendOmpLaunchArgs(
  argv: string[],
  session: OmpStartSessionInput,
  protocolMode: "rpc" | "rpc-ui",
  systemPrompt: string | undefined,
): void {
  if (!hasModeFlag(argv)) {
    argv.push("--mode", protocolMode);
  }
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingOptionId) {
    argv.push("--thinking", session.thinkingOptionId);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
  if (systemPrompt) {
    // `--system-prompt` replaces omp's coding harness entirely (renders
    // custom-system-prompt.md); `--append-system-prompt` layers under it.
    if (session.systemPromptMode === "replace") {
      argv.push("--system-prompt", systemPrompt);
    } else {
      argv.push("--append-system-prompt", systemPrompt);
    }
  }
  if (session.toolAllowlist?.length) {
    // omp's `--tools` is the selective allowlist, but it only accepts builtin
    // tool names (validation at parse time throws on anything else). Paseo
    // host tools are injected over RPC and filtered server-side; when the
    // allowlist holds no builtin names, `--no-tools` drops every builtin so
    // only the allowlisted host tools remain.
    const builtinTools = session.toolAllowlist.filter((name) => OMP_BUILTIN_TOOL_NAMES.has(name));
    if (builtinTools.length > 0) {
      argv.push("--tools", builtinTools.join(","));
    } else {
      argv.push("--no-tools");
    }
    // Harness-utility tools leak past `--no-tools`/`--tools` because they are
    // not builtins: learn/manage_skill register when autolearn.enabled,
    // checkpoint/rewind when checkpoint.enabled, and the SDK injects the tts
    // custom tool whenever speechgen.enabled (no whitelist check at all — see
    // omp sdk.ts). Pin those gates off with a --config overlay so an
    // allowlist session exposes exactly its allowlisted tools (live incident:
    // the Commander session exposed manage_skill/learn/rewind/tts and called
    // tts twice despite --no-tools).
    argv.push("--config", TOOL_ALLOWLIST_CONFIG_OVERLAY);
  }
}

/**
 * omp's builtin tool names (`--tools` accepts only these; mirrors
 * `@oh-my-pi/pi-coding-agent/src/tools/builtin-names.ts`). Keep in sync when
 * omp adds or removes a builtin.
 */
const OMP_BUILTIN_TOOL_NAMES = new Set([
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "inspect_image",
  "browser",
  "computer",
  "checkpoint",
  "rewind",
  "security_scan",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
  "yield",
  "goal",
]);

function hasModeFlag(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      return true;
    }
    if (argv[i]?.startsWith("--mode=")) {
      return true;
    }
  }
  return false;
}
