import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "prompt-image-forward",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "An image attached to an omp agent's prompt the way the app composer sends it (inline base64 on " +
    "send_agent_message) reaches the agent as a native image plus an uploaded_file path; the agent " +
    "forwards it to a second omp agent with fleet_send_prompt attachments, and the second agent reads it.",
};

const MARKER = `KITE-${randomBytes(2).toString("hex").toUpperCase()}`;

/** A PNG showing MARKER in large black text, drawn with Pillow through uv. */
function markerPng() {
  const script = [
    "import io, sys",
    "from PIL import Image, ImageDraw, ImageFont",
    "img = Image.new('RGB', (640, 200), 'white')",
    "ImageDraw.Draw(img).text((30, 60), sys.argv[1], fill='black', font=ImageFont.load_default(size=72))",
    "buf = io.BytesIO(); img.save(buf, 'PNG'); sys.stdout.buffer.write(buf.getvalue())",
  ].join("\n");
  return execFileSync(
    "uv",
    ["run", "--quiet", "--with", "pillow", "python", "-c", script, MARKER],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function pollUntil(fetchValue, { timeoutMs = 240_000, intervalMs = 500, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function userMessages(client, agentId) {
  const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 200 });
  return timeline.entries.map((entry) => entry.item).filter((item) => item.type === "user_message");
}

const state = {
  png: null,
  cwd: null,
  workspaceId: null,
  model: null,
  sender: null,
  receiver: null,
};

export const steps = [
  {
    id: "setup",
    label: "Create a sender and a receiver omp agent",
    narrate: "Two real omp agents in one workspace; the receiver answers READY first.",
    async run(ctx) {
      const client = ctx.host().client;
      state.png = markerPng();
      state.cwd = path.join(ctx.host().home, "projects", "prompt-image-forward");
      await fsp.mkdir(state.cwd, { recursive: true });
      state.workspaceId = (
        await client.createWorkspace({ source: { kind: "directory", path: state.cwd } })
      ).workspace?.id;
      ctx.expect(Boolean(state.workspaceId), "workspace created");
      state.model = (ctx.stack.commanderModel ?? "").replace(/^omp\//, "");
      ctx.expect(Boolean(state.model), "stack resolved an omp model");
      const common = {
        provider: "omp",
        model: state.model,
        cwd: state.cwd,
        workspaceId: state.workspaceId,
      };
      state.receiver = (
        await client.createAgent({
          ...common,
          title: "image receiver",
          initialPrompt: "Reply with exactly: READY. Do not use tools.",
        })
      ).id;
      state.sender = (await client.createAgent({ ...common, title: "image sender" })).id;
      const ready = await client.waitForFinish(state.receiver, 240_000);
      ctx.expect(ready.status === "idle", `receiver idle (got ${ready.status})`);
      return `sender ${state.sender}, receiver ${state.receiver}, model ${state.model}, marker ${MARKER}, png ${state.png.byteLength} bytes`;
    },
  },
  {
    id: "attach",
    label: "Composer-style send: inline image becomes a stored uploaded_file with a path",
    narrate: "The image is saved to the upload store and the prompt carries its path and fileId.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.sendAgentMessage(
        state.sender,
        `I attached an image. Forward that exact image to agent ${state.receiver} with your own Paseo ` +
          "host tool fleet_send_prompt (not through ToolHive: ToolHive talks to a different daemon that " +
          "does not know this agent), as a real attachment, not a description and not base64 in the " +
          "prompt text. Use the prompt: What text is in the attached image? Reply with only that text. " +
          "Do not use tools. Then reply to me with only the local file path of the image I attached.",
        { images: [{ data: state.png.toString("base64"), mimeType: "image/png" }] },
      );
      const [row] = await pollUntil(
        async () => {
          const rows = (await userMessages(client, state.sender)).filter((item) =>
            item.text.includes("I attached an image"),
          );
          return rows.length > 0 ? rows : null;
        },
        { description: "the sender's user row" },
      );
      const upload = (row.attachments ?? []).find((item) => item.type === "uploaded_file");
      ctx.expect(Boolean(upload), `user row carries an uploaded_file: ${JSON.stringify(row)}`);
      ctx.expect(
        upload.path.startsWith(path.join(ctx.host().home, "uploads")),
        `stored in the host's upload store: ${upload.path}`,
      );
      const bytes = await fsp.readFile(upload.path);
      ctx.expect(bytes.equals(state.png), "stored bytes equal the attached image");
      state.upload = upload;
      return `${upload.id} at ${upload.path} (${upload.size} bytes)`;
    },
  },
  {
    id: "sender-forwards",
    label: "The sender sees the path and forwards the image with fleet_send_prompt",
    narrate:
      "The sender's reply names the path, and it called fleet_send_prompt with an attachment.",
    async run(ctx) {
      const client = ctx.host().client;
      const finished = await client.waitForFinish(state.sender, 300_000);
      ctx.expect(finished.status === "idle", `sender idle (got ${finished.status})`);
      const reply = finished.lastMessage ?? "";
      ctx.expect(reply.includes(state.upload.path), `reply names the path: ${reply}`);
      const timeline = await client.fetchAgentTimeline(state.sender, { limit: 200 });
      const sends = timeline.entries
        .map((entry) => entry.item)
        .filter((item) => item.type === "tool_call" && /(^|_)fleet_send_prompt$/.test(item.name));
      ctx.expect(sends.length > 0, "sender called its fleet_send_prompt host tool");
      const call = sends.at(-1);
      const shown = JSON.stringify(call).slice(0, 800);
      ctx.expect(call.status === "completed", `fleet_send_prompt succeeded: ${shown}`);
      ctx.expect(shown.includes("attachments"), `fleet_send_prompt carried attachments: ${shown}`);
      return `reply: ${reply.trim()}; call: ${shown}`;
    },
  },
  {
    id: "receiver-reads",
    label: "The receiver gets the image as an attachment and reads its text",
    narrate: "The second agent's prompt carries the image file, and it reads the marker text.",
    async run(ctx) {
      const client = ctx.host().client;
      const row = await pollUntil(
        async () =>
          (await userMessages(client, state.receiver)).find((item) =>
            (item.attachments ?? []).some(
              (attachment) =>
                attachment.type === "uploaded_file" && attachment.mimeType === "image/png",
            ),
          ) ?? null,
        { description: "the receiver's image prompt" },
      );
      const upload = row.attachments.find((attachment) => attachment.type === "uploaded_file");
      ctx.expect(
        (await fsp.readFile(upload.path)).equals(state.png),
        `receiver's attachment is the same image: ${upload.path}`,
      );
      const reply = await pollUntil(
        async () => {
          const agent = (await client.fetchAgent(state.receiver))?.agent;
          if (agent?.status === "running") return null;
          const timeline = await client.fetchAgentTimeline(state.receiver, {
            direction: "tail",
            limit: 50,
          });
          const items = timeline.entries.map((entry) => entry.item);
          const lastUser = items.findLastIndex((item) => item.type === "user_message");
          const answer = items
            .slice(lastUser + 1)
            .filter((item) => item.type === "assistant_message")
            .map((item) => item.text)
            .join("");
          return answer.trim() ? answer : null;
        },
        { description: "the receiver's answer" },
      );
      ctx.expect(reply.toUpperCase().includes(MARKER), `receiver read ${MARKER}: ${reply}`);
      return `receiver prompt "${row.text}" with ${upload.fileName}; reply: ${reply.trim()}`;
    },
  },
];
