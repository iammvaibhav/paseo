import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { configureDesktopProcessLogging, ignoreBrokenPipe, isBrokenPipeError } from "./desktop-log";

function createStream(isTTY: boolean): NodeJS.WriteStream {
  const stream = new EventEmitter() as NodeJS.WriteStream;
  stream.isTTY = isTTY;
  return stream;
}

describe("isBrokenPipeError", () => {
  it("matches EPIPE and destroyed-stream codes", () => {
    expect(isBrokenPipeError({ code: "EPIPE" })).toBe(true);
    expect(isBrokenPipeError({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
    expect(isBrokenPipeError({ code: "EIO" })).toBe(false);
    expect(isBrokenPipeError("EPIPE")).toBe(false);
  });
});

describe("ignoreBrokenPipe", () => {
  it("swallows EPIPE so a later emit does not throw", () => {
    const stream = createStream(false);
    ignoreBrokenPipe(stream);
    expect(() =>
      stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
  });
});

describe("configureDesktopProcessLogging", () => {
  it("keeps console logging on a TTY and swallows write EPIPE", () => {
    const writeFn = vi.fn(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const log = { transports: { console: { level: "silly" as string | false, writeFn } } };

    configureDesktopProcessLogging(log, {
      stdout: createStream(true),
      stderr: createStream(true),
    });

    expect(log.transports.console.level).toBe("info");
    expect(() => log.transports.console.writeFn?.({ message: { data: ["hi"] } })).not.toThrow();
    expect(writeFn).toHaveBeenCalledOnce();
  });

  it("disables console logging when stdout is not a TTY", () => {
    const log = { transports: { console: { level: "info" as string | false } } };

    configureDesktopProcessLogging(log, {
      stdout: createStream(false),
      stderr: createStream(false),
    });

    expect(log.transports.console.level).toBe(false);
  });

  it("rethrows non-pipe console write failures", () => {
    const writeFn = vi.fn(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const log = { transports: { console: { level: "info" as string | false, writeFn } } };

    configureDesktopProcessLogging(log, {
      stdout: createStream(true),
      stderr: createStream(true),
    });

    expect(() => log.transports.console.writeFn?.({ message: { data: ["hi"] } })).toThrow(
      /disk full/,
    );
  });
});
