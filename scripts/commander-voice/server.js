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
import { VOICE_SYSTEM_PROMPT } from "./lib/voice-prompt.js";
import { DaemonConnection } from "./lib/daemon.js";
import { TOOL_DECLARATIONS, executeTool } from "./lib/tools.js";

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
  constructor({ clientWs, daemon, config, model }) {
    this.clientWs = clientWs;
    this.daemon = daemon;
    this.config = config;
    this.model = model;
    this.geminiWs = null;
    this.isConnecting = false;
    this.isSetupDone = false;
    this.pendingClientMessages = [];
    this.systemInstruction = VOICE_SYSTEM_PROMPT;
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

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.config.geminiApiKey}`;
    this.geminiWs = new WebSocket(url);

    this.geminiWs.on("open", () => {
      const setupMsg = {
        setup: {
          model: this.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voiceName } },
            },
          },
          systemInstruction: { parts: [{ text: this.systemInstruction }] },
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      };
      this.geminiWs.send(JSON.stringify(setupMsg));
    });

    this.geminiWs.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

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
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.close();
      }
    });

    this.geminiWs.on("close", (code, reason) => {
      console.log(`Gemini WSS session closed: ${code} ${reason.toString()}`);
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.close();
      }
    });
  }

  /** Gemini setupComplete: mark the session ready, then drain messages the
   * browser sent while the Live connection was still being established. */
  handleSetupComplete() {
    this.isSetupDone = true;
    this.sendJson({ type: "setupAck" });
    while (this.pendingClientMessages.length > 0) {
      const item = this.pendingClientMessages.shift();
      if (item.parsed) {
        this.processParsed(item.parsed);
      } else {
        this.sendAudio(item.message);
      }
    }
  }

  /** Execute every function call the model made and reply with the results. */
  async handleToolCalls(functionCalls) {
    const functionResponses = [];
    for (const call of functionCalls) {
      this.sendJson({ type: "toolLog", name: call.name, args: call.args });
      let toolResult;
      try {
        toolResult = await executeTool(call.name, call.args, { daemon: this.daemon });
      } catch (error) {
        toolResult = { error: `Executor failed: ${error.message}` };
      }
      functionResponses.push({ name: call.name, id: call.id, response: toolResult });
    }
    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({ toolResponse: { functionResponses } }));
    }
  }

  /** Relay serverContent: output transcription plus text/audio model parts. */
  handleServerContent(serverContent) {
    if (serverContent.outputTranscription?.text) {
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

  close() {
    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.close();
    }
    this.geminiWs = null;
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
      session.close();
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
