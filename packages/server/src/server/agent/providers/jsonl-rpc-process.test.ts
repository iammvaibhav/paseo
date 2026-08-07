import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { JsonlRpcProcess, type JsonlRpcExit } from "./jsonl-rpc-process.js";

const CHILD_SOURCE = String.raw`
const readline = require("node:readline");

function respond(command, success, data, error) {
  process.stdout.write(JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    data,
    error,
  }) + "\n");
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "echo") {
    setTimeout(() => respond(command, true, {
      value: command.value,
      cwd: process.cwd(),
      env: process.env.JSONL_RPC_TEST_VALUE,
      args: process.argv.slice(1),
    }), command.delayMs || 0);
    return;
  }
  if (command.type === "emit") {
    process.stdout.write("not json\n");
    process.stdout.write('{"type":"notice","text":"a');
    setTimeout(() => {
      process.stdout.write('\\u2028b"}\r\n');
      respond(command, true, null);
    }, 5);
    return;
  }
  if (command.type === "chunk") {
    // Mirror the OMP protocol v2 encoder: split one oversized frame into
    // base64 rpc_chunk frames.
    const payload = JSON.stringify(command.frame);
    const buffer = Buffer.from(payload, "utf8");
    const chunkSize = command.chunkSize;
    const count = Math.ceil(buffer.byteLength / chunkSize);
    for (let index = 0; index < count; index += 1) {
      process.stdout.write(JSON.stringify({
        type: "rpc_chunk",
        chunkId: "rpc-1",
        index,
        count,
        byteLength: buffer.byteLength,
        data: buffer.subarray(index * chunkSize, (index + 1) * chunkSize).toString("base64"),
      }) + "\n");
    }
    return;
  }
  if (command.type === "fail") {
    respond(command, false, null, "child rejected the request");
    return;
  }
  if (command.type === "hang") {
    return;
  }
  if (command.type === "exit") {
    process.stderr.write("child exploded");
    setTimeout(() => process.exit(7), 5);
  }
});
`;

interface InMemoryChildProcess extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

interface StartProcessOptions {
  child?: ChildProcessWithoutNullStreams;
}

function createInMemoryChildProcess(): InMemoryChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as InMemoryChildProcess;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

function startProcess(options: StartProcessOptions = {}): JsonlRpcProcess {
  const child = options.child;
  return new JsonlRpcProcess({
    launch: {
      command: process.execPath,
      args: ["-e", CHILD_SOURCE, "--", "resolved-arg"],
      cwd: process.cwd(),
      env: { JSONL_RPC_TEST_VALUE: "resolved-env" },
    },
    logger: pino({ level: "silent" }),
    ...(child ? { spawn: () => child } : {}),
  });
}

function nextExit(transport: JsonlRpcProcess): Promise<JsonlRpcExit> {
  return new Promise((resolve) => {
    const unsubscribe = transport.onExit((exit) => {
      unsubscribe();
      resolve(exit);
    });
  });
}

describe("JsonlRpcProcess", () => {
  test("spawns a resolved command and correlates concurrent requests", async () => {
    const transport = startProcess();

    try {
      const slow = transport.request({ type: "echo", value: "first", delayMs: 20 });
      const fast = transport.request({ type: "echo", value: "second" });

      await expect(Promise.all([slow, fast])).resolves.toEqual([
        {
          value: "first",
          cwd: process.cwd(),
          env: "resolved-env",
          args: ["resolved-arg"],
        },
        {
          value: "second",
          cwd: process.cwd(),
          env: "resolved-env",
          args: ["resolved-arg"],
        },
      ]);
    } finally {
      await transport.close();
    }
  });

  test("publishes complete LF-delimited JSON messages", async () => {
    const transport = startProcess();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    try {
      await transport.request({ type: "emit" });

      expect(messages).toEqual([{ type: "notice", text: "a\u2028b" }]);
    } finally {
      await transport.close();
    }
  });

  test("reassembles a chunked response that exceeds the single-frame limit", async () => {
    const transport = startProcess();
    const value = "x".repeat(2_000_000);

    try {
      await expect(
        transport.request({
          type: "chunk",
          chunkSize: 262_144,
          frame: {
            type: "response",
            id: "req_1",
            command: "chunk",
            success: true,
            data: { value, unicode: "🌍 ünïcode" },
          },
        }),
      ).resolves.toEqual({ value, unicode: "🌍 ünïcode" });
    } finally {
      await transport.close();
    }
  });

  test("reassembles a chunked event frame and publishes it to subscribers", async () => {
    const transport = startProcess();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));
    const text = "y".repeat(1_500_000);

    try {
      transport.send({
        type: "chunk",
        chunkSize: 262_144,
        frame: { type: "notice", text },
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));

      expect(messages[0]).toEqual({ type: "notice", text });
    } finally {
      await transport.close();
    }
  });

  test("drops a chunk sequence with inconsistent metadata without losing later frames", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    try {
      const first = Buffer.from('{"type":"notice","text":"part-', "utf8");
      const second = Buffer.from('one"}', "utf8");
      child.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "rpc-1",
          index: 0,
          count: 2,
          byteLength: first.byteLength + second.byteLength,
          data: first.toString("base64"),
        })}\n`,
      );
      // Wrong chunkId for the open sequence: the whole sequence is dropped.
      child.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "rpc-2",
          index: 1,
          count: 2,
          byteLength: first.byteLength + second.byteLength,
          data: second.toString("base64"),
        })}\n`,
      );
      child.stdout.write(`${JSON.stringify({ type: "notice", text: "after" })}\n`);
      await vi.waitFor(() => expect(messages).toHaveLength(1));

      expect(messages).toEqual([{ type: "notice", text: "after" }]);
    } finally {
      await transport.close();
    }
  });

  test("decodes a multi-byte character split across two stdout reads", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    try {
      const line = Buffer.from(`${JSON.stringify({ type: "notice", text: "🌍" })}\n`, "utf8");
      const splitAt = line.indexOf(Buffer.from("🌍", "utf8")) + 2;
      child.stdout.write(line.subarray(0, splitAt));
      child.stdout.write(line.subarray(splitAt));
      await vi.waitFor(() => expect(messages).toHaveLength(1));

      expect(messages).toEqual([{ type: "notice", text: "🌍" }]);
    } finally {
      await transport.close();
    }
  });

  test("rejects unsuccessful responses", async () => {
    const transport = startProcess();

    try {
      await expect(transport.request({ type: "fail" })).rejects.toThrow(
        "child rejected the request",
      );
    } finally {
      await transport.close();
    }
  });

  test("includes buffered stderr when a request times out", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });

    try {
      child.stderr.write("still waiting");

      await expect(transport.request({ type: "hang" }, 50)).rejects.toThrow(
        "JSONL RPC request timed out for hang\nstill waiting",
      );
    } finally {
      await transport.close();
    }
  });

  test("null timeout waits past short wall-clock limits until the response arrives", async () => {
    const transport = startProcess();

    try {
      await expect(
        transport.request({ type: "echo", value: "slow", delayMs: 80 }, null),
      ).resolves.toMatchObject({ value: "slow" });
    } finally {
      await transport.close();
    }
  });

  test("null timeout still rejects when the process is closed", async () => {
    const transport = startProcess();
    await transport.request({ type: "echo", value: "ready" });
    const request = transport.request({ type: "hang" }, null);

    const rejection = expect(request).rejects.toThrow("JSONL RPC process is closed");
    await transport.close();

    await rejection;
  });

  test("rejects pending requests and publishes stderr when the child exits", async () => {
    const transport = startProcess();
    const exit = nextExit(transport);

    const request = transport.request({ type: "exit" });

    await expect(request).rejects.toThrow("child exploded");
    await expect(exit).resolves.toMatchObject({
      code: 7,
      signal: null,
      error: expect.objectContaining({
        message: expect.stringContaining("child exploded"),
      }),
    });
  });

  test("publishes a synthetic exit when stdout closes while the process stays alive", async () => {
    // A provider that closes its stdout but keeps running stops emitting
    // events with no process-exit signal. The daemon must not wait forever for
    // a terminal that can never arrive: stdout close is surfaced as an exit.
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    const exit = nextExit(transport);

    const request = transport.request({ type: "hang" });
    child.stdout.end();

    await expect(exit).resolves.toMatchObject({
      code: null,
      signal: null,
      error: expect.objectContaining({
        message: expect.stringContaining("stdout closed while the process is still running"),
      }),
    });
    await expect(request).rejects.toThrow("stdout closed while the process is still running");
  });

  test("does not double-publish when stdout closes after a real exit", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    const exits: JsonlRpcExit[] = [];
    transport.onExit((exit) => exits.push(exit));

    child.emit("exit", 7, null);
    child.stdout.end();
    await vi.waitFor(() => expect(exits).toHaveLength(1));

    expect(exits[0]).toMatchObject({ code: 7, signal: null });
  });

  test("rejects pending requests while shutting down the child process", async () => {
    const transport = startProcess();
    await transport.request({ type: "echo", value: "ready" });
    const request = transport.request({ type: "hang" });

    const rejection = expect(request).rejects.toThrow("JSONL RPC process is closed");
    await transport.close();

    await rejection;
  });
});
