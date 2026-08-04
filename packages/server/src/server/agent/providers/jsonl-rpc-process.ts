import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

/** Default wall-clock timeout for control-plane / short RPC calls. */
export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Pass as `timeoutMs` to wait only for a response, process death, or `close()`.
 * Use for long-running blocking RPCs (e.g. LLM-backed compact).
 */
export const JSONL_RPC_NO_TIMEOUT = null;

const STDERR_BUFFER_LIMIT = 8192;
/** Frames can be multi-MiB; keep the diagnostic for an unparseable one bounded. */
const LOGGED_LINE_LIMIT = 2048;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

/**
 * OMP/Pi RPC protocol v2 splits any frame over the 1 MiB line limit into
 * `rpc_chunk` frames. Cap reassembly at the sender's own ceiling (64 MiB) so a
 * corrupt or hostile `byteLength` cannot make us buffer without bound.
 */
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

interface ChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  received: number;
  chunks: Buffer[];
}

interface RpcChunk {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/** Validate one `rpc_chunk` envelope against the same bounds the sender applies. */
function parseRpcChunk(frame: Record<string, unknown>): RpcChunk | null {
  const { chunkId, index, count, byteLength, data } = frame;
  if (typeof chunkId !== "string" || chunkId.length === 0 || typeof data !== "string") {
    return null;
  }
  if (
    typeof index !== "number" ||
    typeof count !== "number" ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(byteLength)
  ) {
    return null;
  }
  if (index < 0 || count < 2 || index >= count) {
    return null;
  }
  if (byteLength <= 0 || byteLength > MAX_REASSEMBLED_FRAME_BYTES) {
    return null;
  }
  return { chunkId, index, count, byteLength, data };
}

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface JsonlRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface JsonlRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  logger: Logger;
  diagnosticName?: string;
  spawn?: (launch: JsonlRpcLaunch) => ChildProcessWithoutNullStreams;
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSONL RPC process was spawned without stdio streams");
  }
}

function spawnJsonlRpcProcess(launch: JsonlRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    envOverlay: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertChildWithPipes(child);
  return child;
}

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageSubscribers = new Set<(message: Record<string, unknown>) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonlRpcExit) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private stdoutBuffer = "";
  private chunkSequence: ChunkSequence | null = null;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.child = (options.spawn ?? spawnJsonlRpcProcess)(options.launch);
    // Decode with a StringDecoder so a multi-byte character split across two
    // stdout reads is not corrupted. Multi-MiB frames (protocol v2 chunks)
    // always straddle read boundaries.
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    this.child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onMessage(callback: (message: Record<string, unknown>) => void): () => void {
    this.messageSubscribers.add(callback);
    return () => {
      this.messageSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonlRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  startRequest(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(timeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out for ${command.type}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.disposed) return;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
    if (result === "kill-timeout") {
      this.options.logger.warn(
        { timeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS },
        `${this.diagnosticName} process did not report exit after SIGKILL`,
      );
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    const frame = this.parseFrame(line);
    if (!frame) {
      return;
    }
    if (frame.type === "rpc_chunk") {
      const reassembled = this.reassembleChunk(frame);
      if (reassembled) {
        this.dispatchFrame(reassembled);
      }
      return;
    }
    if (this.chunkSequence) {
      this.options.logger.warn(
        { chunkId: this.chunkSequence.chunkId, frameType: frame.type },
        `Discarding interrupted ${this.diagnosticName} chunk sequence`,
      );
      this.chunkSequence = null;
    }
    this.dispatchFrame(frame);
  }

  private parseFrame(line: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.options.logger.warn(
        { error, line: line.slice(0, LOGGED_LINE_LIMIT), lineLength: line.length },
        `Ignoring non-JSON ${this.diagnosticName} stdout line`,
      );
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  private dispatchFrame(message: Record<string, unknown>): void {
    if (message.type === "response") {
      this.handleResponse(message as unknown as JsonlRpcResponse);
      return;
    }
    for (const subscriber of this.messageSubscribers) {
      subscriber(message);
    }
  }

  /**
   * Accumulate one `rpc_chunk` frame, returning the decoded frame once the last
   * chunk lands. Any protocol violation drops the whole sequence: the sender
   * only chunks frames that would otherwise be truncated, so losing one is no
   * worse than protocol v1 and never desynchronizes later frames.
   */
  private reassembleChunk(frame: Record<string, unknown>): Record<string, unknown> | null {
    const chunk = parseRpcChunk(frame);
    if (!chunk) {
      return this.dropChunkSequence("invalid rpc chunk metadata", { chunkId: frame.chunkId });
    }
    const { chunkId, index, count, byteLength, data } = chunk;
    if (index === 0) {
      this.chunkSequence = { chunkId, count, byteLength, nextIndex: 0, received: 0, chunks: [] };
    }
    const sequence = this.chunkSequence;
    if (!sequence) {
      return this.dropChunkSequence("rpc chunk sequence must start at index 0", { chunkId });
    }
    if (
      sequence.chunkId !== chunkId ||
      sequence.count !== count ||
      sequence.byteLength !== byteLength ||
      sequence.nextIndex !== index
    ) {
      return this.dropChunkSequence("rpc chunk sequence mismatch", { chunkId });
    }
    const payload = Buffer.from(data, "base64");
    sequence.chunks.push(payload);
    sequence.received += payload.byteLength;
    sequence.nextIndex += 1;
    if (sequence.received > sequence.byteLength) {
      return this.dropChunkSequence("rpc chunk sequence exceeds declared length", { chunkId });
    }
    if (sequence.nextIndex < sequence.count) {
      return null;
    }
    this.chunkSequence = null;
    if (sequence.received !== sequence.byteLength) {
      return this.dropChunkSequence("rpc chunk sequence length mismatch", { chunkId });
    }
    return this.parseFrame(Buffer.concat(sequence.chunks).toString("utf8"));
  }

  private dropChunkSequence(reason: string, context: Record<string, unknown>): null {
    this.chunkSequence = null;
    this.options.logger.warn(context, `Ignoring ${this.diagnosticName} chunk frame: ${reason}`);
    return null;
  }

  private handleResponse(response: JsonlRpcResponse): void {
    if (!response.id) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(
        new Error(
          response.error ?? `${this.diagnosticName} ${response.command ?? "request"} failed`,
        ),
      );
      return;
    }
    pending.resolve(response.data);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Schedule a request timeout, or return null when the call should wait
 * indefinitely for a response, process exit, or close().
 */
function createRequestTimeout(
  timeoutMs: number | null,
  onTimeout: () => void,
): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}
