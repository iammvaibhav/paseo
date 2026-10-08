export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

export function ignoreBrokenPipe(stream: NodeJS.WritableStream): void {
  stream.on("error", (error) => {
    if (isBrokenPipeError(error)) {
      return;
    }
  });
}

export interface DesktopConsoleTransport<TWrite = { message: unknown }> {
  level: string | false;
  writeFn?: (payload: TWrite) => void;
}

export interface DesktopProcessLogger<TWrite = { message: unknown }> {
  transports: {
    console: DesktopConsoleTransport<TWrite>;
  };
}

/**
 * Packaged Dock / `open` launches often have a closed stdout pipe.
 * electron-log's console transport writes through console.info; an EPIPE
 * there is an uncaught exception and Electron shows a fatal dialog.
 * File transport stays on. Console stays on only when a TTY is attached.
 */
export function configureDesktopProcessLogging<TWrite>(
  log: DesktopProcessLogger<TWrite>,
  streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process,
): void {
  ignoreBrokenPipe(streams.stdout);
  ignoreBrokenPipe(streams.stderr);

  const consoleTransport = log.transports.console;
  consoleTransport.level = streams.stdout.isTTY ? "info" : false;

  const writeFn = consoleTransport.writeFn?.bind(consoleTransport);
  if (!writeFn) {
    return;
  }
  consoleTransport.writeFn = (payload) => {
    try {
      writeFn(payload);
    } catch (error) {
      if (!isBrokenPipeError(error)) {
        throw error;
      }
    }
  };
}
