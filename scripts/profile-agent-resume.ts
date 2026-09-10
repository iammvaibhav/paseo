/**
 * Profile cold resume + history hydration for closed agents.
 *
 * Runs OUTSIDE the production daemon: spawns provider processes itself,
 * times phases, then closes. Does not restart port 6767.
 *
 * Usage:
 *   npx tsx scripts/profile-agent-resume.ts
 *   npx tsx scripts/profile-agent-resume.ts --ids bebb5718,8633ed7f
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pino from "pino";

import { ACPAgentSession } from "../packages/server/src/server/agent/providers/acp-agent.js";
import { GenericACPAgentClient } from "../packages/server/src/server/agent/providers/generic-acp-agent.js";
import { ClaudeAgentClient } from "../packages/server/src/server/agent/providers/claude/agent.js";
import { CursorACPAgentClient } from "../packages/server/src/server/agent/providers/cursor-acp-agent.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentSession,
  AgentStreamEvent,
} from "../packages/server/src/server/agent/agent-sdk-types.js";

type PhaseMap = Record<string, number>;

interface AgentRecord {
  id: string;
  provider: string;
  cwd: string;
  lastStatus?: string;
  title?: string;
  archivedAt?: string;
  persistence?: {
    provider?: string;
    sessionId?: string;
    nativeHandle?: string;
    metadata?: Record<string, unknown>;
  };
}

function home(): string {
  return process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
}

function loadAgentRecords(): AgentRecord[] {
  const root = path.join(home(), "agents");
  const out: AgentRecord[] = [];
  if (!fs.existsSync(root)) return out;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as AgentRecord);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function parseIdsArg(): string[] | null {
  const idx = process.argv.indexOf("--ids");
  if (idx < 0 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1]!.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mark(): number {
  return performance.now();
}

function elapsed(t0: number): number {
  return performance.now() - t0;
}

/**
 * Instrument ACP resume phases by patching spawnProcess + initializeResumedSession.
 * initializeResumedSession is reimplemented with the same steps as production code,
 * so we can place timers between spawn / loadSession / overrides.
 */
function installAcpPhaseTimers(phases: PhaseMap): () => void {
  const proto = ACPAgentSession.prototype as unknown as {
    spawnProcess: () => Promise<{
      child: unknown;
      connection: {
        loadSession: (p: unknown) => Promise<unknown>;
        unstable_resumeSession: (p: unknown) => Promise<unknown>;
      };
      initialize: {
        agentCapabilities?: {
          loadSession?: boolean;
          sessionCapabilities?: { resume?: boolean };
        };
      };
    }>;
    initializeResumedSession: () => Promise<void>;
    runACPRequest: <T>(request: () => Promise<T>) => Promise<T>;
  };

  const originalSpawn = proto.spawnProcess;
  const originalInit = proto.initializeResumedSession;
  const originalRun = proto.runACPRequest;

  proto.spawnProcess = async function (this: ACPAgentSession) {
    const t0 = mark();
    const self = this as unknown as {
      runACPRequest: <T>(request: () => Promise<T>) => Promise<T>;
    };
    const prevRun = self.runACPRequest.bind(this);
    let initializeMs = 0;
    let acpCall = 0;
    self.runACPRequest = async <T>(request: () => Promise<T>): Promise<T> => {
      acpCall += 1;
      const t = mark();
      try {
        return await prevRun(request);
      } finally {
        if (acpCall === 1) {
          initializeMs = elapsed(t);
          phases["spawn.acp_initialize"] = initializeMs;
        }
      }
    };
    try {
      const result = await originalSpawn.call(this);
      phases["spawn.total"] = elapsed(t0);
      phases["spawn.process_and_stdio"] = Math.max(0, phases["spawn.total"]! - initializeMs);
      return result;
    } finally {
      self.runACPRequest = prevRun;
    }
  };

  proto.initializeResumedSession = async function (this: ACPAgentSession) {
    const t0 = mark();
    const self = this as unknown as {
      runACPRequest: <T>(request: () => Promise<T>) => Promise<T>;
      applyConfiguredOverrides: () => Promise<void>;
      initialHandle: AgentPersistenceHandle | null;
      agentCapabilities: {
        loadSession?: boolean;
        sessionCapabilities?: { resume?: boolean };
      } | null;
      connection: {
        loadSession: (p: unknown) => Promise<unknown>;
        unstable_resumeSession: (p: unknown) => Promise<unknown>;
      } | null;
      config: { cwd: string };
      replayingHistory: boolean;
      historyPending: boolean;
      persistedHistory: unknown[];
      deliverTranslatedEvents: (x: unknown) => void;
      flushPendingUserMessage: () => unknown;
      applySessionState: (r: unknown) => void;
      acpMcpServers: () => unknown;
      sessionId: string | null;
      bootstrapThreadEventPending: boolean;
      child: unknown;
      closeAfterInitializationFailure: (e: unknown) => Promise<never>;
      spawnProcess: () => Promise<{
        child: unknown;
        connection: {
          loadSession: (p: unknown) => Promise<unknown>;
          unstable_resumeSession: (p: unknown) => Promise<unknown>;
        };
        initialize: {
          agentCapabilities?: {
            loadSession?: boolean;
            sessionCapabilities?: { resume?: boolean };
          };
        };
      }>;
    };

    const handle = self.initialHandle;
    if (!handle) {
      throw new Error("Resume requested without persistence handle");
    }

    try {
      const spawned = await self.spawnProcess();
      self.child = spawned.child;
      self.connection = spawned.connection;
      self.agentCapabilities = spawned.initialize.agentCapabilities ?? null;
      self.sessionId = handle.sessionId;
      self.bootstrapThreadEventPending = true;

      const caps = self.agentCapabilities;
      if (caps?.loadSession) {
        self.replayingHistory = true;
        const tLoad = mark();
        const response = await originalRun.call(this, () =>
          self.connection!.loadSession({
            sessionId: handle.sessionId,
            cwd: self.config.cwd,
            mcpServers: self.acpMcpServers(),
          }),
        );
        phases["session.loadSession"] = elapsed(tLoad);
        phases["session.history_items_buffered"] = self.persistedHistory?.length ?? 0;
        self.deliverTranslatedEvents(self.flushPendingUserMessage());
        self.replayingHistory = false;
        self.historyPending = (self.persistedHistory?.length ?? 0) > 0;
        self.applySessionState(response);
      } else if (caps?.sessionCapabilities?.resume) {
        const tLoad = mark();
        const response = await originalRun.call(this, () =>
          self.connection!.unstable_resumeSession({
            sessionId: handle.sessionId,
            cwd: self.config.cwd,
            mcpServers: self.acpMcpServers(),
          }),
        );
        phases["session.unstable_resumeSession"] = elapsed(tLoad);
        self.applySessionState(response);
      } else {
        throw new Error("provider does not support ACP session resume");
      }

      const tOverride = mark();
      await self.applyConfiguredOverrides();
      phases["session.applyConfiguredOverrides"] = elapsed(tOverride);
      phases["initializeResumedSession.total"] = elapsed(t0);
    } catch (error) {
      phases["initializeResumedSession.total"] = elapsed(t0);
      phases["error"] = 1;
      await self.closeAfterInitializationFailure(error);
    }
  };

  return () => {
    proto.spawnProcess = originalSpawn;
    proto.initializeResumedSession = originalInit;
    proto.runACPRequest = originalRun;
  };
}

function loadProviderCommand(provider: string): [string, ...string[]] | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home(), "config.json"), "utf8")) as {
      agents?: { providers?: Record<string, { command?: string[] }> };
    };
    const cmd = config.agents?.providers?.[provider]?.command;
    if (Array.isArray(cmd) && cmd.length > 0 && typeof cmd[0] === "string") {
      return cmd as [string, ...string[]];
    }
  } catch {
    // fall through
  }
  return null;
}

function createClient(provider: string, logger: pino.Logger): AgentClient {
  if (provider === "claude") {
    return new ClaudeAgentClient({ logger });
  }
  if (provider === "cursor") {
    return new CursorACPAgentClient({
      logger,
      command: loadProviderCommand("cursor") ?? ["cursor-agent", "acp"],
    });
  }
  // Custom ACP profiles (grok, agy, …) — command from ~/.paseo/config.json
  const command =
    loadProviderCommand(provider) ??
    (provider === "grok"
      ? (["grok", "agent", "stdio"] as [string, ...string[]])
      : ([provider, "acp"] as [string, ...string[]]));
  return new GenericACPAgentClient({
    logger,
    command,
    providerId: provider,
  });
}

function providerHistoryFileHint(record: AgentRecord): { path: string; bytes: number } | null {
  const sid = record.persistence?.sessionId;
  if (!sid) return null;
  if (record.provider === "claude" && record.cwd) {
    const enc = record.cwd.replace(/\//g, "-");
    const p = path.join(os.homedir(), ".claude", "projects", enc, `${sid}.jsonl`);
    if (fs.existsSync(p)) return { path: p, bytes: fs.statSync(p).size };
  }
  if (record.provider === "grok" && record.cwd) {
    const enc = encodeURIComponent(record.cwd);
    const p = path.join(os.homedir(), ".grok", "sessions", enc, sid, "chat_history.jsonl");
    if (fs.existsSync(p)) return { path: p, bytes: fs.statSync(p).size };
  }
  return null;
}

async function timeDiskRead(filePath: string): Promise<number> {
  const t0 = mark();
  await fs.promises.readFile(filePath);
  return elapsed(t0);
}

async function streamHistoryCount(session: AgentSession): Promise<{ count: number; ms: number }> {
  const t0 = mark();
  let count = 0;
  for await (const event of session.streamHistory()) {
    if ((event as AgentStreamEvent).type === "timeline") count += 1;
  }
  return { count, ms: elapsed(t0) };
}

function printPhases(phases: PhaseMap): void {
  const rows = Object.entries(phases).sort((a, b) => {
    const skip = (k: string) =>
      k === "disk.bytes" || k.includes("items") || k === "error" || k.includes("buffered");
    const aMs = typeof a[1] === "number" && !skip(a[0]) ? a[1] : 0;
    const bMs = typeof b[1] === "number" && !skip(b[0]) ? b[1] : 0;
    return bMs - aMs;
  });
  console.log("  phases:");
  for (const [k, v] of rows) {
    if (k === "disk.bytes" || k.includes("items") || k.includes("buffered") || k === "error") {
      console.log(`    ${k.padEnd(42)} ${v}`);
    } else {
      console.log(`    ${k.padEnd(42)} ${typeof v === "number" ? `${v.toFixed(1)} ms` : v}`);
    }
  }
  const candidates = rows.filter(
    ([k, v]) =>
      typeof v === "number" &&
      v > 0 &&
      !k.includes("TOTAL") &&
      !k.includes("bytes") &&
      !k.includes("items") &&
      !k.includes("buffered") &&
      k !== "error",
  ) as [string, number][];
  if (candidates.length) {
    const [topK, topV] = candidates[0]!;
    const total = phases["TOTAL_resume_plus_history"] ?? topV;
    console.log(
      `  → dominant: ${topK} (${topV.toFixed(0)} ms, ${((topV / total) * 100).toFixed(0)}% of total)`,
    );
  }
}

async function profileOne(record: AgentRecord, logger: pino.Logger): Promise<void> {
  const phases: PhaseMap = {};
  const handle = record.persistence;
  if (!handle?.sessionId) {
    console.log(`\n## ${record.id.slice(0, 8)} ${record.provider} — no persistence handle, skip`);
    return;
  }

  const title = (record.title ?? "").slice(0, 55);
  console.log(
    `\n## ${record.id.slice(0, 8)}  ${record.provider}  status=${record.lastStatus}  ${title}`,
  );

  const disk = providerHistoryFileHint(record);
  if (disk) {
    const readMs = await timeDiskRead(disk.path);
    console.log(
      `  disk history file: ${(disk.bytes / 1024).toFixed(1)} KiB  raw read ${readMs.toFixed(1)} ms`,
    );
    console.log(`  path: ${disk.path}`);
    phases["disk.raw_read"] = readMs;
    phases["disk.bytes"] = disk.bytes;
  } else {
    console.log("  disk history file: (not found / not applicable)");
  }

  const isAcpFamily = record.provider !== "claude" && record.provider !== "codex";
  const restore = isAcpFamily ? installAcpPhaseTimers(phases) : () => undefined;
  const tTotal = mark();
  let session: AgentSession | null = null;

  try {
    const tClient = mark();
    const client = createClient(record.provider, logger);
    phases["client.construct"] = elapsed(tClient);

    const tAvail = mark();
    const available = await client.isAvailable();
    phases["client.isAvailable"] = elapsed(tAvail);
    if (!available) {
      console.log("  SKIP: provider not available");
      return;
    }

    const resumeHandle: AgentPersistenceHandle = {
      provider: client.provider as AgentPersistenceHandle["provider"],
      sessionId: handle.sessionId!,
      nativeHandle: handle.nativeHandle ?? handle.sessionId,
      metadata: {
        ...handle.metadata,
        provider: client.provider,
        cwd: record.cwd,
      },
    };

    const tResume = mark();
    session = await client.resumeSession(resumeHandle, {
      cwd: record.cwd,
      provider: client.provider,
    } as never);
    phases["resumeSession.total"] = elapsed(tResume);

    const hist = await streamHistoryCount(session);
    phases["streamHistory.ms"] = hist.ms;
    phases["streamHistory.items"] = hist.count;

    phases["TOTAL_resume_plus_history"] = elapsed(tTotal);
  } catch (err) {
    phases["TOTAL_resume_plus_history"] = elapsed(tTotal);
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    restore();
    if (session) {
      const tClose = mark();
      try {
        await session.close();
      } catch {
        // ignore
      }
      phases["session.close"] = elapsed(tClose);
    }
  }

  printPhases(phases);
}

async function main(): Promise<void> {
  const logger = pino({ level: "silent" });
  const all = loadAgentRecords();
  const idFilter = parseIdsArg();

  let candidates: AgentRecord[];
  if (idFilter) {
    candidates = all.filter((a) => idFilter.some((id) => a.id.startsWith(id) || a.id === id));
  } else {
    const closed = all.filter(
      (a) => !a.archivedAt && a.persistence?.sessionId && a.lastStatus === "closed",
    );
    const byProvider = new Map<string, AgentRecord[]>();
    for (const a of closed) {
      const list = byProvider.get(a.provider) ?? [];
      list.push(a);
      byProvider.set(a.provider, list);
    }
    const picked: AgentRecord[] = [];
    for (const [, list] of byProvider) {
      picked.push(...list.slice(0, 2));
    }
    candidates = picked.slice(0, 6);
  }

  console.log(`PASEO_HOME=${home()}`);
  console.log(`Profiling ${candidates.length} agent(s) (cold resume outside daemon)...`);
  console.log("Spawns real provider CLIs; closes after each. Does not touch port 6767.");

  for (const record of candidates) {
    await profileOne(record, logger);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
