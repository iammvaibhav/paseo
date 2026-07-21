import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type pino from "pino";
import { formatPlannotatorFeedbackPrompt, parsePlannotatorStdout } from "./parse-decision.js";
import { resolvePlannotatorBinary } from "./resolve-binary.js";

const PORT_RANGE_START = 19_432;
const PORT_RANGE_END = 19_463;
const MAX_CONCURRENT_SESSIONS = 3;
const READY_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 1_500;
const KILL_GRACE_MS = 1_000;

export type PlannotatorSessionKind = "annotate";

export interface PlannotatorSessionMeta {
  sessionId: string;
  kind: PlannotatorSessionKind;
  path: string;
  workspaceDir: string;
  agentId?: string;
  workspaceKey?: string;
  port: number;
  url: string;
  remote: boolean;
}

export type PlannotatorSessionEventPayload =
  | {
      sessionId: string;
      kind: PlannotatorSessionKind;
      path: string;
      agentId?: string;
      workspaceKey?: string;
      event: "feedback";
      decision: "approved" | "annotated" | "dismissed" | "block";
      feedback: string;
      prompt: string;
      raw?: unknown;
    }
  | {
      sessionId: string;
      kind: PlannotatorSessionKind;
      path: string;
      agentId?: string;
      workspaceKey?: string;
      event: "closed";
    };

interface LiveSession extends PlannotatorSessionMeta {
  child: ChildProcess;
  readyFile: string;
  stdoutChunks: string[];
  settled: boolean;
}

export interface PlannotatorSessionManagerOptions {
  logger: pino.Logger;
  onEvent: (event: PlannotatorSessionEventPayload) => void;
  /** Override binary path (tests / config). */
  binaryPath?: string | null;
  now?: () => number;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root) + sep;
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === resolve(root) || normalizedCandidate.startsWith(normalizedRoot);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export class PlannotatorSessionManager {
  private readonly logger: pino.Logger;
  private readonly onEvent: (event: PlannotatorSessionEventPayload) => void;
  private readonly binaryOverride: string | null | undefined;
  private readonly now: () => number;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly usedPorts = new Set<number>();
  private nextPort = PORT_RANGE_START;

  constructor(options: PlannotatorSessionManagerOptions) {
    this.logger = options.logger;
    this.onEvent = options.onEvent;
    this.binaryOverride = options.binaryPath;
    this.now = options.now ?? (() => Date.now());
  }

  isAvailable(): boolean {
    return resolvePlannotatorBinary({ override: this.binaryOverride }) !== null;
  }

  async startAnnotateSession(input: {
    path: string;
    workspaceDir: string;
    agentId?: string;
    workspaceKey?: string;
    remote?: boolean;
  }): Promise<{ sessionId: string; port: number; url: string } | { error: string }> {
    const prepared = this.prepareStart(input);
    if ("error" in prepared) {
      return prepared;
    }

    const remote = input.remote === true;
    const { binary, workspaceDir, absolutePath, port, sessionId, readyFile } = prepared;
    const env = this.buildSpawnEnv({ port, readyFile, remote });

    let child: ChildProcess;
    try {
      child = spawn(binary, ["annotate", absolutePath, "--json", "--gate"], {
        cwd: workspaceDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.releasePort(port);
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to spawn plannotator: ${message}` };
    }

    const session = this.registerSession({
      sessionId,
      absolutePath,
      workspaceDir,
      agentId: input.agentId,
      workspaceKey: input.workspaceKey,
      port,
      remote,
      child,
      readyFile,
    });

    try {
      await this.waitForReady(session);
    } catch (error) {
      await this.forceStop(sessionId, { emitClosed: true });
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }

    this.applyReadyFile(session, readyFile);
    this.logger.info(
      { sessionId, port: session.port, path: absolutePath, remote },
      "plannotator session started",
    );
    return { sessionId, port: session.port, url: session.url };
  }

  async stopSession(sessionId: string): Promise<{ error: string | null }> {
    if (!this.sessions.has(sessionId)) {
      return { error: null };
    }
    await this.forceStop(sessionId, { emitClosed: true, tryExitApi: true });
    return { error: null };
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.forceStop(id, { emitClosed: true, tryExitApi: true })));
  }

  private prepareStart(input: { path: string; workspaceDir: string }):
    | {
        binary: string;
        workspaceDir: string;
        absolutePath: string;
        port: number;
        sessionId: string;
        readyFile: string;
      }
    | { error: string } {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return { error: `Too many Plannotator sessions (max ${MAX_CONCURRENT_SESSIONS})` };
    }
    const binary = resolvePlannotatorBinary({ override: this.binaryOverride });
    if (!binary) {
      return {
        error: "plannotator binary not found (install with scripts/plannotator/install.sh)",
      };
    }
    const workspaceDir = resolve(input.workspaceDir);
    const absolutePath = isAbsolute(input.path)
      ? resolve(input.path)
      : resolve(workspaceDir, input.path);
    if (!isPathInsideRoot(workspaceDir, absolutePath)) {
      return { error: "Path is outside the workspace" };
    }
    const port = this.allocatePort();
    if (port === null) {
      return { error: "No free Plannotator ports available" };
    }
    const sessionId = randomUUID();
    const readyFile = join(tmpdir(), `paseo-plannotator-${sessionId}.ready`);
    try {
      unlinkSync(readyFile);
    } catch {
      // ignore
    }
    return {
      binary,
      workspaceDir,
      absolutePath,
      port,
      sessionId,
      readyFile,
    };
  }

  private buildSpawnEnv(input: {
    port: number;
    readyFile: string;
    remote: boolean;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PLANNOTATOR_PORT: String(input.port),
      PLANNOTATOR_READY_FILE: input.readyFile,
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_ANNOTATE_HISTORY: process.env.PLANNOTATOR_ANNOTATE_HISTORY ?? "0",
      BROWSER: "none",
    };
    if (input.remote) {
      env.PLANNOTATOR_REMOTE = "1";
    }
    return env;
  }

  private registerSession(input: {
    sessionId: string;
    absolutePath: string;
    workspaceDir: string;
    agentId?: string;
    workspaceKey?: string;
    port: number;
    remote: boolean;
    child: ChildProcess;
    readyFile: string;
  }): LiveSession {
    const session: LiveSession = {
      sessionId: input.sessionId,
      kind: "annotate",
      path: input.absolutePath,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      port: input.port,
      url: input.remote ? `http://0.0.0.0:${input.port}` : `http://127.0.0.1:${input.port}`,
      remote: input.remote,
      child: input.child,
      readyFile: input.readyFile,
      stdoutChunks: [],
      settled: false,
    };
    this.sessions.set(input.sessionId, session);
    this.attachChildListeners(session);
    return session;
  }

  private attachChildListeners(session: LiveSession): void {
    const { child, sessionId } = session;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      session.stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      this.logger.debug({ sessionId, chunk: chunk.slice(0, 500) }, "plannotator stderr");
    });
    child.on("error", (error) => {
      this.logger.warn({ err: error, sessionId }, "plannotator process error");
    });
    child.on("exit", () => {
      this.handleProcessExit(sessionId);
    });
  }

  private applyReadyFile(session: LiveSession, readyFile: string): void {
    try {
      const readyRaw = readFileSync(readyFile, "utf8");
      const ready = JSON.parse(readyRaw) as { url?: string; port?: number };
      if (typeof ready.url === "string" && ready.url.trim()) {
        session.url = ready.url.trim();
      }
      if (typeof ready.port === "number" && Number.isFinite(ready.port)) {
        session.port = ready.port;
      }
    } catch {
      // keep defaults
    }
  }

  private allocatePort(): number | null {
    const span = PORT_RANGE_END - PORT_RANGE_START + 1;
    for (let i = 0; i < span; i += 1) {
      const port = this.nextPort;
      this.nextPort = port >= PORT_RANGE_END ? PORT_RANGE_START : port + 1;
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    return null;
  }

  private releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  private async waitForReady(session: LiveSession): Promise<void> {
    const deadline = this.now() + READY_TIMEOUT_MS;
    while (this.now() < deadline) {
      if (session.settled || session.child.exitCode !== null) {
        throw new Error("plannotator exited before becoming ready");
      }
      try {
        const raw = readFileSync(session.readyFile, "utf8");
        if (raw.trim().startsWith("{")) {
          return;
        }
      } catch {
        // not ready yet
      }
      await sleep(100);
    }
    throw new Error("Timed out waiting for plannotator to become ready");
  }

  private handleProcessExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.settled) {
      return;
    }
    session.settled = true;
    this.cleanupSessionFiles(session);
    this.releasePort(session.port);
    this.sessions.delete(sessionId);

    const stdout = session.stdoutChunks.join("");
    const parsed = parsePlannotatorStdout(stdout);
    if (parsed) {
      this.onEvent({
        sessionId,
        kind: session.kind,
        path: session.path,
        ...(session.agentId ? { agentId: session.agentId } : {}),
        ...(session.workspaceKey ? { workspaceKey: session.workspaceKey } : {}),
        event: "feedback",
        decision: parsed.decision,
        feedback: parsed.feedback,
        prompt: formatPlannotatorFeedbackPrompt({
          path: session.path,
          decision: parsed.decision,
          feedback: parsed.feedback,
        }),
        raw: parsed.raw,
      });
      return;
    }

    this.onEvent({
      sessionId,
      kind: session.kind,
      path: session.path,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(session.workspaceKey ? { workspaceKey: session.workspaceKey } : {}),
      event: "closed",
    });
  }

  private async forceStop(
    sessionId: string,
    options: { emitClosed: boolean; tryExitApi?: boolean },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.settled) {
      return;
    }

    if (options.tryExitApi) {
      await this.tryExitApi(session);
    }
    await this.signalChild(session);

    if (!session.settled) {
      this.settleAsClosed(session, options.emitClosed);
    }
  }

  private async tryExitApi(session: LiveSession): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${session.port}/api/exit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(EXIT_GRACE_MS),
      });
      await this.waitUntilSettledOrExited(session, EXIT_GRACE_MS);
    } catch {
      // fall through to signal
    }
  }

  private async signalChild(session: LiveSession): Promise<void> {
    if (session.settled || session.child.exitCode !== null) {
      return;
    }
    try {
      session.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await this.waitUntilSettledOrExited(session, KILL_GRACE_MS);
    if (!session.settled && session.child.exitCode === null) {
      try {
        session.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  private async waitUntilSettledOrExited(session: LiveSession, ms: number): Promise<void> {
    const deadline = this.now() + ms;
    while (this.now() < deadline && !session.settled && session.child.exitCode === null) {
      await sleep(50);
    }
  }

  private settleAsClosed(session: LiveSession, emitClosed: boolean): void {
    session.settled = true;
    this.cleanupSessionFiles(session);
    this.releasePort(session.port);
    this.sessions.delete(session.sessionId);
    if (!emitClosed) {
      return;
    }
    this.onEvent({
      sessionId: session.sessionId,
      kind: session.kind,
      path: session.path,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(session.workspaceKey ? { workspaceKey: session.workspaceKey } : {}),
      event: "closed",
    });
  }

  private cleanupSessionFiles(session: LiveSession): void {
    try {
      unlinkSync(session.readyFile);
    } catch {
      // ignore
    }
  }
}
