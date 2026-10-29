import { createIdleRuntimeCleanup } from "./agent/idle-runtime-cleanup/index.js";
import {
  awaitResumedChildRun,
  createFinishSubscriptions,
  createFinishObservation,
  createJsonFinishSubscriptionStore,
} from "./agent/finish-subscriptions/index.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type { PluginRegistries } from "@getpaseo/protocol/plugin-registry";
import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express, { type RequestHandler } from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, mkdirSync, unlinkSync } from "fs";
import { mkdir, open, rm, stat } from "fs/promises";
import { buildProjectReadme, ensureGitRepository } from "./project-directory-service.js";
import { RoutingService } from "./routing/routing-service.js";
import { AgentSearchService } from "./agent-search/agent-search-service.js";
import {
  unarchiveAgentOnThisHost,
  type UnarchiveAgent,
} from "./agent/tools/fleet-unarchive-tools.js";
import { readLaunchBrief } from "./mission-control/run-records.js";
import { randomUUID } from "node:crypto";
import { getHostName } from "./host-name.js";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

import { networkInterfaces } from "node:os";
import { createItsaplanWebhookUrl } from "./itsaplan/webhook-url.js";
export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

export function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { WarmWorktreePoolManager } from "./warm-worktree-pool.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createWorkspaceRecoveryService } from "./session/workspace-recovery/workspace-recovery-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { streamDirectoryAsZip } from "./file-download/zip-directory.js";
import { formatAttachmentContentDisposition } from "./file-download/content-disposition.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { FishSpeechProviderConfig } from "./speech/providers/fish/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { createSpeechSettingsOwner } from "./speech/speech-settings.js";
import { AgentManager } from "./agent/agent-manager.js";
import { createTranscriptSearchService } from "./search/service.js";
import type { ExtractedChunk } from "./search/extract.js";
import { MemoryService } from "./memory/service.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createFleetMcpServer, createFleetMcpWaitForAgent } from "./mcp-fleet/fleet-mcp-server.js";
import { authenticateRemoteMcpClient } from "./mcp-fleet/auth.js";
import { createMcpJsonBodyParser } from "./mcp-fleet/json-body.js";
import { ChunkedUploadSessions, FileUploadStore } from "./file-upload/index.js";
import {
  createMcpFinishLocalAgents,
  createMcpFinishNotifier,
  type McpNotifyTarget,
} from "./mcp-fleet/finish-notifier.js";
import { createAgentReminderService } from "./reminders/agent-reminder-service.js";
import { createReminderAgentDescriber } from "./reminders/reminder-agent-info.js";
import { resolveVaultSecret, warmVaultSecrets } from "./secrets/vault-secret.js";
import {
  createPaseoToolCatalog,
  createPaseoAgentToolManifest,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import type { PaseoToolCatalog, PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  type ProjectRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { ScheduleService } from "./schedule/service.js";
import { BaseCheckoutSyncService } from "./base-checkout-sync.js";
import { IdleCloseOmpService } from "./idle-close/index.js";
import { KeepAwakeService } from "./keep-awake/index.js";
import {
  AGENT_VIEWED_PEER_TOOL,
  MissionControlService,
  USER_TURN_PEER_TOOL,
} from "./mission-control/service.js";
import { getItsaplanIssueIdFromLabels } from "./itsaplan/index.js";
import { areEquivalentPaths } from "../utils/path.js";
import { getWorktreeConfiguredBaseRef } from "../utils/worktree.js";
import { buildFleetContextData, resolveRememberedBaseBranch } from "./mission-control/context.js";
import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import { CentralMissionControlConfigStore } from "./mission-control/config.js";
import { AgentNamingService } from "./mission-control/naming.js";
import { runIdentityBackfill } from "./mission-control/backfill.js";
import { MAX_WEBHOOK_BODY_BYTES, WebhookService } from "./webhook/service.js";
import { createWebhookRouteHandler } from "./webhook/route.js";
import { AutomationService } from "./automation/service.js";
import { openDocThreads, type DocThreadsHost } from "./doc-threads/index.js";
import {
  archiveOrphanedItsaplanBoards,
  attachItsaplanProjectSync,
  createItsaplanResyncRouteHandler,
  createItsaplanWebhookRouteHandler,
  ItsaplanBridge,
  ItsaplanProjectStore,
  ItsaplanReconcileService,
  resolveItsaplanConfig,
  runItsaplanProjectResync,
  type ItsaplanCentralConfig,
} from "./itsaplan/index.js";
import { PeerManager } from "./peers/peer-manager.js";
import { TunnelManager } from "./tunnel/manager.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import {
  resolveReloadableConfig,
  type ResolvedDaemonSettings,
  type CliConfigOverrides,
} from "./config.js";
import { resolvePaseoToolPolicy } from "./agent/paseo-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { PagePreviewBrowser } from "./page-tools/preview-browser.js";
import { PagePortProxy } from "./page-tools/port-proxy.js";
import { PageStore } from "./page-tools/page-store.js";
import { WorkspaceGitServiceImpl, type WorkspaceGitService } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { startWorkerTerminalManager } from "../terminal/worker-terminal-manager.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProfile,
  AgentSkillSelection,
  FirstAgentContext,
  PluginSource,
  TerminalProfile,
} from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import {
  loadPersistedConfig,
  type PersistedConfig,
  type RemoteMcpClient,
} from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  extractHttpBearerToken,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { deleteLocalCredential, writeLocalCredential } from "./local-credential.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import {
  applyMetaPlan,
  applyRoutedMetaPlan,
  type MetaActionsDependencies,
} from "./mission-control/meta-actions.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
import { PluginService } from "./plugins/index.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function applyHostAllowlist(
  app: express.Express,
  listenTarget: ListenTarget,
  getHostnames: () => HostnamesConfig | undefined,
  logger: Logger,
): void {
  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  // The allowlist is read per request so `daemon.hostnames` reloads apply live.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, getHostnames())) {
        logger.warn(
          { host: hostHeader ?? null, path: req.path, remoteAddress: req.socket.remoteAddress },
          "Rejected HTTP request from disallowed host; add it to daemon.hostnames",
        );
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }
}

function createCorsMiddleware(allowedOrigins: ReadonlySet<string>): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function resolveServiceProxyListenTarget(
  serviceProxy: PaseoDaemonConfig["serviceProxy"],
): ListenTarget | null {
  if (!serviceProxy?.standaloneListen) {
    return null;
  }
  return parseListenString(serviceProxy.standaloneListen);
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;
export type PaseoFishSpeechConfig = FishSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  // Where local models live, whether or not a feature currently uses the local provider.
  localModelsDir: string;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  // Ensure this host's scratch project (~/experiments) at boot. Default on;
  // test daemons turn it off so they never touch the real home directory.
  ensureScratchProjectOnBoot?: boolean;
  // Close idle OMP processes after this many seconds; 0 turns the sweep off.
  ompIdleCloseAfterSeconds?: number;
  // macOS: keep the host awake while agents run. Default "idle".
  keepAwakeWhileAgentsRun?: "off" | "idle" | "lid-closed";
  // Minutes to keep holding after the last agent stops. Default 5.
  keepAwakeReleaseGraceMinutes?: number;
  // "lid-closed" on battery: release SleepDisabled at or below this charge. Default 10.
  keepAwakeBatteryFloorPercent?: number;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  agentProfiles?: AgentProfile[];
  visibleModels?: string[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  pluginRegistries?: PluginRegistries;
  pluginRegistryUrl?: string;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayRequireProtectedSecurity?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  tunnel?: {
    provider: "tailscale-funnel" | "cloudflared" | "none";
    localPort: number;
    localTarget: string;
    autoStart: boolean;
    publicBaseUrl: string | null;
    tailscaleBin: string | null;
    cloudflared: {
      hostname: string | null;
      bin: string | null;
      configFile: string | null;
      token: string | null;
      tunnel: string | null;
    };
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  fish?: PaseoFishSpeechConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  idleRuntimeCleanup?: boolean;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  missionControl?: PersistedConfig["missionControl"];
  aiReviewer?: PersistedConfig["aiReviewer"];
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    relayEnabledFallback: boolean;
    startupPersisted: PersistedConfig;
  };
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  missionControlService?: MissionControlService;
  docThreadsHost: DocThreadsHost | null;
  start(): Promise<void>;
  /** Stops the daemon. Terminals keep running for the next daemon only with keepTerminals. */
  stop(options?: { keepTerminals?: boolean }): Promise<void>;
  getListenTarget(): ListenTarget | null;
  getServerId(): string;
}

export interface PaseoDaemonDependencies {
  builtinPlugins?: BuiltinPluginLoader;
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
    relayConfig?: boolean;
  };
}

function resolveBuiltinPluginLoader(dependencies: PaseoDaemonDependencies): BuiltinPluginLoader {
  return dependencies.builtinPlugins ?? new BuiltinPluginLoader();
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(app: express.Application, config: PaseoDaemonConfig, logger: Logger): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostName(),
      logger,
    }),
  );
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialRelayConfig(config: ResolvedDaemonSettings): MutableDaemonConfig["relay"] {
  return {
    enabled: config.relayEnabled ?? true,
    requireProtectedSecurity: config.relayRequireProtectedSecurity ?? false,
  };
}

function resolveReloadEnv(config: PaseoDaemonConfig): NodeJS.ProcessEnv {
  return config.configReload?.env ?? process.env;
}

// eslint-disable-next-line complexity -- large config field projection
function createInitialMutableDaemonConfig(config: ResolvedDaemonSettings): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: createInitialRelayConfig(config),
    mcp: {
      enabled: config.mcpEnabled ?? true,
      injectIntoAgents: config.mcpInjectIntoAgents ?? true,
    },
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? "https://app.paseo.sh" },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: {
      providers: config.metadataGeneration?.providers ?? [],
    },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    ompIdleCloseAfterSeconds: config.ompIdleCloseAfterSeconds ?? 1800,
    keepAwakeWhileAgentsRun: config.keepAwakeWhileAgentsRun ?? "idle",
    keepAwakeReleaseGraceMinutes: config.keepAwakeReleaseGraceMinutes ?? 5,
    keepAwakeBatteryFloorPercent: config.keepAwakeBatteryFloorPercent ?? 10,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    idleRuntimeCleanup: config.idleRuntimeCleanup !== false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    ...(config.missionControl ? { missionControl: config.missionControl } : {}),
    ...(config.aiReviewer ? { aiReviewer: config.aiReviewer } : {}),
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  if (config.visibleModels !== undefined) {
    initialConfig.visibleModels = config.visibleModels;
  }

  return initialConfig;
}

/**
 * Token-gated file download endpoint handler. Directory entries stream as a
 * zip; files stream directly. Token is single-use (consumeToken).
 */
async function handleFileDownload(input: {
  req: express.Request;
  res: express.Response;
  downloadTokenStore: DownloadTokenStore;
  logger: Logger;
}): Promise<void> {
  const { req, res, downloadTokenStore, logger } = input;
  const token =
    typeof req.query.token === "string" && req.query.token.trim().length > 0
      ? req.query.token.trim()
      : null;

  if (!token) {
    res.status(400).json({ error: "Missing download token" });
    return;
  }

  const entry = downloadTokenStore.consumeToken(token);
  if (!entry) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }

  const contentDisposition = formatAttachmentContentDisposition(entry.fileName);

  // Directory downloads are streamed as a zip of the sandboxed folder.
  if (entry.kind === "directory") {
    try {
      res.setHeader("Content-Type", entry.mimeType || "application/zip");
      res.setHeader("Content-Disposition", contentDisposition);
      // No Content-Length: zip size is unknown until the archive is finished.
      await streamDirectoryAsZip(entry.absolutePath, res);
    } catch (err) {
      logger.error({ err }, "Failed to stream directory zip download");
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to zip directory" });
      } else {
        res.end();
      }
    }
    return;
  }

  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
    const fileStats = await fileHandle.stat();
    if (res.destroyed) {
      return;
    }
    if (!fileStats.isFile()) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    res.setHeader("Content-Type", entry.mimeType);
    res.setHeader("Content-Disposition", contentDisposition);
    res.setHeader("Content-Length", fileStats.size.toString());

    const stream = fileHandle.createReadStream();
    fileHandle = null;
    res.once("close", () => stream.destroy());
    stream.on("error", (err) => {
      logger.error({ err }, "Failed to stream download");
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (err) {
    logger.error({ err }, "Failed to download file");
    if (!res.headersSent) {
      res.status(404).json({ error: "File not found" });
    }
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

/**
 * Public webhook ingress route on /hooks/:id/:secret. The handler is
 * assigned lazily once the webhook service is constructed; requests before
 * that get a 503 so callers retry rather than hang.
 */
function createWebhookIngress(app: express.Express): {
  setHandler: (handler: ReturnType<typeof createWebhookRouteHandler>) => void;
} {
  let handler: ReturnType<typeof createWebhookRouteHandler> | null = null;
  app.post(
    "/hooks/:id/:secret",
    express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY_BYTES }),
    (req, res, next) => {
      if (!handler) {
        res.status(503).json({ ok: false, error: "webhook service not ready" });
        return;
      }
      void handler(req, res, next);
    },
  );
  return {
    setHandler: (next) => {
      handler = next;
    },
  };
}

/**
 * Public itsaplan webhook ingress on /api/itsaplan/webhook (ADR 0002). Auth
 * is the HMAC signature itself (verified inside ItsaplanBridge), so this is
 * pre-auth like /hooks/:id/:secret — mounted before the Host allowlist,
 * bearer auth, and express.json() so itsaplan reaches it and HMAC can read
 * the exact raw body. The handler is assigned once the bridge exists;
 * requests before that get a 503.
 */
function createItsaplanWebhookIngress(app: express.Express): {
  setHandler: (handler: RequestHandler) => void;
} {
  let handler: RequestHandler | null = null;
  app.post(
    "/api/itsaplan/webhook",
    express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY_BYTES }),
    (req, res, next) => {
      if (!handler) {
        res.status(503).json({ ok: false, error: "itsaplan bridge not ready" });
        return;
      }
      handler(req, res, next);
    },
  );
  return {
    setHandler: (next) => {
      handler = next;
    },
  };
}

function resolveServiceProxyPublicBaseUrl(config: PaseoDaemonConfig): string | null {
  return config.serviceProxy?.publicBaseUrl ? config.serviceProxy.publicBaseUrl : null;
}
export interface WorktreeDefaultBranchResolutionDeps {
  daemonConfigStore?: { get(): { composerPreferences?: ComposerPreferences | null } };
  projectRegistry?: Pick<ProjectRegistry, "list">;
  workspaceGitService: Pick<WorkspaceGitService, "resolveDefaultBranch">;
  readConfiguredBaseRef?: (repoRoot: string) => Promise<string | undefined> | string | undefined;
}

/**
 * The ref a new worktree is cut from, highest precedence first:
 * paseo.json `worktree.warmPool.baseRef` -> the user's remembered base branch
 * -> the repository default branch. An explicit `baseBranch` on the create
 * request never reaches here; the session short-circuits it.
 */
export async function resolveWorktreeDefaultBranch(
  repoRoot: string,
  deps: WorktreeDefaultBranchResolutionDeps,
): Promise<string> {
  const configuredBaseRef = (
    await (deps.readConfiguredBaseRef
      ? deps.readConfiguredBaseRef(repoRoot)
      : getWorktreeConfiguredBaseRef(repoRoot))
  )?.trim();
  if (configuredBaseRef) {
    return configuredBaseRef;
  }

  const composerPrefs = deps.daemonConfigStore?.get().composerPreferences;
  let project = null;
  try {
    const list = await deps.projectRegistry?.list();
    project = list?.find((p) => areEquivalentPaths(p.rootPath, repoRoot)) ?? null;
  } catch {
    // ignore
  }
  const remembered = resolveRememberedBaseBranch(composerPrefs, {
    projectId: project?.projectId,
    projectKey: project?.projectKey,
  });
  if (remembered) {
    return remembered;
  }

  return deps.workspaceGitService.resolveDefaultBranch(repoRoot);
}

// eslint-disable-next-line complexity -- daemon bootstrap orchestration
export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  const obsoleteTimelineDirectory = path.join(config.paseoHome, "agent-timelines");
  await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
    logger.warn(
      { err: error, path: obsoleteTimelineDirectory },
      "Failed to remove obsolete agent timeline data",
    );
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const initialMutableConfig = createInitialMutableDaemonConfig(config);
  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    fishConfig: config.fish,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");
  const daemonConfigStore = new DaemonConfigStore(config.paseoHome, initialMutableConfig, logger, {
    relayEnabledMutable: config.relayEnabledMutable ?? true,
    startupPersisted: config.configReload?.startupPersisted,
    speech: createSpeechSettingsOwner({
      paseoHome: config.paseoHome,
      env: resolveReloadEnv(config),
      speechService,
    }),
    reloadSource: {
      resolve: (persisted) => {
        const reloaded = resolveReloadableConfig(persisted, {
          env: resolveReloadEnv(config),
          cli: config.configReload?.cli,
          relayEnabledFallback: config.configReload?.relayEnabledFallback,
        });
        return {
          mutable: createInitialMutableDaemonConfig(reloaded),
          overrideControlledPaths: reloaded.overrideControlledPaths,
        };
      },
    },
  });
  const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
  void orchestrationSkills.autoUpdate().catch((error) => {
    logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
  });
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});
  const pagePreviewBrowser = new PagePreviewBrowser(logger.child({ module: "page-preview" }));
  const pageStore = new PageStore(config.paseoHome);
  const pagePortProxy = new PagePortProxy({
    logger: logger.child({ module: "page-proxy" }),
    getBindHost: () => (listenTarget.type === "tcp" ? listenTarget.host : "127.0.0.1"),
  });
  const pluginRuntime: PluginService = new PluginService(logger, daemonConfigStore, daemonVersion, {
    usageAgents: {
      hasAgent: (id) => agentManager.getAgent(id) !== null,
      usageSession: (id) => agentManager.usageSession(id),
    },
    managedSources: new ManagedPluginSources(config.paseoHome, {
      registries: config.pluginRegistries,
      defaultUrl: config.pluginRegistryUrl,
    }),
    builtinPlugins: resolveBuiltinPluginLoader(dependencies),
    settingsDirectory: path.join(config.paseoHome, "plugin-settings"),
  });

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayRuntime: RelayRuntime | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  daemonConfigStore.onFieldChange("trustedProxies", (value) => {
    app.set("trust proxy", value ?? ["loopback"]);
  });
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  const terminalManager = await startWorkerTerminalManager({
    paseoHome: config.paseoHome,
    paseoVersion: daemonVersion,
    logger,
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = resolveServiceProxyPublicBaseUrl(config);
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const workspaceSetupRuntime = new WorkspaceSetupRuntime();
  let configuredHostnames = config.hostnames ?? config.allowedHosts;
  let appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";
  daemonConfigStore.onFieldChange("hostnames", (value) => {
    configuredHostnames = value as HostnamesConfig | undefined;
  });
  daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
    appBaseUrl = typeof value === "string" ? value : "https://app.paseo.sh";
  });
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let automationService: AutomationService | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Public webhook ingress. Mounted before the Host allowlist, CORS, bearer
  // auth, and express.json() so external senders (GitHub, Linear) reach it and
  // HMAC can read the raw body. Only this path is exempt from the Host
  // allowlist; every other daemon path still rejects the public tunnel host.
  // The handler is assigned once the webhook service is constructed below.
  const webhookIngress = createWebhookIngress(app);

  // Same pre-auth placement, for the itsaplan bridge's ingress (ADR 0002).
  const itsaplanWebhookIngress = createItsaplanWebhookIngress(app);

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  applyHostAllowlist(app, listenTarget, () => configuredHostnames, logger);

  // CORS - allow same-origin + configured origins
  const fixedAllowedOrigins = [
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ];
  const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
  daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
    allowedOrigins.clear();
    for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
      allowedOrigins.add(origin);
    }
  });

  app.use(createCorsMiddleware(allowedOrigins));

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Serve the bundled browser web UI when enabled. Mounted after service-proxy
  // classification and host/CORS handling, but before daemon bearer auth, so
  // static app files load without the daemon password while API/WebSocket calls
  // remain protected.
  mountWebUi(app, config, logger);

  let localCredential: string | null = null;
  const daemonAuth = { ...config.auth, localCredential: () => localCredential };
  app.use(
    createRequireBearerMiddleware(daemonAuth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  // MCP tool calls carry base64 images; they get a larger body cap and
  // JSON-RPC parser errors. The global parser below skips an already-parsed body.
  app.use(["/mcp/agents", "/mcp/fleet"], createMcpJsonBodyParser());
  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostName(),
      // Additive (v0.1.X); missionControlHostAlias is hoisted before the
      // verifier dispatcher (~1741) and initialized before the server starts
      // listening (see httpServer.listen below), so this request-time closure
      // read is safe.
      missionControlHostAlias: missionControlHostAlias || undefined,
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload({
      req,
      res,
      downloadTokenStore,
      logger,
    });
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  serviceProxyListenTarget = resolveServiceProxyListenTarget(config.serviceProxy);

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  const itsaplanProjectStore = new ItsaplanProjectStore({ paseoHome: config.paseoHome, logger });
  await itsaplanProjectStore.initialize();
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const workspaceLabelService = createWorkspaceLabelService({
    paseoHome: config.paseoHome,
    workspaceRegistry,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  workspaceGitService.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "remove" && mutation.workspace) {
      const cwd = path.resolve(mutation.workspace.cwd);
      const workspaces = await workspaceRegistry.list();
      const hasActiveWorkspace = workspaces.some(
        (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === cwd,
      );
      if (!hasActiveWorkspace) workspaceRuntimeStore.remove(cwd);
    }
    if (mutation.kind === "archive" && mutation.workspace) {
      pluginRuntime.emit("workspace.archive.after", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async (target) => (await stat(target).catch(() => null))?.isDirectory() ?? false,
    logger,
    paseoHome: config.paseoHome,
    getScratchProject: async () => (await routingService.ensureScratchWorkspace()).project,
  });
  const warmWorktreePool = new WarmWorktreePoolManager({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    workspaceGitService,
    projectRegistry,
    logger,
  });
  const agentProviderRuntime = await createAgentProviderRuntime({
    paseoHome: config.paseoHome,
    logger,
    daemonVersion,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      isDev: config.isDev === true,
      extraClients: config.agentClients,
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  daemonConfigStore.onFieldChange("catalogRefreshTimeoutMs", (value) => {
    providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
  });
  daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  daemonConfigStore.onFieldChange("git.maxProcessConcurrency", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  // Central mission-control config (fleet policy, stored on the commander
  // host). ONE shared instance for the whole daemon: naming reads the theme
  // from it, MissionControlService writes patches through it, and
  // resetCommander/commander-boot read it — so any patch is immediately
  // visible to every consumer. No per-consumer copies, no second read path.
  const centralMissionControlConfig = new CentralMissionControlConfigStore({
    paseoHome: config.paseoHome,
    logger,
  });
  await centralMissionControlConfig.initialize();
  // The one read path for the itsaplan connection: fleet policy from central
  // config with this machine's own web origin layered on (resolveItsaplanConfig
  // explains why the per-host value cannot live centrally). Resolved here so
  // the bridge, the reconcile sweep, the chat runner, and project sync all see
  // the same connection.
  const getItsaplanConfig = (): ItsaplanCentralConfig | null =>
    resolveItsaplanConfig(
      centralMissionControlConfig.get().itsaplan,
      daemonConfigStore.get().missionControl?.itsaplanWebBaseUrl,
    );
  // Mission Control naming: assigns a fleet-wide name to every created agent
  // (except paseo.mission-control=* labeled agents). Constructed before
  // AgentManager so its onAgentCreated hook can reference it; the manager is
  // accessed lazily via the accessor.
  const agentNamingService: AgentNamingService = new AgentNamingService({
    agentStorage,
    getAgentManager: () => agentManager,
    readTheme: () => centralMissionControlConfig.get().namingTheme,
    logger,
  });
  const aiReviewerCwd = path.join(config.paseoHome, "ai-reviewer");
  mkdirSync(aiReviewerCwd, { recursive: true });
  const agentManager: AgentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    pluginAgentTools: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    missionControlSelfReportEnabled:
      daemonConfigStore.get().missionControl?.selfReport?.enabled ?? true,
    resolveDefaultModel: (input) => providerSnapshotManager.resolveDefaultModel(input),
    onAgentCreated: (params) => agentNamingService.assignNameForCreatedAgent(params),
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    mcpAuthToken: agentMcpAuthToken,
    resolvePaseoToolPolicy: (provider) =>
      resolvePaseoToolPolicy(provider, daemonConfigStore.get().providers),
    aiReviewerCapability: true,
    getAiReviewerConfig: () => daemonConfigStore.get().aiReviewer,
    aiReviewerCwd,
    aiReviewerReadOnlyModeId: "plan",
    logger,
  });
  const syncPluginProviders = () => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  };
  const unsubscribePluginProviders =
    pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);

  const unsubscribePluginSessionChanges = pluginRuntime.subscribeSessionOpenChanges(() => {
    agentManager.invalidatePluginSessions();
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  await closeStaleAgentRecords(agentStorage);
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  // fleet-memory: turns, run records and learnings are queued to the memory host in
  // the background (durable outbox, retried until it answers). config.json memory.url
  // is re-read every 30 s, so Flotilla can point a host at memory without a restart.
  let memoryUrlRead: { at: number; url: string | null } = { at: 0, url: null };
  const memoryService = new MemoryService({
    paseoHome: config.paseoHome,
    logger,
    getMemoryUrl: () => {
      if (Date.now() - memoryUrlRead.at > 30_000) {
        let url: string | null = null;
        try {
          url = loadPersistedConfig(config.paseoHome).memory?.url ?? null;
        } catch (error) {
          logger.warn({ err: error }, "memory.config_read_failed");
        }
        memoryUrlRead = { at: Date.now(), url };
      }
      return memoryUrlRead.url;
    },
    hostLabel: () => daemonConfigStore.get().missionControl?.hostAlias?.trim() || getHostName(),
  });
  await memoryService.start();
  const pushAgentTurns = async (agentId: string, chunks: readonly ExtractedChunk[]) => {
    const record = await agentStorage.get(agentId);
    if (
      !record ||
      record.internal ||
      Object.keys(record.labels).some(
        (key) => key.startsWith("paseo.mission-control") || key.startsWith("paseo.history-ask"),
      )
    ) {
      return;
    }
    const workspace = record.workspaceId ? await workspaceRegistry.get(record.workspaceId) : null;
    const project = workspace ? await projectRegistry.get(workspace.projectId) : null;
    memoryService.pushTurns(
      {
        agentId,
        agentTitle: record.title || record.name || agentId,
        agentName: record.name ?? null,
        project: project ? (project.customName ?? project.displayName) : null,
      },
      chunks,
    );
  };
  const transcriptSearch = await createTranscriptSearchService({
    paseoHome: config.paseoHome,
    agentStorage,
    logger,
    onIndexed: (agentId, chunks) => {
      void pushAgentTurns(agentId, chunks).catch((error) => {
        logger.warn({ err: error, agentId }, "memory.push_turns_failed");
      });
    },
  });
  transcriptSearch?.start();
  await bootstrapWorkspaceRegistries({
    serverId,
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  await workspaceLabelService.initialize();
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    workspaceProvisioning,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
    workspaceRuntimeStore,
  });
  let itsaplanBridge: ItsaplanBridge | null = null;
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
  ) => {
    const { newlyArchived, workspace: existingWorkspace } = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
    });
    if (!newlyArchived || !existingWorkspace) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
    if (itsaplanBridge) {
      void itsaplanBridge.handleWorkspaceArchived(workspaceId).catch((error) => {
        logger.error({ err: error, workspaceId }, "itsaplan.bridge.workspace_archive_failed");
      });
    }
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      context,
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const emitAgentRemovedExternal = async (agentId: string) => {
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitAgentRemovedForExternalMutation(agentId),
      ),
    );
  };
  const emitStoredAgentUpdateExternal = async (record: StoredAgentRecord) => {
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitAgentUpdateForExternalMutation(record),
      ),
    );
  };
  // The app's Restore workspace, run by daemon machinery (fleet_unarchive_*)
  // instead of one client session: the same recovery service, then every
  // session refreshes the restored workspace.
  const workspaceRecoveryExternal = createWorkspaceRecoveryService({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    getWorkspace: (workspaceId) => workspaceRegistry.get(workspaceId),
    getProject: (projectId) => projectRegistry.get(projectId),
    isDirectory: async (target) => (await stat(target).catch(() => null))?.isDirectory() ?? false,
    unarchiveWorkspace: async (workspace) => {
      await workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace);
    },
  });
  const restoreWorkspaceExternal = async (workspaceId: string) => {
    await workspaceRecoveryExternal.restore(workspaceId);
    const workspace = await workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Restored workspace record not found: ${workspaceId}`);
    }
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.refreshRecoveredWorkspaceForExternalMutation(workspace),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext, context);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createPaseoWorktreeForTools = async (
    input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
  ) => {
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        createPaseoWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredPaseoWorktree(workflowInput, {
            lifecycle: pluginRuntime,
            github,
            resolveDefaultBranch:
              workflowOptions?.resolveDefaultBranch ??
              ((repoRoot: string) =>
                resolveWorktreeDefaultBranch(repoRoot, {
                  daemonConfigStore,
                  projectRegistry,
                  workspaceGitService,
                })),
            workspaceGitService,
            workspaceProvisioning,
            warmWorktreePool,
            // Hint pooled agent providers to move an idle process to this cwd
            // ahead of the agent create. Resolved per call: provider clients
            // are replaced when provider config changes.
            prewarmAgentCwd: (cwd: string) => providerSnapshotManager.prewarmAgentCwd(cwd),
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        startWorkspaceSetup: (workspaceId, operation) =>
          workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createPaseoWorktree: createPaseoWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    getWorkspace: async (workspaceId) => {
      const record = await workspaceRegistry?.get(workspaceId);
      return record ? { cwd: record.cwd, archivedAt: record.archivedAt } : null;
    },
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const archiveWorkspaceByIdExternal = (workspaceId: string, requestId: string) =>
    archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        projectRegistry,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceIdToKill),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      { scope: { kind: "workspace", workspaceId }, requestId },
    );
  const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    agentManager,
    agentStorage,
    github,
    workspaceGitService,
    createPaseoWorktreeWorkflow: createPaseoWorktreeForTools,
    archiveAgentForClose: (agentId) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emit: emitExternalSessionMessage,
    emitAgentRemove: async () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    killTerminalsForWorkspace: (workspaceId) =>
      killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
    logger,
  });
  const hubRelationships = new HubRelationshipController({
    paseoHome: config.paseoHome,
    hostname: getHostName(),
    serverId,
    daemonPublicKey: daemonKeyPair.publicKeyB64,
    logger,
    remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
    clock: dependencies.hubRelationshipClock,
    retryPolicy: dependencies.hubRelationshipRetryPolicy,
    createDaemonId: dependencies.createHubDaemonId,
    attachSocket: async (socket, options) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      await wsServer.attachExternalSocket(
        socket,
        { transport: "hub", hubDaemonId: options.daemonId },
        {
          principalId: options.principalId,
          permissions: options.permissions,
          hubExecutionAgents: options.agents,
        },
        options.sessionProtocol === "legacy"
          ? {
              type: "hello",
              clientId: `hub:${options.daemonId}`,
              clientType: "hub",
              protocolVersion: 1,
            }
          : undefined,
      );
    },
    updateAttachedPermissions: (principalId, permissions) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      wsServer.updatePrincipalPermissions(principalId, permissions);
    },
    createExecutionAgents: (daemonId) =>
      new DaemonExecutions({
        daemonId,
        agentManager,
        agentStorage,
        createAgent,
        // agentStorage is required for phantom-run reconciliation on cancel
        // (fork: dead "running" records must go to error, not stay zombies).
        interruptAgent: (agentId) =>
          cancelAgentRunCommand({ agentManager, agentStorage, logger }, agentId),
        archiveWorkspace: archiveWorkspaceByIdExternal,
        cleanupFailedCreate: (input) =>
          hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
      }),
  });

  const createScheduleLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      resolveFirstAgentPromptTitle(input.firstAgentContext),
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createSchedulePaseoWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createPaseoWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  // Webhook variants deliberately DO NOT broadcast the workspace on creation. The
  // client seeds an empty "New Agent" composer tab whenever it observes a focused
  // workspace with zero agents; broadcasting before the agent exists trips that.
  // The webhook service broadcasts once, after the agent is attached.
  const createWebhookLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      resolveFirstAgentPromptTitle(input.firstAgentContext),
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    return workspace;
  };
  const createWebhookPaseoWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    return createPaseoWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
  };
  const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
    await archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        projectRegistry,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "schedule-run-finish",
      },
    );
  };
  const scheduleService = new ScheduleService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
    createPaseoWorktreeWorkspace: createSchedulePaseoWorktreeExternal,
    archiveWorkspace: archiveScheduleWorkspaceExternal,
  });
  await scheduleService.start();
  const baseCheckoutSyncService = new BaseCheckoutSyncService({
    logger,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    agentStorage,
    agentManager,
  });
  baseCheckoutSyncService.start();
  const idleCloseOmpService = new IdleCloseOmpService({
    agentManager,
    daemonConfigStore,
    logger,
  });
  idleCloseOmpService.start();
  const keepAwakeService = new KeepAwakeService({
    agentManager,
    daemonConfigStore,
    logger,
    paseoHome: config.paseoHome,
  });
  keepAwakeService.start();
  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.completeForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");

  // Hoisted: closures below capture the service and run only after boot.
  let missionControlService: MissionControlService;
  const missionControlHostAlias = daemonConfigStore.get().missionControl?.hostAlias?.trim() || null;

  // The meta-actions executor deps, shared by the commander-host hook
  // (metaFromProposal — local apply + peer routing) and the peer hook
  // (metaApplyRemote — applies a forwarded plan against THIS daemon's
  // registries). hostAlias + peerManager feed resolveMetaTargetHost so the
  // plan's serverId resolves through the same fleet map the fleet tools use.
  // Built lazily (a factory): the peer manager is constructed AFTER the
  // service in bootstrap, so the fleet map must resolve at apply time, not at
  // service construction.
  const metaActionsDeps = (): MetaActionsDependencies => ({
    serverId,
    hostName: getHostName(),
    hostAlias: missionControlHostAlias,
    logger,
    agentManager,
    agentStorage,
    workspaceRegistry,
    projectRegistry,
    archiveWorkspace: archiveWorkspaceByIdExternal,
    archiveAgent: (agentId: string) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    mkdirp: async (dirPath: string) => {
      await mkdir(dirPath, { recursive: true });
    },
    ensureGitRepository: (dirPath: string, title: string) =>
      ensureGitRepository(dirPath, buildProjectReadme(title)),
    resolveScratchRoot: () =>
      centralMissionControlConfig.get().routing.scratchRootByHost?.[serverId] ?? null,
    emitStoredAgentUpdate: emitStoredAgentUpdateExternal,
    peerManager: peerManager ?? null,
  });

  // Hoisted peer-manager slot: constructed later in bootstrap (after the
  // MissionControlService), but the service's central-config routing needs a
  // lazy reference to it (forward patches to the commander host, push
  // replicas to peers, sync-on-connect). The closure reads the slot at call
  // time, so the eventual assignment below is always visible.
  let peerManager: PeerManager | null = null;
  missionControlService = new MissionControlService({
    paseoHome: config.paseoHome,
    onRunRecordFinalized: (record) => memoryService.pushRunRecord(record),
    logger,
    agentManager,
    agentStorage,
    daemonConfigStore,
    serverId,
    hostName: getHostName(),
    // The peer manager is constructed after the service: resolve it lazily.
    peerManager: () => peerManager,
    broadcast: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
    centralConfig: centralMissionControlConfig,
    workspaceRegistry,
    projectRegistry,
    onWorkspaceUpdated: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    archiveWorkspace: archiveWorkspaceByIdExternal,
    // Meta tools apply directly, routed to the plan's host.
    metaApplyDirect: (metaPlan) => applyRoutedMetaPlan(metaActionsDeps(), metaPlan, "mcp-direct"),
    // Peer branch of the meta apply: another host forwards a plan whose
    // metaPlan.serverId names THIS host (mission_control.meta.apply).
    // Re-validate against this daemon's own registries and apply here.
    metaApplyRemote: (metaPlan) => applyMetaPlan(metaActionsDeps(), metaPlan),
    // M6 run records: resolve the workspace/project attribution frozen into a
    // run record at assembly time (live registries; falls back to the cwd →
    // workspace path when the agent carries no workspaceId).
    resolveRunPlacement: async ({ workspaceId, cwd }) => {
      let resolvedWorkspaceId = workspaceId ?? null;
      if (!resolvedWorkspaceId && cwd) {
        resolvedWorkspaceId = await findWorkspaceIdForCwdExternal(cwd);
      }
      if (!resolvedWorkspaceId) {
        return { workspaceId: null, workspaceTitle: null, projectId: null, projectName: null };
      }
      const workspace = await workspaceRegistry.get(resolvedWorkspaceId);
      if (!workspace) {
        return {
          workspaceId: resolvedWorkspaceId,
          workspaceTitle: null,
          projectId: null,
          projectName: null,
        };
      }
      const project = workspace.projectId
        ? await projectRegistry.get(workspace.projectId).catch(() => null)
        : null;
      return {
        workspaceId: resolvedWorkspaceId,
        workspaceTitle: resolveWorkspaceDisplayName(workspace),
        projectId: workspace.projectId ?? null,
        projectName: project ? resolveProjectDisplayName(project) : null,
      };
    },
    // F2: a reviewState change (verdict / mark-done / clear / reopen /
    // aged-out sweep / completed report) re-buckets the agent but produces
    // no lifecycle mutation. Live agents re-emit state inside the service
    // (agent_state → every session's agent_update subscription); a
    // CLOSED/STORED agent has no live state, so fan the stored-record
    // upsert out to every trusted session here — the same external-mutation
    // path meta-actions use, with the recomputed bucket attached at the
    // session's wire boundary (enrichStoredPayload).
    onReviewStateChanged: (agentId) => {
      void (async () => {
        const record = await agentStorage.get(agentId).catch(() => null);
        if (!record) {
          return;
        }
        await Promise.all(
          (wsServer?.listSessions() ?? []).map((session) =>
            session.emitAgentUpdateForExternalMutation(record),
          ),
        );
      })().catch((error) => {
        logger.warn({ err: error, agentId }, "mission_control.review_state_stored_push_failed");
      });
    },
  });
  await missionControlService.start();
  logger.info({ elapsed: elapsed() }, "Mission control service initialized");

  // ADR 0002 itsaplan bridge: fully inert while central config `itsaplan`
  // is absent (every entry point checks getConfig() first). Machinery
  // delivery reuses the exact primitive Mission Control's own machinery
  // turns use (service.ts dispatchMachineryTurn) rather than the per-agent
  // event pipeline — a new-ticket dispatch prompt has no agentId yet.
  itsaplanBridge = new ItsaplanBridge({
    logger,
    serverId,
    agentManager,
    agentStorage,
    missionControl: missionControlService,
    // Webhook ingress terminates on this host, but a ticket's agent commonly
    // runs on a peer, so the inbound projection needs fleet reach. Queried on
    // demand rather than from the fleet index snapshot: a ticket can be moved
    // seconds after dispatch, and that snapshot refreshes periodically.
    fleet: {
      findAgentByIssue: async (issueId) => {
        if (!peerManager) {
          return null;
        }
        for (const status of peerManager.getPeerStatuses()) {
          if (status.state !== "online") {
            continue;
          }
          const client = peerManager.getPeerClient(status.name);
          if (!client || typeof client.fetchAgents !== "function") {
            continue;
          }
          try {
            const payload = await client.fetchAgents({
              filter: { includeArchived: false },
              page: { limit: 200 },
            });
            for (const entry of payload?.entries ?? []) {
              if (getItsaplanIssueIdFromLabels(entry?.agent?.labels) === issueId) {
                return { agentId: entry.agent.id, host: status.name };
              }
            }
          } catch (error) {
            logger.warn(
              { err: error, peer: status.name, issueId },
              "itsaplan.bridge.peer_agent_lookup_failed",
            );
          }
        }
        return null;
      },
      setLifecycle: async ({ host, agentId, action }) => {
        const client = peerManager?.getPeerClient(host) ?? null;
        const peerServerId = peerManager?.getPeerServerId(host) ?? null;
        if (!client || !peerServerId) {
          return { ok: false, error: `peer ${host} is not reachable` };
        }
        try {
          const payload = await client.missionControlLifecycleSet({
            serverId: peerServerId,
            agentId,
            action,
          });
          return payload.ok ? { ok: true } : { ok: false, error: payload.error ?? "rejected" };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      getLifecycleBucket: async ({ host, agentId }) => {
        const client = peerManager?.getPeerClient(host) ?? null;
        if (!client || typeof client.fetchAgent !== "function") {
          return null;
        }
        try {
          const payload = await client.fetchAgent({ agentId });
          return payload?.agent?.bucket ?? null;
        } catch (error) {
          logger.warn(
            { err: error, peer: host, agentId },
            "itsaplan.bridge.peer_agent_bucket_lookup_failed",
          );
          return null;
        }
      },
      steerWorkerPrompt: async ({ host, agentId, prompt }) => {
        const client = peerManager?.getPeerClient(host) ?? null;
        if (!client || typeof client.sendAgentMessage !== "function") {
          return { ok: false, error: `peer ${host} is not reachable` };
        }
        try {
          await client.sendAgentMessage(agentId, prompt, { dispatchMode: "steer" });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    projectStore: itsaplanProjectStore,
    getConfig: getItsaplanConfig,
    // A ticket moved to Done/Canceled archives its agents and, unless another
    // live agent shares it, their workspace (same commands as the app's archive).
    workspaceRegistry,
    projectRegistry,
    archiveWorkspace: archiveWorkspaceByIdExternal,
    archiveAgent: (agentId: string) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    getWebhookUrl: () => createItsaplanWebhookUrl(boundListenTarget, networkInterfaces()),
    resolvePaseoProjectKey: async (agentId) => {
      const live = agentManager.getAgent(agentId);
      const workspaceId = live?.workspaceId;
      const cwd = live?.cwd;
      const workspaces = await workspaceRegistry.list();
      let match = workspaceId ? workspaces.find((w) => w.workspaceId === workspaceId) : undefined;
      if (!match && cwd) {
        match = workspaces.find((w) => w.cwd === cwd);
      }
      if (!match) {
        const stored = await agentStorage.get(agentId);
        if (stored?.workspaceId) {
          match = workspaces.find((w) => w.workspaceId === stored.workspaceId);
        } else if (stored?.cwd) {
          match = workspaces.find((w) => w.cwd === stored.cwd);
        }
      }
      if (!match) {
        return null;
      }
      const project = await projectRegistry.get(match.projectId);
      return project?.projectKey ?? null;
    },
    // Todo tickets start their worker directly: fleet_create_agent places it
    // from the brief (named host/project/model first, then the fleet rules).
    dispatchWorker: async ({ title, brief, images, labels }) => {
      const { catalog } = await getFleetMcpCatalog("itsaplan-bridge");
      const result = await catalog.executeTool("fleet_create_agent", {
        title,
        initialPrompt: brief,
        labels,
        ...(images && images.length > 0 ? { images } : {}),
      });
      const created = z.object({ agentId: z.string() }).safeParse(result.structuredContent);
      return created.success ? created.data.agentId : null;
    },
    steerWorkerPrompt: async (agentId, prompt) => {
      // Same path a user message takes for a blocked worker (session.ts
      // dispatchAgentMessageRun): a mid-run steer with the pending
      // permission prompts cleared so the answer can actually land.
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        activeTurnBehavior: "steer",
        replaceOrigin: "user",
        clearPendingPermissions: true,
        logger,
      });
    },
  });
  itsaplanBridge.start();
  itsaplanWebhookIngress.setHandler(createItsaplanWebhookRouteHandler(itsaplanBridge, logger));
  // Placement routing (routing.suggest.* + suggest_placement MCP tool) and
  // metadataModel text generation. Reads central config live (replicated to
  // every host), so every daemon can route.
  const routingService = new RoutingService({
    serverId,
    logger,
    getCentralConfig: () => centralMissionControlConfig.get(),
    loadFleet: () =>
      buildFleetContextData({
        agentManager,
        agentStorage,
        workspaceRegistry,
        projectRegistry,
        providerSnapshotManager,
        peerManager: () => peerManager,
        daemonConfigStore,
        centralConfig: centralMissionControlConfig.get(),
        serverId,
        hostName: getHostName(),
        logger,
        inventoryOnly: false,
      }),
    scratch: {
      registerProject: (directoryPath) =>
        workspaceProvisioning.findOrCreateProjectForDirectory(directoryPath),
      setDescriptionIfMissing: async (projectId, description) => {
        await projectRegistry.update(projectId, (record) =>
          record.description
            ? record
            : { ...record, description, updatedAt: new Date().toISOString() },
        );
      },
      ensureBaseWorkspace: async (projectId) => {
        const workspaceId = await workspaceReconciliation.ensureProjectBaseWorkspace(projectId);
        const workspace = workspaceId ? await workspaceRegistry.get(workspaceId) : null;
        return workspace && !workspace.archivedAt ? workspace : null;
      },
    },
  });
  agentManager.setMetadataCompletion((prompt) => routingService.completeMetadata(prompt));
  // Once per host: offer the whole history (indexed transcripts and run records) to
  // fleet-memory, so a host that was asleep, new, or only just pointed at memory
  // catches up by itself. Checked every 5 minutes; unchanged items the memory
  // already has are dropped by the outbox.
  const offerHistoryToMemory = () => {
    if (!memoryService.needsInitialBackfill()) return;
    try {
      const agents = transcriptSearch?.replayIndexed() ?? 0;
      const runs = missionControlService.getRunRecords();
      for (const record of runs) memoryService.pushRunRecord(record);
      memoryService.markInitialBackfill();
      logger.info({ agents, runs: runs.length }, "memory.initial_backfill_queued");
    } catch (error) {
      logger.warn({ err: error }, "memory.initial_backfill_failed");
    }
  };
  setTimeout(offerHistoryToMemory, 60_000).unref();
  setInterval(offerHistoryToMemory, 5 * 60_000).unref();
  // Every host gets its scratch ("experiments") project and base workspace
  // without waiting for the first scratch placement: History Ask agents and
  // one-off work land there.
  if (config.ensureScratchProjectOnBoot !== false) {
    void routingService.ensureScratchWorkspace().catch((error) => {
      logger.warn({ err: error }, "Failed to ensure the scratch project");
    });
  }
  // Sidebar search (agent.search.*): plain full-text search over this host's agents.
  const agentSearchService = new AgentSearchService({
    listAgents: () => agentStorage.list(),
    getRunRecords: () => missionControlService.getRunRecords(),
    readLiveBrief: async (agentId) =>
      agentManager.getAgent(agentId)
        ? readLaunchBrief(await agentManager.getTimelineRows(agentId))
        : null,
    searchTranscripts: (query) => transcriptSearch?.search(query) ?? [],
    getArchivedWorkspaces: async () =>
      new Map(
        (await workspaceRegistry.list()).flatMap((workspace) =>
          workspace.archivedAt ? [[workspace.workspaceId, workspace.archivedAt] as const] : [],
        ),
      ),
  });
  // The app's agent.unarchive RPC runs the same restore as fleet_unarchive_agent.
  const unarchiveAgent: UnarchiveAgent = (agentId) =>
    unarchiveAgentOnThisHost(
      {
        agentManager,
        agentStorage,
        workspaceRegistry,
        restoreWorkspace: restoreWorkspaceExternal,
        emitStoredAgentUpdate: emitStoredAgentUpdateExternal,
      },
      agentId,
    );
  // "Remind me": reminders live with their agent on this host and POST
  // paseo.agent.reminder through the finish notifier's delivery path.
  const agentReminders = createAgentReminderService({
    filePath: path.join(config.paseoHome, "agent-reminders.json"),
    logger,
    hostsAgent: async (agentId) => (await agentStorage.get(agentId)) !== null,
    resolveTarget: (name) => loadNamedNotifyTargets().get(name) ?? null,
    describeAgent: createReminderAgentDescriber({
      agentManager,
      agentStorage,
      logger,
      serverId,
      hostLabel: () => missionControlHostAlias ?? getHostName(),
      appBaseUrl: () => appBaseUrl,
      readBucket: (agentId) => missionControlService.getLifecycleBucket(agentId),
    }),
    deliver: (input) => mcpFinishNotifier.deliver(input),
    onChange: (agentId) => {
      if (agentManager.getAgent(agentId)) {
        agentManager.notifyAgentState(agentId);
        return;
      }
      void agentStorage
        .get(agentId)
        .then((record) => (record ? emitStoredAgentUpdateExternal(record) : undefined))
        .catch((error: unknown) => {
          logger.warn({ err: error, agentId }, "agent reminder push failed");
        });
    },
  });
  // Vault-backed secrets are read once per daemon run: load every aside://
  // reference the config names now (routing keys, MCP client webhooks) so the
  // first request does not pay for the vault. Values are never logged.
  void warmVaultSecrets([
    ...Object.values(centralMissionControlConfig.get().routingSecrets ?? {}),
    ...(loadPersistedConfig(config.paseoHome).daemon?.mcp?.remoteClients ?? []).flatMap((client) =>
      Object.values(client.notify?.headers ?? {}),
    ),
    ...(loadPersistedConfig(config.paseoHome).daemon?.mcp?.notifyTargets ?? []).flatMap((target) =>
      Object.values(target.headers ?? {}).concat(target.signingSecret ?? []),
    ),
  ]).then((counts) => logger.info(counts, "vault secrets loaded"));
  const itsaplanProjectSyncDeps = {
    store: itsaplanProjectStore,
    getConfig: getItsaplanConfig,
    // null (unix-socket-only daemons, or before the listener binds) defers
    // project mapping until a TCP target exists.
    getWebhookUrl: () => createItsaplanWebhookUrl(boundListenTarget, networkInterfaces()),
    paseoHome: config.paseoHome,
    serverId,
    logger,
  };
  const resyncItsaplanProjects = async () =>
    runItsaplanProjectResync(await projectRegistry.list(), itsaplanProjectSyncDeps);
  app.post(
    "/api/itsaplan/resync",
    createItsaplanResyncRouteHandler(resyncItsaplanProjects, logger),
  );
  const unsubscribeItsaplanProjectSync = attachItsaplanProjectSync(
    projectRegistry,
    itsaplanProjectSyncDeps,
  );
  const itsaplanReconcileService = new ItsaplanReconcileService({
    agentStorage,
    missionControl: missionControlService,
    projectStore: itsaplanProjectStore,
    getConfig: getItsaplanConfig,
    closeTicket: (issueId) =>
      itsaplanBridge?.handleTicketCompletedOrCanceled(issueId) ?? Promise.resolve(),
    reconcileOwnedBoards: () => itsaplanBridge?.reconcileOwnedBoards() ?? Promise.resolve(),
    archiveOrphanedBoards: async () =>
      archiveOrphanedItsaplanBoards(await projectRegistry.list(), itsaplanProjectSyncDeps),
    logger,
  });
  itsaplanReconcileService.start();

  // Spec 01 change 1: clean running→idle transitions notify Mission Control
  // directly — finishes no longer latch a "finished" attention, so this
  // setter is the ONLY clean-finish signal. The manager is constructed
  // before the service; the setter is safe to call any time after both exist
  // (the service dedupes per run and excludes untracked classes itself).
  agentManager.setAgentFinishedCallback(({ agentId }) => {
    missionControlService.handleAgentFinished({ agentId });
    transcriptSearch?.scheduleReindex(agentId);
  });

  // Identity backfill: names for agents missing one (free), descriptions for
  // closed agents and titles for untitled workspaces via the structured
  // generation chain, capped to avoid a first-boot stampede. Fire-and-forget:
  // boot must not block on LLM calls; new agents are named by the
  // onAgentCreated hook regardless.
  void runIdentityBackfill({
    agentManager,
    agentStorage,
    naming: agentNamingService,
    providerSnapshotManager,
    workspaceRegistry,
    workspaceGitService,
    readDaemonConfig: () => ({
      metadataGeneration: daemonConfigStore.get().metadataGeneration,
    }),
    logger,
  }).catch((error) => {
    logger.warn({ err: error }, "Identity backfill failed");
  });

  const tunnelManager = new TunnelManager({
    config: config.tunnel ?? {
      provider: "none",
      localPort: 6767,
      localTarget: "127.0.0.1:6767",
      autoStart: false,
      publicBaseUrl: null,
      tailscaleBin: null,
      cloudflared: { hostname: null, bin: null, configFile: null, token: null, tunnel: null },
    },
    logger,
  });
  await tunnelManager.start();
  logger.info(
    {
      elapsed: elapsed(),
      provider: tunnelManager.getProvider(),
      status: tunnelManager.getStatus(),
    },
    "Tunnel manager initialized",
  );

  peerManager = new PeerManager({
    peers: loadPersistedConfig(config.paseoHome).peers ?? [],
    logger,
    appVersion: daemonVersion,
    lastSeenPath: path.join(config.paseoHome, "peer-last-seen.json"),
  });

  const webhookService = new WebhookService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createLocalCheckoutWorkspace: createWebhookLocalWorkspaceExternal,
    createPaseoWorktreeWorkspace: createWebhookPaseoWorktreeExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    getPublicBaseUrl: () => tunnelManager.getPublicBaseUrl(),
    getTunnelProvider: () => tunnelManager.getProvider(),
    getTunnelStatus: () => tunnelManager.getStatus(),
  });
  webhookIngress.setHandler(createWebhookRouteHandler(webhookService, logger));

  const docThreadsRuntime = await openDocThreads({
    paseoHome: config.paseoHome,
    logger,
    agentStorage,
    agentManager,
  });
  const docThreadsHost = docThreadsRuntime?.host ?? null;
  docThreadsRuntime?.host.service?.onChange((change) => {
    wsServer?.broadcast(wrapSessionMessage({ type: "doc_threads.changed", ...change }));
  });
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");
  // One store for every MCP catalog: catalogs are rebuilt on a TTL, and a
  // chunked upload must outlive that.
  const chunkedUploads = new ChunkedUploadSessions(
    new FileUploadStore({ paseoHome: config.paseoHome }),
  );

  const finishSubscriptions = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(config.paseoHome),
    serverId,
    logger,
    messages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    callerIsActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    awaitResumedRun: (childAgentId, signal) =>
      awaitResumedChildRun({ agentManager, agentStorage, childAgentId, signal }),
    ...createFinishObservation({
      agentManager,
      agentStorage,
      serverId,
      logger,
      messages: () => {
        if (!wsServer) throw new Error("Daemon is not accepting agent messages");
        return wsServer.agentMessages;
      },
      hosts: () => {
        if (!wsServer) throw new Error("Daemon is not accepting host operations");
        return wsServer.toolHosts();
      },
    }),
  });

  const idleRuntimeCleanup = createIdleRuntimeCleanup({
    enabled: daemonConfigStore.get().idleRuntimeCleanup !== false,
    runtimes: () => agentManager.getRuntimeCleanupCandidates(),
    isProtected: (agentId) =>
      finishSubscriptions.hasPendingForCaller(agentId) ||
      (wsServer?.agentMessages.hasPending(agentId) ?? false),
    logger,
  });

  const unsubscribeIdleRuntimeCleanup = connectIdleRuntimeCleanupConfig(
    daemonConfigStore,
    idleRuntimeCleanup,
  );

  const createAgentToolHostDependencies = (
    runtime: PaseoToolRuntimeContext,
  ): PaseoToolHostDependencies => ({
    finishSubscriptions: () => finishSubscriptions,
    agentMessages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    serverId,
    hosts: () => {
      if (!wsServer) throw new Error("Daemon is not accepting host operations");
      return wsServer.toolHosts();
    },
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    emitAgentRemoved: emitAgentRemovedExternal,
    restoreWorkspace: restoreWorkspaceExternal,
    emitStoredAgentUpdate: emitStoredAgentUpdateExternal,
    agentReminders,
    workspaceRegistry,
    projectRegistry,
    createDirectoryWorkspace: async (cwd, title, projectId, context) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        context,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceRuntimeStore,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      publishStatusUpdate: (message) => wsServer?.publishScriptStatusUpdate(message),
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
      getGlobalServicePorts: () => daemonConfigStore.readServicePorts(),
    }),
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    pagePreviewBrowser,
    pageStore,
    peerManager,
    missionControlService,
    itsaplanTicketize: {
      ticketizeAgent: (agentId, ticketOptions) =>
        itsaplanBridge.ticketizeAgent(agentId, ticketOptions),
    },
    routingService,
    memoryService,
    resolveDocThreads: docThreadsHost?.service ? () => docThreadsHost.service! : null,
    hostAlias: missionControlHostAlias,
    paseoToolPolicy:
      runtime.paseoToolPolicy ??
      (runtime.callerAgentId ? agentManager.getPaseoToolPolicy(runtime.callerAgentId) : undefined),
    paseoHome: config.paseoHome,
    chunkedUploads,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    callerLabels: runtime.callerLabels,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
    createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setPaseoToolCatalog(
      enabled ? createPaseoAgentToolManifest(createAgentToolHostDependencies({})) : null,
    );
  };
  agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
  // Native host tools (fleet_*, report_status) are independent of MCP inject.
  // injectIntoAgents only controls the HTTP MCP server URL in the session
  // config. Gating native tools on inject left Commander sessions with
  // --no-tools and an empty catalog (live: ox wrote fleet_create_agent as
  // prose; workers had no report_status).
  agentManager.setPaseoToolsEnabled(true);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  let mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({
          callerAgentId,
          callerLabels: callerAgentId ? agentManager.getAgent(callerAgentId)?.labels : undefined,
          paseoToolPolicy: callerAgentId
            ? agentManager.getPaseoToolPolicy(callerAgentId)
            : undefined,
        }),
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Agent MCP endpoint disabled" });
        return;
      }
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
            body: describeMcpDebugPayload(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
  }

  // The /mcp/fleet catalog cache and finish notifier sit outside the route
  // block: start() restores journaled finish watches through them, and stop()
  // suspends the watches before agents close.
  //
  // The MCP endpoint is stateless (one HTTP request per tool call). Building
  // the full catalog each time dominated latency, so each client reuses its
  // catalog; it closes over live services, as the Voice and agent catalogs
  // do. Rebuilt after the TTL.
  const FLEET_MCP_CATALOG_TTL_MS = 5 * 60_000;
  const fleetMcpCatalogs = new Map<
    string,
    { at: number; hostDeps: PaseoToolHostDependencies; catalog: PaseoToolCatalog }
  >();
  const getFleetMcpCatalog = async (clientName: string) => {
    let cached = fleetMcpCatalogs.get(clientName);
    if (!cached || Date.now() - cached.at > FLEET_MCP_CATALOG_TTL_MS) {
      const hostDeps = createAgentToolHostDependencies({
        callerLabels: { "paseo.mcp-client": clientName },
        enableVoiceTools: false,
        voiceOnly: false,
      });
      cached = {
        at: Date.now(),
        hostDeps,
        catalog: await createPaseoToolCatalog(hostDeps),
      };
      fleetMcpCatalogs.set(clientName, cached);
    }
    return cached;
  };
  // Is someone looking at this agent's chat? Only the agent's own host sees
  // the client heartbeats for it, so ask this host and every online peer.
  const AgentViewedAnswerSchema = z.object({ viewed: z.boolean() });
  const isAgentViewedAnywhere = async (agentId: string): Promise<boolean> => {
    if (missionControlService.agentViews.isViewed(agentId)) return true;
    const answers = await Promise.all(
      (peerManager?.getPeerStatuses() ?? [])
        .filter((peer) => peer.state === "online")
        .map(async (peer) => {
          const client = peerManager?.getPeerClient(peer.name);
          const response = await client
            ?.missionControlToolsExecute({
              name: AGENT_VIEWED_PEER_TOOL,
              args: { agentId },
              timeoutMs: 5_000,
            })
            .catch(() => null);
          return AgentViewedAnswerSchema.safeParse(response?.structuredContent).data?.viewed;
        }),
    );
    return answers.includes(true);
  };
  const mcpFinishNotifier = createMcpFinishNotifier({
    resolveSecret: resolveVaultSecret,
    holdOwnTurn: async ({ agentId }) => {
      const mode = centralMissionControlConfig.get().ownTurnNotify;
      if (mode === "never") return "own_turns_off";
      if (mode === "not_viewing" && (await isAgentViewedAnywhere(agentId))) return "chat_open";
      return null;
    },
    logger,
    journalPath: path.join(config.paseoHome, "mcp-fleet", "finish-watches.jsonl"),
    deliveryLogPath: path.join(config.paseoHome, "mcp-fleet", "webhook-deliveries.jsonl"),
    localAgents: createMcpFinishLocalAgents({ agentManager, agentStorage }),
  });
  const loadNamedNotifyTargets = (): Map<string, McpNotifyTarget> =>
    new Map(
      (loadPersistedConfig(config.paseoHome).daemon?.mcp?.notifyTargets ?? []).map(
        ({ name, ...target }) => [name, target],
      ),
    );
  // Turns Vaibhav starts from the app: the agent's ticket gets his words, and
  // every MCP client subscribed to the agent hears when the turn ends (origin
  // "user"). Subscriptions live on whichever host the client calls, so the
  // agent's host also tells its peers (USER_TURN_PEER_TOOL); a peer only arms.
  const unsubscribeUserPrompts = missionControlService.subscribeUserPrompts((prompt) => {
    const { agentId, turnId, text } = prompt;
    if (!prompt.forwarded) {
      void itsaplanBridge.mirrorUserPrompt(agentId, text).catch((error: unknown) => {
        logger.warn({ err: error, agentId }, "itsaplan.bridge.user_prompt_mirror_failed");
      });
      for (const peer of peerManager?.getPeerStatuses() ?? []) {
        const client = peer.state === "online" ? peerManager?.getPeerClient(peer.name) : null;
        void client
          ?.missionControlToolsExecute({
            name: USER_TURN_PEER_TOOL,
            args: { agentId, turnId, text },
          })
          .catch((error: unknown) => {
            logger.debug(
              { err: error, agentId, peer: peer.name },
              "mcp.finish.user_turn_forward_failed",
            );
          });
      }
    }
    void armUserTurnWatches(agentId, turnId, text).catch((error: unknown) => {
      logger.warn({ err: error, agentId }, "mcp.finish.user_turn_arm_failed");
    });
  });
  const armUserTurnWatches = async (
    agentId: string,
    turnId: string | null,
    userPrompt: string,
  ): Promise<void> => {
    const persisted = loadPersistedConfig(config.paseoHome).daemon?.mcp;
    for (const client of persisted?.remoteClients ?? []) {
      const subscription = mcpFinishNotifier.subscription(client.name, agentId);
      if (!subscription) continue;
      const target = subscription.notifyTarget
        ? loadNamedNotifyTargets().get(subscription.notifyTarget)
        : client.notify;
      if (!target) continue;
      const { catalog } = await getFleetMcpCatalog(client.name);
      void mcpFinishNotifier.arm({
        client: client.name,
        target,
        notifyTarget: subscription.notifyTarget,
        agentId,
        turnId,
        tool: "user_prompt",
        context: subscription.context,
        origin: "user",
        userPrompt,
        waitForAgent: createFleetMcpWaitForAgent(catalog),
      });
    }
  };
  const restoreMcpFinishWatches = async () => {
    const { restored } = await mcpFinishNotifier.restore(async (clientName, notifyTarget) => {
      const target = notifyTarget
        ? loadNamedNotifyTargets().get(notifyTarget)
        : loadPersistedConfig(config.paseoHome).daemon?.mcp?.remoteClients?.find(
            (client) => client.name === clientName,
          )?.notify;
      if (!target) return null;
      const { catalog } = await getFleetMcpCatalog(clientName);
      return { target, waitForAgent: createFleetMcpWaitForAgent(catalog) };
    });
    if (restored > 0) logger.info({ restored }, "mcp finish watches restored");
  };

  {
    const fleetMcpRoute = "/mcp/fleet";

    const createFleetMcpSession = async (client: RemoteMcpClient) => {
      const clientName = client.name;
      const cached = await getFleetMcpCatalog(clientName);
      const fleetMcpServer = await createFleetMcpServer({
        hostDependencies: cached.hostDeps,
        catalog: cached.catalog,
        clientName,
        finishNotifier: mcpFinishNotifier,
        notifyTarget: client.notify ?? null,
        namedNotifyTargets: loadNamedNotifyTargets(),
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Fleet MCP transport error");
        },
      });

      await fleetMcpServer.connect(transport);
      return { server: fleetMcpServer, transport };
    };

    const runFleetMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Fleet MCP endpoint disabled" });
        return;
      }
      const persisted = loadPersistedConfig(config.paseoHome);
      const remoteClients = persisted.daemon?.mcp?.remoteClients;
      if (!remoteClients || remoteClients.length === 0) {
        res.status(404).json({ error: "No remote MCP clients configured" });
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed",
          },
          id: null,
        });
        return;
      }
      const token = extractHttpBearerToken(req.header("authorization"));
      const authenticatedClient = await authenticateRemoteMcpClient(token, remoteClients);
      if (!authenticatedClient) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      logger.info({ client: authenticatedClient.name }, "Fleet MCP request authorized");
      try {
        const { server, transport } = await createFleetMcpSession(authenticatedClient);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Fleet MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleFleetMcpRequest: express.RequestHandler = (req, res) => {
      void runFleetMcpRequest(req, res);
    };

    app.post(fleetMcpRoute, handleFleetMcpRequest);
    app.get(fleetMcpRoute, handleFleetMcpRequest);
    app.delete(fleetMcpRoute, handleFleetMcpRequest);
    logger.info({ route: fleetMcpRoute, enabled: mcpEnabled }, "Fleet MCP route mounted");
  }

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      localCredential = await writeLocalCredential(config.paseoHome);
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Before the server accepts prompts, so a restored watch sees its agent's resumed run start.
      await restoreMcpFinishWatches().catch((error) => {
        logger.error({ err: error }, "Failed to restore mcp finish watches");
      });
      try {
        await agentReminders.start();
      } catch (error) {
        logger.error({ err: error }, "Failed to start agent reminders");
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            // Only resolvable once bound — the itsaplan webhook URL needs
            // the real TCP target. Fire-and-forget: itsaplan API round
            // trips must never block daemon startup.
            void resyncItsaplanProjects().catch((error: unknown) => {
              logger.error({ err: error }, "itsaplan.project.boot_backfill_failed");
            });
            const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
            agentMcpBaseUrl =
              !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            // Native tools stay on regardless of MCP inject (see above).
            daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
              mcpEnabled = value !== false;
              const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
              agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
              setAgentProviderToolsEnabled(mcpEnabled && inject);
            });
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            await warmWorktreePool.start();
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            // ---- Automations facade (unified schedules/webhooks/poll triggers).
            // Owns poll records + the poll loop; schedule/webhook kinds delegate.
            // Built here so the service instance is in hand for the wsServer call below.
            let automationRevision = 0;
            automationService = new AutomationService({
              paseoHome: config.paseoHome,
              logger,
              scheduleService,
              webhookService,
              onChanged: (change) => {
                automationRevision += 1;
                wsServer?.broadcast(
                  wrapSessionMessage({
                    type: "automations.changed",
                    automationId: change.automationId,
                    kind: change.kind,
                    revision: automationRevision,
                  }),
                );
              },
            });
            automationService.start();
            // ---- end automations

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                getAllowedOrigins: () => allowedOrigins,
                getHostnames: () => configuredHostnames,
                daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                startPaused: true,
              },
              workspaceAutoName,
              workspaceRuntimeStore,
              daemonAuth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                get appBaseUrl() {
                  return appBaseUrl;
                },
                desktopManaged: config.desktopManaged === true,
                getRelayConfig: () => ({
                  ...(relayRuntime?.getConfig() ?? {
                    enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                    endpoint: relayEndpoint,
                    publicEndpoint: relayPublicEndpoint,
                    useTls: relayUseTls,
                    publicUseTls: relayPublicUseTls,
                  }),
                  requireProtectedSecurity:
                    daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                }),
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              webhookService,
              hubRelationships,
              peerManager,
              missionControlService,
              workspaceSetupRuntime,
              pluginRuntime,
              orchestrationSkills,
              workspaceLabelService,
              (workspaceId) => itsaplanBridge?.handleWorkspaceArchived(workspaceId),
              warmWorktreePool,
              docThreadsHost,
              {
                automationService,
                pagePortProxy,
                pageStore,
                routingService,
                agentSearchService,
                unarchiveAgent,
                agentReminders,
              },
            );
            pluginRuntime.bindPaseoSessionHost(wsServer);
            await pluginRuntime.start();
            providerSnapshotManager.settlePluginProviders();
            await finishSubscriptions.start();
            wsServer.beginAcceptingConnections();
            const relaySecurityLogger = logger.child({ module: "relay-security" });
            relayRuntime = createRelayRuntime({
              config: {
                enabled: relayEnabled,
                endpoint: relayEndpoint,
                publicEndpoint: relayPublicEndpoint,
                useTls: relayUseTls,
                publicUseTls: relayPublicUseTls,
              },
              logger,
              attachSocket: (ws, metadata) =>
                admitSecuredRelaySocket(
                  ws,
                  {
                    daemonKeyPair: daemonKeyPair.keyPair,
                    logger: relaySecurityLogger,
                    requireProtectedMode: () =>
                      daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                  },
                  async (secured) => {
                    if (!wsServer) throw new Error("WebSocket server is not ready");
                    await wsServer.attachExternalSocket(secured.socket, {
                      ...metadata,
                      transport: "relay",
                      securityMode: secured.securityMode,
                    });
                  },
                ),
              serverId,
            });
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              relayRuntime?.setEnabled(value === true);
            });
            await hubRelationships.start();
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      transcriptSearch?.stop();
      memoryService.stop();
      localCredential = null;
      await deleteLocalCredential(config.paseoHome);
      unsubscribePluginProviders();
      unsubscribePluginSessionChanges();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async (options?: { keepTerminals?: boolean }) => {
    const keepTerminals = options?.keepTerminals === true;
    let terminalShutdownError: unknown = null;
    localCredential = null;
    await deleteLocalCredential(config.paseoHome);
    // Stop tracking plugin provider registrations before anything tears plugins
    // down, so plugin shutdown cannot withdraw a provider from under an agent
    // that is still open. Plugins themselves are stopped once every session
    // they serve has been closed, further down.
    unsubscribePluginProviders();
    unsubscribePluginSessionChanges();
    await hubRelationships.stop();
    workspaceReconciliation.dispose();
    itsaplanReconcileService.stop();
    itsaplanBridge.stop();
    unsubscribeItsaplanProjectSync();
    unsubscribeUserPrompts();
    scriptHealthMonitor.stop();
    idleCloseOmpService.stop();
    await keepAwakeService.stop();
    unsubscribeIdleRuntimeCleanup();
    await idleRuntimeCleanup.close();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    await finishSubscriptions.close();
    await wsServer?.agentMessages.close();
    agentManager.prepareForShutdown();
    agentReminders.stop();
    // Before agents close: the shutdown's "closed" state is not the end of a watched run.
    await mcpFinishNotifier.suspend();
    await closeAllAgents(logger, agentManager);
    await withTimeout({
      promise: pluginRuntime.drainEvents(),
      timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
      label: "drain plugin lifecycle events",
    }).catch((error) => logger.warn({ err: error }, "Plugin lifecycle events did not finish"));
    await agentManager.flushForShutdown().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await agentProviderRuntime.shutdown();
    await pluginRuntime.stopAllPlugins();
    try {
      if (keepTerminals) {
        await terminalManager.detach();
        logger.info("Terminals left running for the next daemon");
      } else {
        await terminalManager.closeTerminals();
      }
    } catch (error) {
      // Finish the rest of the shutdown, then report it: the supervisor and `daemon stop`
      // retry the cleanup from the record the reaper kept.
      terminalShutdownError = error;
      logger.error({ err: error }, "Terminal shutdown failed");
    }
    await speechService.stop();
    await missionControlService.stop().catch(() => undefined);

    await warmWorktreePool.stop().catch(() => undefined);
    await automationService?.stop().catch(() => undefined);
    await scheduleService.stop().catch(() => undefined);
    baseCheckoutSyncService.stop();
    await peerManager?.close().catch(() => undefined);
    await pagePreviewBrowser.close();
    await pagePortProxy.close();
    await tunnelManager.stop().catch(() => undefined);
    await relayRuntime?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    transcriptSearch?.stop();
    memoryService.stop();
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
    if (terminalShutdownError) {
      throw terminalShutdownError;
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    missionControlService,
    docThreadsHost,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
    getServerId: () => serverId,
  };
}

async function closeStaleAgentRecords(agentStorage: AgentStorage): Promise<void> {
  // No provider runtimes are loaded at startup. Repair interrupted
  // shutdowns before any status consumer sees the persisted active states.
  for (const record of await agentStorage.list()) {
    if (record.lastStatus === "running" || record.lastStatus === "initializing") {
      await agentStorage.upsert({ ...record, lastStatus: "closed" });
    }
  }
}

/**
 * Closing an agent asks its provider to close the session and waits for the
 * answer. A provider that never answers must not hold the daemon open, so a
 * close that outlives this deadline is abandoned; `agentProviderRuntime`
 * shutdown runs next and rejects the request that was still pending.
 */
const AGENT_CLOSE_TIMEOUT_MS = 5_000;

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents({ includeInternal: true });
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await withTimeout({
          promise: agentManager.closeAgent(agent.id),
          timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
          label: `close agent ${agent.id}`,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

export function connectIdleRuntimeCleanupConfig(
  store: DaemonConfigStore,
  cleanup: Pick<ReturnType<typeof createIdleRuntimeCleanup>, "setEnabled">,
): () => void {
  cleanup.setEnabled(store.get().idleRuntimeCleanup !== false);
  return store.onFieldChange("idleRuntimeCleanup", (value) => cleanup.setEnabled(value !== false));
}
