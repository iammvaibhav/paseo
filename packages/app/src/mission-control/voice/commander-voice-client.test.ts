import { describe, expect, it, vi } from "vitest";
import {
  CommanderVoiceClient,
  encodeInitFrame,
  encodeTextFrame,
  normalizeVoiceNodeUrl,
  parseCommanderVoiceFrame,
  type CommanderVoiceSocket,
} from "./commander-voice-client";

class MockSocket implements CommanderVoiceSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  sent: Array<{ type: "text" | "binary"; data: string | ArrayBuffer }> = [];
  closed = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    this.readyState = 0;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    options?.signal?.addEventListener("abort", () => this.removeEventListener(type, listener), {
      once: true,
    });
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: "open" | "message" | "close" | "error", event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push({ type: typeof data === "string" ? "text" : "binary", data });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  deliver(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }

  fail(): void {
    this.emit("error", {});
  }

  /** Simulate the transport closing from the server side (no flag mutation). */
  serverClose(): void {
    this.emit("close", {});
  }
}

describe("parseCommanderVoiceFrame", () => {
  it("parses setupAck", () => {
    expect(parseCommanderVoiceFrame('{"type":"setupAck"}')).toEqual({ type: "setupAck" });
  });

  it("parses interrupt and turnComplete frames", () => {
    expect(parseCommanderVoiceFrame('{"type":"interrupt"}')).toEqual({ type: "interrupt" });
    expect(parseCommanderVoiceFrame('{"type":"turnComplete"}')).toEqual({ type: "turnComplete" });
  });
  it("parses output text (spoken ack) and input text (what it heard)", () => {
    expect(parseCommanderVoiceFrame('{"type":"text","text":"on it"}')).toEqual({
      type: "text",
      text: "on it",
    });
    expect(
      parseCommanderVoiceFrame('{"type":"inputText","text":"what is the fleet status"}'),
    ).toEqual({
      type: "inputText",
      text: "what is the fleet status",
    });
  });

  it("parses toolLog frames", () => {
    expect(
      parseCommanderVoiceFrame(
        '{"type":"toolLog","name":"commander_dispatch","args":{"message":"x"}}',
      ),
    ).toEqual({
      type: "toolLog",
      name: "commander_dispatch",
      args: { message: "x" },
    });
  });

  it("parses injected announcements with the event payload", () => {
    expect(
      parseCommanderVoiceFrame(
        '{"type":"injected","text":"proposal needs you","event":{"id":"p1","kind":"proposal","severity":"blocker"}}',
      ),
    ).toEqual({
      type: "injected",
      text: "proposal needs you",
      event: { id: "p1", kind: "proposal", severity: "blocker" },
    });
  });

  it("returns null for binary audio frames", () => {
    expect(parseCommanderVoiceFrame(new ArrayBuffer(8))).toBeNull();
  });

  it("returns null for non-JSON text and unknown frame types (forward-compat)", () => {
    expect(parseCommanderVoiceFrame("not json")).toBeNull();
    expect(parseCommanderVoiceFrame('{"type":"futureFrame"}')).toBeNull();
    expect(parseCommanderVoiceFrame("42")).toBeNull();
  });
});

describe("frame encoding", () => {
  it("encodes init without a system instruction", () => {
    expect(encodeInitFrame()).toBe('{"type":"init"}');
    expect(encodeInitFrame("   ")).toBe('{"type":"init"}');
  });

  it("encodes init with a trimmed system instruction", () => {
    expect(encodeInitFrame("  relay persona  ")).toBe(
      '{"type":"init","systemInstruction":"relay persona"}',
    );
  });

  it("encodes text intents", () => {
    expect(encodeTextFrame("Any updates?")).toBe('{"type":"text","text":"Any updates?"}');
  });
});

describe("normalizeVoiceNodeUrl", () => {
  it("keeps ws/wss URLs and appends /ws to a bare origin", () => {
    expect(normalizeVoiceNodeUrl("ws://127.0.0.1:8787/ws")).toBe("ws://127.0.0.1:8787/ws");
    expect(normalizeVoiceNodeUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(normalizeVoiceNodeUrl("wss://voice.example.com:8787")).toBe(
      "wss://voice.example.com:8787/ws",
    );
  });

  it("maps http(s) to ws(s)", () => {
    expect(normalizeVoiceNodeUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(normalizeVoiceNodeUrl("https://voice.example.com")).toBe("wss://voice.example.com/ws");
  });

  it("keeps an explicit path", () => {
    expect(normalizeVoiceNodeUrl("ws://127.0.0.1:8787/voice")).toBe("ws://127.0.0.1:8787/voice");
  });

  it("returns null for empty, whitespace-only, or unparseable input", () => {
    expect(normalizeVoiceNodeUrl(null)).toBeNull();
    expect(normalizeVoiceNodeUrl("")).toBeNull();
    expect(normalizeVoiceNodeUrl("   ")).toBeNull();
    expect(normalizeVoiceNodeUrl("not a url")).toBeNull();
  });
});

describe("CommanderVoiceClient lifecycle", () => {
  it("connects, sends init on open, and becomes ready on setupAck", () => {
    const socket = new MockSocket();
    const onStateChange = vi.fn();
    const onFrame = vi.fn();
    const client = new CommanderVoiceClient({
      url: "ws://127.0.0.1:8787/ws",
      wsFactory: () => socket,
      handlers: { onStateChange, onFrame },
    });
    expect(client.state).toBe("idle");
    client.connect();
    expect(client.state).toBe("connecting");
    socket.open();
    expect(socket.sent[0]).toEqual({ type: "text", data: '{"type":"init"}' });
    socket.deliver('{"type":"setupAck"}');
    expect(client.state).toBe("ready");
    expect(onStateChange).toHaveBeenCalledWith("ready");
    expect(onFrame).toHaveBeenCalledWith({ type: "setupAck" });
  });

  it("routes JSON frames to onFrame and binary audio to onAudio", () => {
    const socket = new MockSocket();
    const onFrame = vi.fn();
    const onAudio = vi.fn();
    const client = new CommanderVoiceClient({
      url: "ws://127.0.0.1:8787/ws",
      wsFactory: () => socket,
      handlers: { onFrame, onAudio },
    });
    client.connect();
    socket.open();
    socket.deliver('{"type":"inputText","text":"hello commander"}');
    const pcm = new ArrayBuffer(32);
    socket.deliver(pcm);
    expect(onFrame).toHaveBeenCalledWith({ type: "inputText", text: "hello commander" });
    expect(onAudio).toHaveBeenCalledWith(pcm);
  });

  it("sends text + audio only while the socket is open", () => {
    const socket = new MockSocket();
    const client = new CommanderVoiceClient({
      url: "ws://127.0.0.1:8787/ws",
      wsFactory: () => socket,
    });
    client.connect();
    expect(client.sendText("Any updates?")).toBe(false);
    expect(client.sendAudio(new ArrayBuffer(16))).toBe(false);
    socket.open();
    expect(client.sendText("Any updates?")).toBe(true);
    expect(client.sendAudio(new ArrayBuffer(16))).toBe(true);
    expect(socket.sent[1]).toEqual({ type: "text", data: '{"type":"text","text":"Any updates?"}' });
    expect(socket.sent[2].type).toBe("binary");
    expect((socket.sent[2].data as ArrayBuffer).byteLength).toBe(16);
  });

  it("flags error state and closes without re-entering onclose", () => {
    const socket = new MockSocket();
    const onStateChange = vi.fn();
    const onError = vi.fn();
    const client = new CommanderVoiceClient({
      url: "ws://127.0.0.1:8787/ws",
      wsFactory: () => socket,
      handlers: { onStateChange, onError },
    });
    client.connect();
    socket.open();
    socket.fail();
    expect(client.state).toBe("error");
    expect(onError).toHaveBeenCalledWith("Voice connection error");

    client.close();
    expect(socket.closed).toBe(true);
    expect(client.state).toBe("closed");
    // A late close event from the transport must not clobber the closed state.
    socket.serverClose();
    expect(client.state).toBe("closed");
  });

  it("ignores connect() after close", () => {
    const socket = new MockSocket();
    const client = new CommanderVoiceClient({
      url: "ws://127.0.0.1:8787/ws",
      wsFactory: () => socket,
    });
    client.connect();
    client.close();
    client.connect();
    expect(socket.closed).toBe(true);
    expect(client.state).toBe("closed");
  });
});
