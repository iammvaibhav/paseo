import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";

const execFileAsync = promisify(execFile);

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  /**
   * Passed through to spawn when set. `execFile` always pipes stdin, which
   * leaves interactive CLIs (e.g. `omp -p`) waiting for an EOF they never get.
   * Callers that pass a prompt as an argument must use
   * `stdio: ["ignore", "pipe", "pipe"]` so the child sees EOF on stdin.
   */
  stdio?: SpawnOptions["stdio"];
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);

  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawn(resolvedCommand, resolvedArgs, {
    ...spawnOptions,
    env: childEnv,
    shell,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, options?.shell);
  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  if (options?.stdio) {
    return execCommandCollectOutput(resolvedCommand, resolvedArgs, options, childEnv, shell);
  }

  return execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options?.cwd,
    env: childEnv,
    encoding: options?.encoding ?? "utf8",
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell,
    windowsHide: true,
  }) as Promise<ExecCommandResult>;
}

/**
 * `execFile`-style collection over a raw spawn with caller-controlled stdio.
 * Needed whenever the child must NOT inherit a piped stdin that stays open
 * (execFile always pipes, so `omp -p` blocks on an EOF that never arrives).
 * Replicates execFile semantics: timeout kills with killSignal, maxBuffer
 * overflow kills, non-zero exit rejects with stdout/stderr attached.
 */
function execCommandCollectOutput(
  command: string,
  args: string[],
  options: ExecCommandOptions,
  childEnv: NodeJS.ProcessEnv,
  shell: boolean | string | undefined,
): Promise<ExecCommandResult> {
  const encoding = options.encoding ?? "utf8";
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const timeoutMs = options.timeout;
  const killSignal = options.killSignal ?? "SIGTERM";
  const commandLabel = [command, ...args].join(" ");
  const { promise, resolve, reject } = Promise.withResolvers<ExecCommandResult>();

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: childEnv,
    shell,
    windowsHide: true,
    stdio: options.stdio,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  let timedOut = false;
  let settled = false;
  // The DOM + @types/node global `setTimeout` declarations disagree on the
  // handle type; `number` is accepted by both `clearTimeout` signatures.
  let timer: number | undefined;

  const fail = (
    message: string,
    extra: { code?: number | string | null; signal?: NodeJS.Signals | null; killed?: boolean },
  ): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    timer = undefined;
    const error = Object.assign(new Error(message), {
      stdout: Buffer.concat(stdoutChunks).toString(encoding),
      stderr: Buffer.concat(stderrChunks).toString(encoding),
      cmd: commandLabel,
    }) as Error & {
      stdout: string;
      stderr: string;
      cmd: string;
      code?: number | string | null;
      signal?: NodeJS.Signals | null;
      killed?: boolean;
    };
    if (extra.code !== undefined) {
      error.code = extra.code;
    }
    if (extra.signal !== undefined) {
      error.signal = extra.signal;
    }
    if (extra.killed !== undefined) {
      error.killed = extra.killed;
    }
    reject(error);
  };

  const resolveOutput = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    timer = undefined;
    resolve({
      stdout: Buffer.concat(stdoutChunks).toString(encoding),
      stderr: Buffer.concat(stderrChunks).toString(encoding),
    });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBuffer) {
      exceeded = true;
      child.kill(killSignal);
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxBuffer) {
      exceeded = true;
      child.kill(killSignal);
      return;
    }
    stderrChunks.push(chunk);
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(`Failed to spawn ${commandLabel}: ${error.message}`, {
      code: error.code ?? null,
    });
  });
  child.on("close", (code, signal) => {
    if (exceeded) {
      fail(`stdout maxBuffer length exceeded: ${commandLabel}`, {
        code,
        signal,
        killed: true,
      });
      return;
    }
    if (timedOut) {
      fail(`Command failed: ${commandLabel} (timed out after ${timeoutMs}ms)`, {
        code,
        signal,
        killed: true,
      });
      return;
    }
    if (code === 0) {
      resolveOutput();
      return;
    }
    fail(`Command failed: ${commandLabel}`, { code, signal });
  });

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill(killSignal);
    }, timeoutMs) as unknown as number;
  }

  return promise;
}
