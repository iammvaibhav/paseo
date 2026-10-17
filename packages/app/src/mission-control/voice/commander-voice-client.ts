/**
 * M9 Commander Voice — protocol framing + WS client for the voice node
 * (scripts/commander-voice/server.js). Platform-independent: the socket is
 * injected, so this module is unit-testable with a mock WS and runs anywhere
 * (web/Electron only in practice — the panel is gated on isWeb).
 *
 * Wire protocol (additive to the standalone page's, per
 * scripts/commander-voice/README.md):
 *   client → server: {type:"init", systemInstruction?, voiceName?,
 *                     thinkingLevel?, vad?}[, {type:"text", text}] +
 *                     binary PCM16 audio
 *   server → client: {type:"setupAck"} | {type:"text", text} |
 *                    {type:"inputText", text} | {type:"toolLog", name, args} |
 *                    {type:"injected", text, event?} | {type:"interrupt"} |
 *                    {type:"turnComplete"} + binary PCM16 audio
 */

/** Per-session Live options the voice node applies at Gemini setup. */
export interface CommanderVoiceInitOptions {
  systemInstruction?: string;
  /** Verified Live voices: Puck, Charon, Kore, Zephyr, Fenrir, Aoede, Leda, Orus, Nova. */
  voiceName?: string;
  /** Gemini 3 thinking depth (default on the model: minimal). */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /** Live API VAD tuning (realtimeInputConfig.automaticActivityDetection).
   *  Sensitivities use the wire enum constants — the API rejects "HIGH"/"LOW". */
  vad?: {
    startOfSpeechSensitivity?: "START_SENSITIVITY_HIGH" | "START_SENSITIVITY_LOW";
    endOfSpeechSensitivity?: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW";
    silenceDurationMs?: number;
  };
}

export interface CommanderVoiceServerFrame {
  type: "setupAck" | "text" | "inputText" | "toolLog" | "injected" | "interrupt" | "turnComplete";
  /** Output transcription / spoken ack (kind "text") or user speech (kind "inputText"). */
  text?: string;
  /** Tool invocation observed server-side (kind "toolLog"). */
  name?: string;
  args?: unknown;
  /** Announcement payload (kind "injected": proposals, needs-you). */
  event?: { id: string; kind: string; severity: string } | undefined;
}

/** Minimal socket shape: browser WebSocket plus any mock with the same hooks. */
export interface CommanderVoiceSocket {
  binaryType: string;
  readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export type CommanderVoiceClientState = "idle" | "connecting" | "ready" | "closed" | "error";

export interface CommanderVoiceClientHandlers {
  onFrame?: (frame: CommanderVoiceServerFrame) => void;
  /** Binary server frames are PCM16 audio at 24 kHz — hand to the playback path. */
  onAudio?: (pcm16: ArrayBuffer) => void;
  onStateChange?: (state: CommanderVoiceClientState) => void;
  onError?: (message: string) => void;
}

/**
 * Parse one server frame. Returns null for binary audio (or anything that is
 * not a JSON object frame). Frames with an unknown `type` are dropped (null)
 * so a newer voice node never crashes an older app.
 */
export function parseCommanderVoiceFrame(
  data: string | ArrayBuffer,
): CommanderVoiceServerFrame | null {
  if (typeof data !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  switch (type) {
    case "setupAck":
      return { type: "setupAck" };
    case "interrupt":
      return { type: "interrupt" };
    case "turnComplete":
      return { type: "turnComplete" };
    case "text":
    case "inputText":
      return { type, text: String((parsed as { text?: unknown }).text ?? "") };
    case "toolLog": {
      const frame = parsed as { name?: unknown; args?: unknown };
      return { type: "toolLog", name: String(frame.name ?? ""), args: frame.args };
    }
    case "injected": {
      const frame = parsed as { text?: unknown; event?: unknown };
      return {
        type: "injected",
        text: String(frame.text ?? ""),
        event: frame.event as CommanderVoiceServerFrame["event"],
      };
    }
    default:
      return null;
  }
}

export function encodeInitFrame(options?: string | CommanderVoiceInitOptions): string {
  const opts = typeof options === "string" ? { systemInstruction: options } : (options ?? {});
  const frame: Record<string, unknown> = { type: "init" };
  if (opts.systemInstruction?.trim()) {
    frame.systemInstruction = opts.systemInstruction.trim();
  }
  if (opts.voiceName) {
    frame.voiceName = opts.voiceName;
  }
  if (opts.thinkingLevel) {
    frame.thinkingLevel = opts.thinkingLevel;
  }
  if (opts.vad && Object.keys(opts.vad).length > 0) {
    frame.vad = opts.vad;
  }
  return JSON.stringify(frame);
}

export function encodeTextFrame(text: string): string {
  return JSON.stringify({ type: "text", text });
}

/**
 * Accept ws://, wss://, http:// or https:// — http(s) maps to ws(s). The voice
 * node serves its socket at /ws, so a bare origin (no path) gets /ws appended.
 * Returns null for anything unparseable/empty.
 */
export function normalizeVoiceNodeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  const path = url.pathname === "" || url.pathname === "/" ? "/ws" : url.pathname;
  return `${protocol}//${url.host}${path}${url.search}`;
}

export class CommanderVoiceClient {
  private readonly url: string;
  private readonly handlers: CommanderVoiceClientHandlers;
  private readonly wsFactory: (url: string) => CommanderVoiceSocket;
  private readonly sessionOptions: CommanderVoiceInitOptions;
  private ws: CommanderVoiceSocket | null = null;
  private currentState: CommanderVoiceClientState = "idle";
  private closedByUs = false;
  private connectAbort: AbortController | null = null;

  constructor(options: {
    url: string;
    handlers?: CommanderVoiceClientHandlers;
    wsFactory?: (url: string) => CommanderVoiceSocket;
    systemInstruction?: string;
    /** Per-session Live options sent in the init frame (voice, thinking, VAD). */
    sessionOptions?: CommanderVoiceInitOptions;
  }) {
    this.url = options.url;
    this.handlers = options.handlers ?? {};
    this.wsFactory =
      options.wsFactory ??
      ((targetUrl: string) => new WebSocket(targetUrl) as unknown as CommanderVoiceSocket);
    this.sessionOptions = {
      ...options.sessionOptions,
      systemInstruction: options.sessionOptions?.systemInstruction ?? options.systemInstruction,
    };
  }

  get state(): CommanderVoiceClientState {
    return this.currentState;
  }

  connect(): void {
    if (this.ws || this.currentState === "closed" || this.currentState === "error") {
      return;
    }
    this.closedByUs = false;
    const ws = this.wsFactory(this.url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    this.setState("connecting");

    // Listeners are removed via the abort signal on close(), so a live
    // socket never fires into a disconnected client.
    const abort = new AbortController();
    this.connectAbort = abort;
    const { signal } = abort;
    ws.addEventListener(
      "open",
      () => {
        // Send init first; audio/text may follow immediately — the voice node
        // queues client messages until the Gemini session is set up.
        ws.send(encodeInitFrame(this.sessionOptions));
      },
      { signal },
    );
    ws.addEventListener(
      "message",
      (event) => {
        const data = (event as { data: unknown }).data;
        if (typeof data === "string") {
          const frame = parseCommanderVoiceFrame(data);
          if (frame?.type === "setupAck") {
            this.setState("ready");
          }
          if (frame) {
            this.handlers.onFrame?.(frame);
          }
          return;
        }
        if (data instanceof ArrayBuffer) {
          this.handlers.onAudio?.(data);
        }
      },
      { signal },
    );
    ws.addEventListener(
      "error",
      () => {
        this.setState("error");
        this.handlers.onError?.("Voice connection error");
      },
      { signal },
    );
    ws.addEventListener(
      "close",
      () => {
        if (!this.closedByUs) {
          this.setState("closed");
        }
        this.ws = null;
      },
      { signal },
    );
  }

  /** Text intent (e.g. "Any updates?") — queued by the node until the session is live. */
  sendText(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return false;
    }
    ws.send(encodeTextFrame(text));
    return true;
  }

  /** PCM16 mic audio at 16 kHz — queued by the node until the session is live. */
  sendAudio(pcm16: ArrayBuffer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return false;
    }
    ws.send(pcm16);
    return true;
  }

  close(): void {
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    this.connectAbort?.abort();
    this.connectAbort = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closed — nothing to do.
      }
    }
    this.setState("closed");
  }

  private setState(state: CommanderVoiceClientState): void {
    if (state === this.currentState) {
      return;
    }
    this.currentState = state;
    this.handlers.onStateChange?.(state);
  }
}
