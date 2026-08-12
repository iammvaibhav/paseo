// Commander Voice — the voice node. A thin relay: browser audio <-> Gemini
// Live, with the four-tool surface and the announce policy wired to the Paseo
// daemon. Adapted from the gemini-live-speech prototype on iammvaibhav.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { loadConfig } from "./lib/config.js";
import { buildVoiceSystemPrompt } from "./lib/voice-prompt.js";
import { DaemonConnection } from "./lib/daemon.js";
import { getToolDeclarations, executeTool } from "./lib/tools.js";
import { createSessionLogger, truncateValue } from "./lib/session-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function resolveModelId(apiKey) {
  let chosen = "models/gemini-3.1-flash-live-preview";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    );
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || []).map((m) => m.name);
      const g3 = models.find((m) => m.includes("gemini-3-flash-live"));
      if (g3) {
        chosen = g3;
      } else {
        const liveModels = models.filter((m) => m.includes("flash-live") || m.includes("live-"));
        if (liveModels.length > 0) {
          chosen = liveModels[0];
        }
      }
    }
  } catch {
    // keep the default
  }
  return chosen.startsWith("models/") ? chosen : `models/${chosen}`;
}

class VoiceSession {
  constructor({ clientWs, daemon, config, model, sessionId }) {
    this.clientWs = clientWs;
    this.daemon = daemon;
    this.config = config;
    this.model = model;
    this.voiceMode = config.voiceMode === "direct" ? "direct" : "relay";
    this.geminiWs = null;
    this.isConnecting = false;
    this.isSetupDone = false;
    this.pendingClientMessages = [];
    // The mode pick is fixed at session setup (docs: an open session keeps
    // the mode it started with until End). The client init message may
    // override the prompt text (test harness), never the tool surface.
    this.systemInstruction = buildVoiceSystemPrompt(this.voiceMode);
    this.resumeHandle = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isReconnecting = false;
    this.wasResuming = false;
    this.recentTurns = [];
    this.reconnectTimer = null;
    this.isExplicitClose = false;
    // Mirror dedup: track the last mirrored text per role so repeated
    // transcription deliveries do not append duplicate rows.
    this.lastMirroredText = { user: "", assistant: "" };
    this._mirrorSkipLogged = false;
    this.logger = createSessionLogger({ sessionId, logDir: this.config.sessionLogDir });
    this.logger.log("client.connect", {});
    this.logger.log("session.start", {
      model: this.model,
      voiceName: this.config.voiceName,
      voiceMode: this.voiceMode,
    });
  }

  isReady() {
    return this.isSetupDone && this.geminiWs?.readyState === WebSocket.OPEN;
  }

  /** Announce a needs-you event into the Live session (spoken) + page badge. */
  announce(event) {
    if (!this.isReady()) {
      return false;
    }
    const idHint =
      event.kind === "proposal" && event.proposal?.id ? ` — proposal id ${event.proposal.id}` : "";
    const text = `[announcement] ${event.headline}${idHint}${event.detail ? ` — ${event.detail}` : ""}`;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { text } }));
    this.sendJson({
      type: "injected",
      text: event.headline,
      event: { id: event.id, kind: event.kind, severity: event.severity },
    });
    return true;
  }

  sendJson(obj) {
    if (this.clientWs.readyState === WebSocket.OPEN) {
      this.clientWs.send(JSON.stringify(obj));
    }
  }

  initGeminiConnection() {
    if (this.geminiWs || this.isConnecting) return;
    this.isConnecting = true;
    this.wasResuming = Boolean(this.resumeHandle);

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.config.geminiApiKey}`;
    this.geminiWs = new WebSocket(url);

    this.geminiWs.on("open", () => {
      this.isConnecting = false;
      this.logger.log("gemini.setup", {
        model: this.model,
        voiceName: this.config.voiceName,
        voiceMode: this.voiceMode,
        resumeHandle: this.resumeHandle || undefined,
      });
      const setupMsg = {
        setup: {
          model: this.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voiceName } },
            },
            contextWindowCompression: {
              slidingWindow: {},
            },
          },
          systemInstruction: { parts: [{ text: this.systemInstruction }] },
          tools: [{ functionDeclarations: getToolDeclarations(this.voiceMode) }],
          sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        },
      };
      this.geminiWs.send(JSON.stringify(setupMsg));
    });

    this.geminiWs.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.sessionResumptionUpdate) {
          const update = msg.sessionResumptionUpdate;
          if (update.newHandle && update.resumable !== false) {
            this.resumeHandle = update.newHandle;
          }
        }

        if (msg.goAway) {
          this.logger.log("gemini.goAway", {
            code: msg.goAway.code,
            reason: msg.goAway.reason,
            timeLeft: msg.goAway.timeLeft,
          });
        }
        if (msg.setupComplete) {
          this.handleSetupComplete();
          return;
        }

        if (msg.toolCall && msg.toolCall.functionCalls) {
          await this.handleToolCalls(msg.toolCall.functionCalls);
          return;
        }

        if (msg.serverContent) {
          this.handleServerContent(msg.serverContent);
        }
      } catch (err) {
        console.error("Error handling Gemini message:", err.message);
      }
    });

    this.geminiWs.on("error", (err) => {
      console.error("Gemini WSS session error:", err.message);
      this.logger.log("gemini.error", { error: err.message });
      this.handleGeminiDisconnect("error", err.message);
    });

    this.geminiWs.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "";
      console.log(`Gemini WSS session closed: ${code} ${reasonStr}`);
      this.logger.log("gemini.close", { code, reason: reasonStr });
      this.handleGeminiDisconnect("close", `${code} ${reasonStr}`.trim());
    });
  }

  handleGeminiDisconnect(kind, detail) {
    this.isConnecting = false;
    this.isSetupDone = false;
    if (this.geminiWs) {
      this.geminiWs.removeAllListeners();
      this.geminiWs = null;
    }

    if (this.isExplicitClose) return;

    if (this.clientWs.readyState !== WebSocket.OPEN) {
      this.close("client_closed");
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.log("resume.fail", {
        attempts: this.reconnectAttempts,
        reason: "max_attempts_exceeded",
        lastDetail: detail,
      });
      this.logger.log("session.end", { reason: "max_reconnect_attempts_exceeded" });
      this.sendJson({
        type: "system",
        message: "Voice session lost after maximum reconnect attempts.",
      });
      this.close("max_reconnect_attempts_exceeded");
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.close();
      }
      return;
    }

    if (this.wasResuming) {
      this.logger.log("resume.fail", {
        attempts: this.reconnectAttempts + 1,
        handle: this.resumeHandle,
        reason: "resume_handle_rejected",
      });
      this.resumeHandle = null;
    }

    this.reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);

    this.logger.log("resume.attempt", {
      attempt: this.reconnectAttempts,
      handle: this.resumeHandle || null,
      delayMs,
      disconnectKind: kind,
      disconnectDetail: detail,
    });

    this.sendJson({
      type: "system",
      message: `Reconnecting voice session (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
    });

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.clientWs.readyState === WebSocket.OPEN && !this.isExplicitClose) {
        this.initGeminiConnection();
      }
    }, delayMs);
  }

  /** Gemini setupComplete: mark the session ready, then drain messages the
   * browser sent while the Live connection was still being established. */
  handleSetupComplete() {
    this.isSetupDone = true;
    const wasReconnect = this.reconnectAttempts > 0;
    if (wasReconnect) {
      this.logger.log("resume.success", {
        attempt: this.reconnectAttempts,
        resumed: this.wasResuming,
      });
      this.reconnectAttempts = 0;
    }
    this.logger.log("gemini.setupComplete", { resumed: this.wasResuming });
    this.sendJson({ type: "setupAck" });

    if (wasReconnect && !this.wasResuming) {
      this.reinjectCompactContext();
    }
    this.wasResuming = false;

    while (this.pendingClientMessages.length > 0) {
      const item = this.pendingClientMessages.shift();
      if (item.parsed) {
        this.processParsed(item.parsed);
      } else {
        this.sendAudio(item.message);
      }
    }
  }

  recordTurn(role, text) {
    if (!text || !text.trim()) return;
    const trimmed = text.trim();
    const last = this.recentTurns[this.recentTurns.length - 1];
    if (last && last.role === role) {
      last.text += " " + trimmed;
    } else {
      this.recentTurns.push({ role, text: trimmed });
    }
    if (this.recentTurns.length > 10) {
      this.recentTurns.shift();
    }
  }

  /**
   * Mirror a heard user turn or spoken reply into the Commander thread
   * (best-effort; no-ops until the daemon's mirror RPC lands). Pure Q&A uses
   * kind "qa" (hidden in the feed unless verbose); dispatch turns are already
   * recorded by commander_dispatch itself, so the session mirror stays "qa".
   */
  mirrorTurn(role, text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    if (this.lastMirroredText[role] === trimmed) return; // duplicate delivery
    this.lastMirroredText[role] = trimmed;
    this.daemon
      .mirrorVoiceTurn({ role, text: trimmed, kind: "qa" })
      .then((outcome) => {
        if (outcome?.ok) {
          this.logger.log("mirror.ok", { role, kind: "qa" });
        } else if (outcome?.error && !this._mirrorSkipLogged) {
          // The mirror RPC may not be deployed yet; log the absence once per
          // session, not on every turn.
          this._mirrorSkipLogged = true;
          this.logger.log("mirror.skipped", { role, kind: "qa", error: outcome.error });
        }
        return undefined;
      })
      .catch((err) => {
        this.logger.log("mirror.error", { role, kind: "qa", error: err.message });
      });
  }

  reinjectCompactContext() {
    if (this.recentTurns.length === 0) return;
    const contextSummary = this.recentTurns
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
      .join("\n");
    const prompt = `[System note: The voice connection was restarted. Here is a brief transcript of the recent conversation:\n${contextSummary}\nPlease continue seamlessly.]`;

    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.send(
        JSON.stringify({
          realtimeInput: { text: prompt },
        }),
      );
    }
  }

  /** Execute every function call the model made and reply with the results. */
  async handleToolCalls(functionCalls) {
    const functionResponses = [];
    for (const call of functionCalls) {
      this.sendJson({ type: "toolLog", name: call.name, args: call.args });
      this.logger.log("tool.call", { name: call.name, args: call.args, callId: call.id });
      let toolResult;
      try {
        toolResult = await executeTool(call.name, call.args, {
          daemon: this.daemon,
          voiceMode: this.voiceMode,
        });
      } catch (error) {
        toolResult = { error: `Executor failed: ${error.message}` };
      }
      const ok = !toolResult.error;
      const summary = truncateValue(ok ? toolResult.result : toolResult.error, 500);
      this.logger.log("tool.result", {
        name: call.name,
        callId: call.id,
        ok,
        ...(ok ? { summary } : { error: toolResult.error }),
      });
      functionResponses.push({ name: call.name, id: call.id, response: toolResult });
    }
    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({ toolResponse: { functionResponses } }));
    }
  }

  /** Relay serverContent: input/output transcription plus text/audio model parts. */
  handleServerContent(serverContent) {
    // What the USER said (input transcription) — the app's transcript strip
    // renders "heard" lines from this. Additive: the standalone page ignores
    // unknown frame types.
    if (serverContent.inputTranscription?.text) {
      this.recordTurn("user", serverContent.inputTranscription.text);
      this.mirrorTurn("user", serverContent.inputTranscription.text);
      this.sendJson({ type: "inputText", text: serverContent.inputTranscription.text });
    }
    if (serverContent.outputTranscription?.text) {
      this.recordTurn("model", serverContent.outputTranscription.text);
      this.mirrorTurn("assistant", serverContent.outputTranscription.text);
      this.sendJson({ type: "text", text: serverContent.outputTranscription.text });
    }
    if (serverContent.modelTurn?.parts) {
      for (const part of serverContent.modelTurn.parts) {
        this.handleModelTurnPart(part);
      }
    }
  }

  /** Forward one model-turn part to the browser (text frame or PCM audio). */
  handleModelTurnPart(part) {
    if (part.text) {
      this.sendJson({ type: "text", text: part.text });
    }
    if (part.inlineData?.data) {
      const pcmBuf = Buffer.from(part.inlineData.data, "base64");
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.send(pcmBuf, { binary: true });
      }
    }
  }

  processParsed(parsed) {
    if (!this.isSetupDone || this.geminiWs?.readyState !== WebSocket.OPEN) return;
    if (parsed.type === "injectContext" && parsed.text) {
      this.geminiWs.send(
        JSON.stringify({ realtimeInput: { text: `Context Update: ${parsed.text}` } }),
      );
    } else if (parsed.type === "text" && parsed.text) {
      this.recordTurn("user", parsed.text);
      this.geminiWs.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: parsed.text }] }],
            turnComplete: true,
          },
        }),
      );
    }
  }

  sendAudio(buffer) {
    if (!this.isSetupDone || this.geminiWs?.readyState !== WebSocket.OPEN) return;
    this.geminiWs.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: buffer.toString("base64") },
        },
      }),
    );
  }

  /**
   * ws-based clients deliver JSON frames as Buffers (the ws package hands out
   * Buffers for text frames), so JSON is disambiguated from audio by trying to
   * parse first — never by frame type alone.
   */
  handleClientMessage(message, isBinary) {
    const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (parsed) {
      if (parsed.type === "init") {
        if (typeof parsed.systemInstruction === "string" && parsed.systemInstruction.trim()) {
          this.systemInstruction = parsed.systemInstruction;
        }
        this.initGeminiConnection();
        return;
      }
      if (this.isSetupDone) {
        this.processParsed(parsed);
      } else {
        this.pendingClientMessages.push({ parsed });
      }
      return;
    }

    // Binary audio.
    if (!this.isSetupDone) {
      this.pendingClientMessages.push({ message, isBinary });
    } else {
      this.sendAudio(message);
    }
  }

  close(reason = "closed") {
    this.isExplicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.close();
    }
    this.geminiWs = null;
    this.logger.log("client.close", {});
    this.logger.log("session.end", { reason });
    this.logger.close();
  }
}

export async function startVoiceServer(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const model = await resolveModelId(config.geminiApiKey);

  const daemon = new DaemonConnection({
    url: config.paseoWsUrl,
    password: config.paseoPassword,
    appVersion: config.paseoClientVersion,
    clientId: `commander-voice-${process.pid}`,
    updateBufferCap: config.updateBufferCap,
  });
  const sessions = new Set();

  // Announce-policy wiring: inject proposal/needs-you events into every live
  // Gemini session; if none is live the daemon buffers the event instead.
  daemon.onAnnounce = (event) => {
    let accepted = false;
    for (const session of sessions) {
      if (session.announce(event)) {
        accepted = true;
      }
    }
    return accepted;
  };

  let daemonReady = false;
  try {
    await daemon.connect();
    daemonReady = true;
    console.log(`Paseo daemon connected: ${config.paseoWsUrl}`);
    // Central config wins over the env/default when it publishes voiceMode
    // (best-effort; the daemon may not carry the field yet).
    const centralMode = await daemon.fetchVoiceMode();
    if (centralMode) {
      config.voiceMode = centralMode;
      console.log(`Commander Voice mode (central config): ${centralMode}`);
    } else {
      console.log(`Commander Voice mode (env/default): ${config.voiceMode}`);
    }
  } catch (error) {
    console.error(`Paseo daemon connection failed (${config.paseoWsUrl}): ${error.message}`);
  }

  function handleRequest(req, res) {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(__dirname, "public", reqPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    let content;
    try {
      content = readFileSync(filePath);
    } catch (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      res.end(err.code === "ENOENT" ? "404 Not Found" : `Server Error: ${err.code}`);
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  }

  const tls = config.tlsKeyPath && config.tlsCertPath;
  const server = tls
    ? https.createServer(
        { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) },
        handleRequest,
      )
    : http.createServer(handleRequest);

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (clientWs) => {
    const session = new VoiceSession({ clientWs, daemon, config, model });
    sessions.add(session);
    console.log("browser session connected");

    clientWs.on("message", (message, isBinary) => {
      session.handleClientMessage(message, isBinary);
    });
    clientWs.on("close", () => {
      sessions.delete(session);
      session.close("client_disconnected");
      console.log("browser session closed");
    });
    clientWs.on("error", (err) => {
      console.error("browser socket error:", err.message);
      sessions.delete(session);
      session.close();
    });
  });

  await new Promise((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(`Commander Voice listening on http://${config.host}:${config.port}${tls ? "s" : ""}`);

  return {
    server,
    wss,
    daemon,
    sessions,
    config,
    getDaemonReady: () => daemonReady,
    async close() {
      for (const session of sessions) {
        session.close();
      }
      await daemon.close();
      await new Promise((resolve) => {
        wss.close(() => server.close(resolve));
      });
    },
  };
}

// Run standalone when executed directly.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startVoiceServer().catch((error) => {
    console.error("Failed to start Commander Voice:", error.message);
    process.exit(1);
  });
}
