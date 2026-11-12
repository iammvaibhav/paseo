import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  name: "paseo65-mcp-images",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "A remote /mcp/fleet client moves images only through MCP: a >100 KB inline image at creation, a chunked " +
    "fleet_upload_file whose fileId reaches an existing agent on a peer (queue) and a busy local agent (steer), " +
    "a non-image upload delivered to the peer as an uploaded_file, fleet_read_image of a peer file, and a " +
    "JSON-RPC 413 above the 25 MB body cap. Real omp agents read the image text back.",
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, "../../..");
const PROOF_DIR = path.join(WORKTREE, "proof");
const serverRequire = createRequire(path.join(WORKTREE, "packages/server/package.json"));
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const CLIENT_NAME = "paseo65-images";
const TOKEN = randomBytes(24).toString("hex");
const NOTES_SECRET = `NOTES-${randomBytes(3).toString("hex").toUpperCase()}`;

let mcp;
let mcpUrl;
const agents = {};
const files = {};

async function call(name, args, { allowError = false } = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = result.content?.map((block) => block.text ?? "").join(" ") ?? "";
  if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
  return { ...result, text };
}

async function waitTurn(agentId, turnId) {
  const result = await call("fleet_wait_agent", { agentId, turnId, timeoutSeconds: 600 });
  return result.structuredContent;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const steps = [
  {
    id: "connect",
    label: "Register a remote MCP client and list the image tools",
    narrate: "The client connects to /mcp/fleet and sees fleet_upload_file and fleet_read_image.",
    async run(ctx) {
      const commander = ctx.host("commander");
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      const configPath = path.join(commander.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.daemon = config.daemon ?? {};
      config.daemon.mcp = config.daemon.mcp ?? {};
      config.daemon.mcp.remoteClients = [{ name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4) }];
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2));

      const { Client } = await importFromServer("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await importFromServer(
        "@modelcontextprotocol/sdk/client/streamableHttp.js",
      );
      mcpUrl = `${commander.httpUrl}/mcp/fleet`;
      mcp = new Client({ name: CLIENT_NAME, version: "1.0.0" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
      for (const name of ["fleet_upload_file", "fleet_read_image"]) {
        ctx.expect(tools.includes(name), `${name} is listed`);
      }
      for (const name of ["marker-create.png", "marker-send.png", "marker-steer.png"]) {
        files[name] = await fsp.readFile(path.join(PROOF_DIR, name));
      }
      return `connected; ${tools.length} tools`;
    },
  },
  {
    id: "body-limit",
    label: "A 26 MB request body gets a JSON-RPC 413 that names the limit",
    narrate: "Above 25 MB the client reads a clear JSON-RPC error instead of an HTML page.",
    async run(ctx) {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "fleet_upload_file", arguments: { data: "A".repeat(26 * 1024 * 1024) } },
        }),
      });
      const body = await response.json();
      ctx.expect(response.status === 413, `HTTP 413 (${response.status})`);
      ctx.expect(
        /exceeds the 25 MB \/mcp request limit/.test(body.error?.message ?? ""),
        `message names the limit: ${body.error?.message}`,
      );
      return `HTTP ${response.status}: ${body.error.message}`;
    },
  },
  {
    id: "create-inline",
    label: "fleet_create_agent with a 331 KB base64 image: the new agent reads it",
    narrate: "An image body above the old 100 KB limit creates an agent that reads the marker.",
    async run(ctx) {
      const provider = ctx.stack.commanderModel;
      ctx.expect(Boolean(provider), "stack resolved an omp model");
      const cwd = path.join(ctx.host("commander").home, "projects", "paseo65-local");
      await fsp.mkdir(cwd, { recursive: true });
      const data = files["marker-create.png"].toString("base64");
      const created = await call("fleet_create_agent", {
        host: "commander",
        cwd,
        isolation: "local",
        provider,
        title: "paseo65 local",
        initialPrompt:
          "What text is in the attached image? Reply with only that text. Do not use tools.",
        images: [{ data, mimeType: "image/png" }],
      });
      const sc = created.structuredContent;
      agents.local = { agentId: sc.agentId, host: "commander" };
      const done = await waitTurn(sc.agentId, sc.turnId);
      ctx.expect(
        (done.lastMessage ?? "").includes("7QX"),
        `agent read the create image: ${done.lastMessage}`,
      );
      return `base64 ${data.length} chars; reply: ${done.lastMessage}`;
    },
  },
  {
    id: "upload-chunked",
    label: "fleet_upload_file in two chunks returns a fileId",
    narrate: "The send image is uploaded in two chunks.",
    async run(ctx) {
      const bytes = files["marker-send.png"];
      const half = Math.floor(bytes.byteLength / 2);
      const first = await call("fleet_upload_file", {
        fileName: "marker-send.png",
        mimeType: "image/png",
        size: bytes.byteLength,
        data: bytes.subarray(0, half).toString("base64"),
      });
      ctx.expect(first.structuredContent.complete === false, "first chunk leaves it incomplete");
      const second = await call("fleet_upload_file", {
        uploadId: first.structuredContent.uploadId,
        data: bytes.subarray(half).toString("base64"),
      });
      ctx.expect(second.structuredContent.complete === true, "second chunk completes it");
      files.sendId = second.structuredContent.fileId;
      const steer = await call("fleet_upload_file", {
        fileName: "marker-steer.png",
        mimeType: "image/png",
        data: files["marker-steer.png"].toString("base64"),
      });
      files.steerId = steer.structuredContent.fileId;
      const notes = await call("fleet_upload_file", {
        fileName: "notes.txt",
        mimeType: "text/plain",
        data: Buffer.from(`The secret word is ${NOTES_SECRET}.\n`).toString("base64"),
      });
      files.notesId = notes.structuredContent.fileId;
      return `send ${files.sendId}, steer ${files.steerId}, notes ${files.notesId}`;
    },
  },
  {
    id: "send-peer-image",
    label: "fleet_send_prompt images [{fileId}] to an existing agent on peer-b",
    narrate: "An already-created agent on the peer reads the uploaded image.",
    async run(ctx) {
      const cwd = path.join(ctx.host("peer-b").home, "projects", "paseo65-peer");
      await fsp.mkdir(cwd, { recursive: true });
      const created = await call("fleet_create_agent", {
        host: "peer-b",
        cwd,
        isolation: "local",
        provider: ctx.stack.commanderModel,
        title: "paseo65 peer",
        initialPrompt: "Reply with exactly: READY. Do not use tools.",
      });
      const agentId = created.structuredContent.agentId;
      agents.peer = { agentId, host: "peer-b" };
      await waitTurn(agentId, created.structuredContent.turnId);
      const sent = await call("fleet_send_prompt", {
        agentId,
        mode: "queue",
        prompt: "What text is in the attached image? Reply with only that text. Do not use tools.",
        images: [{ fileId: files.sendId }],
      });
      const done = await waitTurn(agentId, sent.structuredContent.turnId);
      ctx.expect(
        (done.lastMessage ?? "").includes("4MZ"),
        `peer agent read the uploaded image: ${done.lastMessage}`,
      );
      return `reply: ${done.lastMessage}`;
    },
  },
  {
    id: "steer-busy",
    label: "fleet_send_prompt steer with an image into a busy local agent",
    narrate: "A live steer carries the image into the running turn.",
    async run(ctx) {
      const { agentId } = agents.local;
      const busy = await call("fleet_send_prompt", {
        agentId,
        mode: "queue",
        prompt:
          "Use your shell tool to run `sleep 20` and then reply with exactly: SLEPT. " +
          "If you receive another message while working, follow it too.",
      });
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const status = await call("fleet_agent_status", { agentId });
      const steered = await call("fleet_send_prompt", {
        agentId,
        mode: "steer",
        prompt: "Additionally: when you reply, also include the text shown in the attached image.",
        images: [{ fileId: files.steerId }],
      });
      const done = await waitTurn(
        agentId,
        steered.structuredContent.turnId ?? busy.structuredContent.turnId,
      );
      ctx.expect(
        (done.lastMessage ?? "").includes("9KP"),
        `busy agent read the steered image: ${done.lastMessage}`,
      );
      return `bucket at steer: ${status.structuredContent.bucket}; delivered as ${steered.structuredContent.deliveryMode}; reply: ${done.lastMessage}`;
    },
  },
  {
    id: "send-peer-file",
    label: "A non-image upload reaches the peer agent as an uploaded_file it can open",
    narrate: "The peer agent opens its own copy of the uploaded text file.",
    async run(ctx) {
      const { agentId } = agents.peer;
      const sent = await call("fleet_send_prompt", {
        agentId,
        mode: "queue",
        prompt: "Read the attached file with your read tool and reply with only the secret word.",
        attachments: [{ type: "uploaded_file", id: files.notesId }],
      });
      const done = await waitTurn(agentId, sent.structuredContent.turnId);
      ctx.expect(
        (done.lastMessage ?? "").includes(NOTES_SECRET),
        `peer agent read the file: ${done.lastMessage}`,
      );
      const peerUploads = await fsp.readdir(path.join(ctx.host("peer-b").home, "uploads"));
      ctx.expect(peerUploads.length > 0, "peer-b holds its own copy in its upload store");
      return `reply: ${done.lastMessage}; peer-b uploads: ${peerUploads.join(", ")}`;
    },
  },
  {
    id: "read-peer-image",
    label: "fleet_read_image returns a PNG saved on peer-b as MCP image content",
    narrate: "An image on the peer comes back over MCP byte for byte.",
    async run(ctx) {
      const source = path.join(
        ctx.host("peer-b").home,
        "projects",
        "paseo65-peer",
        "screenshot.png",
      );
      await fsp.writeFile(source, files["marker-create.png"]);
      const read = await call("fleet_read_image", { agentId: agents.peer.agentId, path: source });
      const image = read.content.find((block) => block.type === "image");
      ctx.expect(image?.mimeType === "image/png", "image block is image/png");
      const bytes = Buffer.from(image.data, "base64");
      ctx.expect(sha256(bytes) === sha256(files["marker-create.png"]), "bytes match the peer file");
      const out = path.join(PROOF_DIR, "read-back-from-peer.png");
      await fsp.writeFile(out, bytes);
      return `${read.text}; sha256 ${sha256(bytes)}; saved ${out}`;
    },
  },
  {
    id: "cleanup",
    label: "Close the MCP client",
    narrate: "Client closed.",
    async run() {
      await mcp?.close();
      return "closed";
    },
  },
];
