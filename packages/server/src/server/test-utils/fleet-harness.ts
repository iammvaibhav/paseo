/**
 * Layer 2 fleet integration harness (spec docs/specs/mc-robustness/08-testing.md).
 *
 * Three in-process daemons with REAL WebSocket peering:
 *   - A peers to B and C; B and C peer back to A (hostAlias = the name)
 *
 * Built on createPaseoDaemon (docs/ad-hoc-daemon-testing.md) with OS-assigned
 * ports; nothing at the peering layer is mocked.
 *
 * Every scenario drives the fleet tools the way a bot does: over each
 * daemon's /mcp/fleet endpoint as a remote MCP client (fleetExec).
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import pino from "pino";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import { DaemonClient } from "./daemon-client.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

export const FLEET_HOSTS = ["A", "B", "C"] as const;
export type FleetHostName = (typeof FLEET_HOSTS)[number];

/** The harness appVersion: high enough that non-legacy providers (omp) are visible. */
export const FLEET_TEST_APP_VERSION = "0.1.90";

/** The remote MCP client every harness daemon accepts on /mcp/fleet. */
const HARNESS_MCP_CLIENT = "fleet-harness";
const HARNESS_MCP_TOKEN = "fleet-harness-token";

/** Each harness client's daemon port, so fleetExec reaches the same daemon's /mcp/fleet. */
const mcpPortByClient = new WeakMap<DaemonClient, number>();

export interface FleetHarnessDaemon {
  name: FleetHostName;
  daemon: PaseoDaemon;
  port: number;
  paseoHome: string;
  paseoHomeRoot: string;
  staticDir: string;
  client: DaemonClient;
}

export interface FleetHarnessOptions {
  logger?: pino.Logger;
  /**
   * Agent clients for EVERY daemon. Default createTestAgentClients() — the
   * deterministic fakes. The real-model smoke test passes a real provider
   * configuration instead (no fakes for the omp provider).
   */
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: PaseoDaemonConfig["providerOverrides"];
  mcpEnabled?: boolean;
  /** Central config written to every host's central-config.json (each host owns its own). */
  centralConfig?: Record<string, unknown>;
  /** Which hosts each daemon peers to (default: A peers to B and C; B and C peer to A). */
  peers?: Partial<Record<FleetHostName, FleetHostName[]>>;
  appVersion?: string;
  /** Startup budget for daemon bring-up + peering (default 60s). */
  startupTimeoutMs?: number;
}

export interface FleetHarness {
  daemons: Record<FleetHostName, FleetHarnessDaemon>;
  clients: Record<FleetHostName, DaemonClient>;
  close: () => Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** Reserve an ephemeral OS port (close-on-bind; used as the daemon listen port). */
export async function allocatePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    const port = address.port;
    server.close(() => resolve(port));
  });
  return await promise;
}

async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(await allocatePort());
  }
  return ports;
}

function isAddressInUseError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EADDRINUSE" || code === "EACCES";
}

async function writeDaemonSeedFiles(input: {
  paseoHomeRoot: string;
  name: FleetHostName;
  peers: FleetHostName[];
  peerPorts: Map<FleetHostName, number>;
  centralConfig: Record<string, unknown>;
}): Promise<{ paseoHome: string; staticDir: string }> {
  const { paseoHomeRoot, name, peers, peerPorts, centralConfig } = input;
  const paseoHome = path.join(paseoHomeRoot, name, ".paseo");
  await mkdir(path.join(paseoHome, "mission-control"), { recursive: true });
  await mkdir(path.join(paseoHome, "projects"), { recursive: true });
  const staticDir = path.join(paseoHomeRoot, name, "static");
  await mkdir(staticDir, { recursive: true });
  // Stable per-host server id + the daemon version gate for provider visibility.
  await writeFile(path.join(paseoHome, "server-id"), `srv_fleet_${name}\n`, "utf8");
  const peerConfigs = peers.map((peerName) => {
    const peerPort = peerPorts.get(peerName);
    if (!peerPort) {
      throw new Error(`Missing port for peer ${peerName}`);
    }
    return { name: peerName, url: `tcp://127.0.0.1:${peerPort}` };
  });
  // peers + hostAlias live in the persisted daemon config (config.json) —
  // bootstrap reads them via loadPersistedConfig(config.paseoHome).
  await writeFile(
    path.join(paseoHome, "config.json"),
    JSON.stringify({
      peers: peerConfigs,
      missionControl: { hostAlias: name, enabled: true },
      daemon: {
        mcp: {
          enabled: true,
          remoteClients: [
            { name: HARNESS_MCP_CLIENT, tokenHash: hashDaemonPassword(HARNESS_MCP_TOKEN) },
          ],
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(paseoHome, "mission-control", "central-config.json"),
    JSON.stringify(centralConfig),
    "utf8",
  );
  return { paseoHome, staticDir };
}

function buildDaemonConfig(input: {
  paseoHome: string;
  staticDir: string;
  port: number;
  appVersion: string;
  hostAlias: string;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: PaseoDaemonConfig["providerOverrides"];
  mcpEnabled?: boolean;
}): PaseoDaemonConfig {
  return {
    listen: `127.0.0.1:${input.port}`,
    paseoHome: input.paseoHome,
    daemonVersion: input.appVersion,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: input.mcpEnabled ?? true,
    staticDir: input.staticDir,
    mcpDebug: false,
    isDev: true,
    agentClients: input.agentClients,
    providerOverrides: input.providerOverrides,
    agentStoragePath: path.join(input.paseoHome, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    appBaseUrl: "https://app.paseo.sh",
    voiceLlmProvider: null,
    voiceLlmProviderExplicit: false,
    voiceLlmModel: null,
    // The daemon's own fleet identity (hostAlias) + feature switch ride the
    // daemon CONFIG object — bootstrap projects persisted.missionControl into
    // it only on the supervisor path; direct createPaseoDaemon callers pass
    // it explicitly (config.json still carries peers + the central config
    // store file for fleet policy).
    missionControl: { hostAlias: input.hostAlias, enabled: true },
  };
}

async function startDaemonWithTimeout(daemon: PaseoDaemon, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timeoutHandle = setTimeout(() => {
    reject(new Error(`Timed out starting fleet daemon after ${timeoutMs}ms`));
  }, timeoutMs);
  void (async () => {
    try {
      await daemon.start();
      clearTimeout(timeoutHandle);
      resolve();
    } catch (error) {
      clearTimeout(timeoutHandle);
      reject(error);
    }
  })();
  await promise;
}

export async function createFleetHarness(options: FleetHarnessOptions = {}): Promise<FleetHarness> {
  const logger = options.logger ?? pino({ level: "silent" });
  const appVersion = options.appVersion ?? FLEET_TEST_APP_VERSION;
  const agentClients = options.agentClients ?? createTestAgentClients();
  const centralConfig = options.centralConfig ?? {};
  const peersConfig =
    options.peers ??
    ({ A: ["B", "C"], B: ["A"], C: ["A"] } as Record<FleetHostName, FleetHostName[]>);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-fleet-"));
  const cleanupRoots: string[] = [paseoHomeRoot];

  // Phase 1: allocate all three ports so the peer URLs are known before any
  // daemon constructs its PeerManager (peers are read from config.json at
  // createPaseoDaemon time — listen "127.0.0.1:0" cannot be used with
  // cross-referencing peer configs, so ports are pre-allocated; EADDRINUSE
  // retries with a fresh allocation).
  let attempts = 0;
  const daemons = {} as Record<FleetHostName, FleetHarnessDaemon>;
  while (attempts < 5) {
    attempts += 1;
    const ports = await allocatePorts(FLEET_HOSTS.length);
    const portByHost = new Map<FleetHostName, number>(
      FLEET_HOSTS.map((name, index) => [name, ports[index]!]),
    );
    try {
      for (const name of FLEET_HOSTS) {
        const { paseoHome, staticDir } = await writeDaemonSeedFiles({
          paseoHomeRoot,
          name,
          peers: peersConfig[name] ?? [],
          peerPorts: portByHost,
          centralConfig,
        });
        cleanupRoots.push(staticDir);
        const config = buildDaemonConfig({
          paseoHome,
          staticDir,
          port: portByHost.get(name)!,
          appVersion,
          hostAlias: name,
          agentClients,
          providerOverrides: options.providerOverrides,
          mcpEnabled: options.mcpEnabled,
        });
        const daemon = await createPaseoDaemon(config, logger, {});
        await startDaemonWithTimeout(daemon, startupTimeoutMs);
        const listenTarget = daemon.getListenTarget();
        if (!listenTarget || listenTarget.type !== "tcp") {
          throw new Error(`Fleet daemon ${name} did not bind a TCP port`);
        }
        daemons[name] = {
          name,
          daemon,
          port: listenTarget.port,
          paseoHome,
          paseoHomeRoot,
          staticDir,
          client: null as unknown as DaemonClient,
        };
      }
      break;
    } catch (error) {
      // Tear down whatever started; retry with fresh ports unless fatal.
      await teardownDaemons(daemons, cleanupRoots).catch(() => undefined);
      cleanupRoots.length = 0;
      if (!isAddressInUseError(error) || attempts === 5) {
        throw error;
      }
    }
  }

  // Phase 2: connect a client per daemon and wait for peer status online.
  for (const name of FLEET_HOSTS) {
    const daemon = daemons[name];
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion,
      clientType: "cli",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    daemon.client = client;
    mcpPortByClient.set(client, daemon.port);
  }
  const clients = Object.fromEntries(
    FLEET_HOSTS.map((name) => [name, daemons[name].client]),
  ) as Record<FleetHostName, DaemonClient>;

  try {
    // Peers come online asynchronously (PeerManager constructed after start).
    await waitFor(
      async () => {
        const peers = await clients.A.missionControlPeersList().catch(() => ({ peers: [] }));
        const online = new Set(
          peers.peers.filter((peer) => peer.state === "online").map((peer) => peer.name),
        );
        return [...online];
      },
      (online) => {
        const expected = new Set(["B", "C"]);
        return [...expected].every((name) => online.includes(name));
      },
      { timeoutMs: startupTimeoutMs, label: "peers B and C online on A" },
    );
    await waitFor(
      async () => {
        const peers = await clients.B.missionControlPeersList().catch(() => ({ peers: [] }));
        return peers.peers.some((peer) => peer.name === "A" && peer.state === "online");
      },
      (online) => online === true,
      { timeoutMs: startupTimeoutMs, label: "peer A online on B" },
    );
    await waitFor(
      async () => {
        const peers = await clients.C.missionControlPeersList().catch(() => ({ peers: [] }));
        return peers.peers.some((peer) => peer.name === "A" && peer.state === "online");
      },
      (online) => online === true,
      { timeoutMs: startupTimeoutMs, label: "peer A online on C" },
    );

    return {
      daemons,
      clients,
      close: async () => {
        await teardownDaemons(daemons, cleanupRoots);
      },
    };
  } catch (error) {
    await teardownDaemons(daemons, cleanupRoots).catch(() => undefined);
    throw error;
  }
}

async function teardownDaemons(
  daemons: Record<FleetHostName, FleetHarnessDaemon>,
  cleanupRoots: string[],
): Promise<void> {
  for (const name of FLEET_HOSTS) {
    const daemon = daemons[name];
    if (!daemon) {
      continue;
    }
    await daemon.client?.close().catch(() => undefined);
    // Bounded stop: a peer client or lingering run must never hang teardown.
    const { promise: stopPromise, resolve: stopResolve } = Promise.withResolvers<void>();
    const timer = setTimeout(stopResolve, 15_000);
    timer.unref?.();
    try {
      await Promise.race([daemon.daemon.stop().catch(() => undefined), stopPromise]);
    } finally {
      clearTimeout(timer);
    }
    await daemon.daemon.agentManager.flush().catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(
    cleanupRoots.map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
        () => undefined,
      ),
    ),
  );
}

// ============================================================================
// Polling + tool helpers
// ============================================================================

export async function waitFor<T>(
  producer: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  for (;;) {
    last = await producer();
    if (last !== null && predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${opts.label ?? "condition"} (last=${JSON.stringify(last)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A fleet tool call's outcome: structured output, or the tool's error text. */
export type FleetToolOutcome =
  | { ok: true; structuredContent: Record<string, unknown> }
  | { ok: false; error: string };

/** Call a fleet tool on the client's daemon over /mcp/fleet, as a remote MCP client. */
export async function fleetTry(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<FleetToolOutcome> {
  const port = mcpPortByClient.get(client);
  if (port === undefined) {
    throw new Error("fleetTry: client is not a fleet harness client");
  }
  const mcp = new McpClient({ name: HARNESS_MCP_CLIENT, version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fleet`), {
      requestInit: { headers: { Authorization: `Bearer ${HARNESS_MCP_TOKEN}` } },
    }),
  );
  try {
    const result = await mcp.callTool({ name, arguments: args });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((part) => ("text" in part ? part.text : "")).join(" ")
        : "";
      return { ok: false, error: text || "unknown error" };
    }
    const structured = result.structuredContent;
    return { ok: true, structuredContent: structured ? { ...structured } : {} };
  } finally {
    await mcp.close();
  }
}

/** Like fleetTry, but a tool error throws. */
export async function fleetExec(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const outcome = await fleetTry(client, name, args);
  if (!outcome.ok) {
    throw new Error(`fleet tool ${name} failed: ${outcome.error}`);
  }
  return outcome.structuredContent;
}

export interface FleetAgentRow {
  id: string;
  name: string | null;
  title: string | null;
  host: string;
  bucket?: string;
  status?: string;
  workspaceId?: string | null;
  serverId?: string | null;
  [key: string]: unknown;
}

/** Poll fleet_list_agents until a row for agentId satisfies the predicate. */
export async function waitForAgentRow(
  client: DaemonClient,
  agentId: string,
  predicate: (row: FleetAgentRow) => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<FleetAgentRow> {
  return waitFor(
    async () => {
      const payload = await fleetExec(client, "fleet_list_agents", { limit: 200 }).catch(
        () => null,
      );
      if (!payload || !Array.isArray(payload.agents)) {
        return null;
      }
      const row = (payload.agents as FleetAgentRow[]).find((agent) => agent.id === agentId);
      return row ?? null;
    },
    (row) => predicate(row),
    { timeoutMs: opts.timeoutMs ?? 30_000, label: opts.label ?? `roster row for ${agentId}` },
  );
}

/** Poll a daemon's mission-control events feed until a matching event appears. */
export async function waitForEvent(
  client: DaemonClient,
  predicate: (event: MissionControlEvent) => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<MissionControlEvent> {
  return waitFor(
    async () => {
      const payload = await client.missionControlEventsFetch({ limit: 1000 }).catch(() => null);
      if (!payload) {
        return null;
      }
      const event = payload.events.find(predicate);
      return event ?? null;
    },
    () => true,
    { timeoutMs: opts.timeoutMs ?? 30_000, label: opts.label ?? "mission-control event" },
  );
}

/** All events currently on a daemon's feed. */
export async function fetchEvents(client: DaemonClient): Promise<MissionControlEvent[]> {
  const payload = await client.missionControlEventsFetch({ limit: 1000 });
  return payload.events;
}

/** Spawn an agent with fleet_create_agent (a remote MCP client spawns directly). */
export async function spawnWorker(input: {
  from: DaemonClient;
  host: FleetHostName | "local";
  provider?: string;
  initialPrompt: string;
  title?: string;
  workspaceId?: string;
  cwd?: string;
  labels?: Record<string, string>;
  modeId?: string;
}): Promise<{ agentId: string }> {
  // Harness directories are plain directories, not git checkouts: run in place.
  const args: Record<string, unknown> = {
    host: input.host,
    provider: input.provider ?? "claude/test-model",
    initialPrompt: input.initialPrompt,
    title: input.title ?? "Fleet worker",
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.cwd ? { cwd: input.cwd, isolation: "local" } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.modeId ? { settings: { modeId: input.modeId } } : {}),
  };
  const result = await fleetExec(input.from, "fleet_create_agent", args);
  const agentId = result.agentId;
  if (typeof agentId !== "string") {
    throw new Error(`fleet_create_agent returned no agentId: ${JSON.stringify(result)}`);
  }
  return { agentId };
}

/**
 * Resolve the deepseek v4 flash invocable model from a host's model list
 * (fleet_list_models). Returns "provider/model" (e.g. omp/opencode-zen/
 * deepseek-v4-flash-free) or null when unavailable.
 */
export async function resolveDeepseekModel(
  client: DaemonClient,
  host: FleetHostName | "local" = "local",
  timeoutMs = 60_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = await fleetExec(client, "fleet_list_models", { host }).catch(() => null);
    const models = (payload?.models ?? {}) as Record<string, string[]>;
    // The reserved "omp.modelRoles" key carries "role: family/model:effort"
    // strings (from the local ~/.omp/agent/config.yml) and is the ONLY source
    // of omp models when the omp provider snapshot has no catalog. Translate
    // a matching role to the invocable form (provider "omp", effort split
    // off) — exactly what create_agent/fleet_create_agent accept.
    for (const entry of models["omp.modelRoles"] ?? []) {
      const separator = entry.indexOf(": ");
      if (separator <= 0) {
        continue;
      }
      const roleModel = entry.slice(separator + 2).trim();
      const effortColon = roleModel.lastIndexOf(":");
      const model = effortColon > 0 ? roleModel.slice(0, effortColon) : roleModel;
      const lowered = model.toLowerCase();
      if (lowered.includes("deepseek") && lowered.includes("v4") && lowered.includes("flash")) {
        return `omp/${model}`;
      }
    }
    for (const [provider, modelIds] of Object.entries(models)) {
      if (!Array.isArray(modelIds) || provider === "omp.modelRoles") {
        continue;
      }
      const match = modelIds.find(
        (model) =>
          model.toLowerCase().includes("deepseek") &&
          model.toLowerCase().includes("v4") &&
          model.toLowerCase().includes("flash"),
      );
      if (match) {
        return `${provider}/${match}`;
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
