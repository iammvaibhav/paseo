import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { z } from "zod";

import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon } from "../bootstrap.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

async function getAvailablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("Failed to acquire port")));
      return;
    }
    server.close(() => resolve(address.port));
  });
  return promise;
}

/** A PNG-signed blob bigger than express's old 100kb JSON default once base64-encoded. */
function fakePng(bytes: number): Buffer {
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(bytes - 8)]);
}

const ContentSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));

function textOf(result: { content: unknown }): string {
  return ContentSchema.parse(result.content)
    .map((block) => block.text ?? "")
    .join("\n");
}

/** Reads one string field from a tool's structuredContent. */
function field(result: { structuredContent?: unknown }, key: string): string {
  return z.object({ [key]: z.string() }).parse(result.structuredContent)[key];
}

describe("Fleet MCP images (/mcp/fleet)", () => {
  test("a remote client uploads, sends and reads back images without touching the host filesystem", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-img-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-img-"));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "paseo-work-fleet-img-"));
    const port = await getAvailablePort();
    const token = "grok-secret-token-images";
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
          },
        },
      }),
      "utf8",
    );
    const prompts: string[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients({
          onStartTurn: (prompt: AgentPromptInput) => {
            prompts.push(JSON.stringify(prompt));
          },
        }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const url = `http://127.0.0.1:${port}/mcp/fleet`;
    const client = new Client({ name: "e2e-images", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });

      // 1. An inline 300 KB screenshot at creation: the request used to die with 413.
      const createImage = fakePng(300 * 1024).toString("base64");
      const created = await call("fleet_create_agent", {
        host: "local",
        cwd: workDir,
        isolation: "local",
        provider: "codex/gpt-5.4-mini",
        title: "image worker",
        initialPrompt: "Respond with exactly: first",
        images: [{ data: createImage, mimeType: "image/png" }],
      });
      expect(created.isError, textOf(created)).toBeFalsy();
      const agentId = field(created, "agentId");
      await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });
      expect(prompts.some((prompt) => prompt.includes(createImage))).toBe(true);

      // 2. Chunked upload: two calls, the second completes the file.
      const shot = fakePng(200 * 1024);
      const half = 100 * 1024;
      const first = await call("fleet_upload_file", {
        fileName: "shot.png",
        mimeType: "image/png",
        size: shot.byteLength,
        data: shot.subarray(0, half).toString("base64"),
      });
      expect(first.structuredContent).toMatchObject({ complete: false, receivedBytes: half });
      const uploadId = field(first, "uploadId");
      const second = await call("fleet_upload_file", {
        uploadId,
        data: shot.subarray(half).toString("base64"),
      });
      expect(second.structuredContent).toMatchObject({
        complete: true,
        receivedBytes: shot.byteLength,
        mimeType: "image/png",
      });
      const fileId = field(second, "fileId");

      // 3. The uploaded image reaches an existing (already created) agent.
      const sent = await call("fleet_send_prompt", {
        agentId,
        prompt: "Respond with exactly: second",
        images: [{ fileId }],
      });
      expect(sent.isError, textOf(sent)).toBeFalsy();
      expect(sent.structuredContent).toMatchObject({ success: true });
      await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });
      expect(prompts.some((prompt) => prompt.includes(shot.toString("base64")))).toBe(true);

      // 4. A non-image upload goes as an uploaded_file attachment named by id.
      const notes = await call("fleet_upload_file", {
        fileName: "notes.txt",
        mimeType: "text/plain",
        data: Buffer.from("upload notes").toString("base64"),
      });
      const notesId = field(notes, "fileId");
      const attached = await call("fleet_send_prompt", {
        agentId,
        prompt: "Respond with exactly: third",
        attachments: [{ type: "uploaded_file", id: notesId }],
      });
      expect(attached.isError, textOf(attached)).toBeFalsy();
      await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });
      // The agent gets the uploaded_file block pointing into this host's store.
      const storedNotesPath = path.join(paseoHome, "uploads", notesId, "notes.txt");
      expect(
        prompts.some(
          (prompt) =>
            prompt.includes('"type":"uploaded_file"') &&
            prompt.includes(`"path":"${storedNotesPath}"`),
        ),
      ).toBe(true);

      // 5. Files that are not on this host fail the send instead of succeeding silently.
      const missingPath = await call("fleet_send_prompt", {
        agentId,
        prompt: "never delivered",
        attachments: [
          {
            type: "uploaded_file",
            id: "upload_elsewhere",
            fileName: "gone.png",
            mimeType: "image/png",
            size: 3,
            path: path.join(workDir, "gone.png"),
          },
        ],
      });
      expect(missingPath.isError).toBe(true);
      expect(textOf(missingPath)).toMatch(/does not exist on this host/);
      const unknownId = await call("fleet_send_prompt", {
        agentId,
        prompt: "never delivered",
        images: [{ fileId: "upload_00000000-0000-4000-8000-000000000000" }],
      });
      expect(unknownId.isError).toBe(true);
      expect(textOf(unknownId)).toMatch(/not in this host's upload store/);
      expect(prompts.some((prompt) => prompt.includes("never delivered"))).toBe(false);

      // 6. An image the agent wrote comes back as MCP image content.
      const agentShot = fakePng(50 * 1024);
      const agentShotPath = path.join(workDir, "agent-screenshot.png");
      await writeFile(agentShotPath, agentShot);
      for (const args of [{ path: agentShotPath }, { path: agentShotPath, agentId }]) {
        const read = await call("fleet_read_image", args);
        expect(read.isError, textOf(read)).toBeFalsy();
        expect(ContentSchema.parse(read.content)[0]).toEqual({
          type: "image",
          data: agentShot.toString("base64"),
          mimeType: "image/png",
        });
      }
      const notesPath = path.join(workDir, "notes.txt");
      await writeFile(notesPath, "not an image");
      const notImage = await call("fleet_read_image", { path: notesPath });
      expect(notImage.isError).toBe(true);
      expect(textOf(notImage)).toMatch(/not an image/);

      // 7. Above the /mcp body cap the client gets a JSON-RPC error, not an HTML 413 page.
      const oversized = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "fleet_upload_file", arguments: { data: "A".repeat(26 * 1024 * 1024) } },
        }),
      });
      expect(oversized.status).toBe(413);
      const oversizedBody = z
        .object({ error: z.object({ message: z.string() }) })
        .parse(await oversized.json());
      expect(oversizedBody.error.message).toMatch(/exceeds the 25 MB \/mcp request limit/);
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 120_000);

  test("inline attachments arrive as uploaded files and file content in prompt text is rejected", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-fleet-att-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-fleet-att-"));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "paseo-work-fleet-att-"));
    const port = await getAvailablePort();
    const token = "grok-secret-token-attachments";
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
          },
        },
      }),
      "utf8",
    );
    const prompts: AgentPromptInput[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients({
          onStartTurn: (prompt: AgentPromptInput) => {
            prompts.push(prompt);
          },
        }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const url = `http://127.0.0.1:${port}/mcp/fleet`;
    const client = new Client({ name: "e2e-attachments", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });
      const blocksOf = (prompt: AgentPromptInput | undefined) =>
        Array.isArray(prompt) ? prompt : [{ type: "text" as const, text: prompt ?? "" }];
      const textOfPrompt = (prompt: AgentPromptInput | undefined) =>
        blocksOf(prompt)
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");

      // 1. Create with one inline image and one inline markdown file.
      const png = fakePng(4 * 1024);
      const markdown = "# Design\n\nUNIQUE-DOC-BODY-7731\n";
      const created = await call("fleet_create_agent", {
        host: "local",
        cwd: workDir,
        isolation: "local",
        provider: "codex/gpt-5.4-mini",
        title: "attachment worker",
        initialPrompt: "Review the attached design.md",
        attachments: [
          { name: "diagram.png", mimeType: "image/png", base64: png.toString("base64") },
          {
            name: "design.md",
            mimeType: "text/markdown",
            base64: Buffer.from(markdown).toString("base64"),
          },
        ],
      });
      expect(created.isError, textOf(created)).toBeFalsy();
      const agentId = field(created, "agentId");
      await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });
      const first = blocksOf(prompts[0]);
      const files = first.filter((block) => block.type === "uploaded_file");
      expect(files.map((block) => block.type === "uploaded_file" && block.fileName)).toEqual([
        "diagram.png",
        "design.md",
      ]);
      for (const file of files) {
        if (file.type !== "uploaded_file") continue;
        expect(file.path.startsWith(path.join(paseoHome, "uploads"))).toBe(true);
        const expected = file.fileName === "design.md" ? Buffer.from(markdown) : png;
        expect(await readFile(file.path)).toEqual(expected);
      }
      // The image also rides as a native image; neither file's bytes are in the prompt text.
      expect(first).toContainEqual({
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      });
      expect(textOfPrompt(prompts[0])).not.toContain("UNIQUE-DOC-BODY-7731");
      expect(textOfPrompt(prompts[0])).not.toContain(png.toString("base64"));

      // 2. A text upload and a {fileId} attachment on send.
      const log = await call("fleet_upload_file", {
        fileName: "build.log",
        mimeType: "text/plain",
        text: "line one\nline two\n",
      });
      expect(log.isError, textOf(log)).toBeFalsy();
      const sent = await call("fleet_send_prompt", {
        agentId,
        prompt: "Read the attached log",
        attachments: [{ fileId: field(log, "fileId") }],
      });
      expect(sent.isError, textOf(sent)).toBeFalsy();
      await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });
      const sentFile = blocksOf(prompts.at(-1)).find((block) => block.type === "uploaded_file");
      expect(sentFile?.type === "uploaded_file" && sentFile.fileName).toBe("build.log");
      if (sentFile?.type === "uploaded_file") {
        expect(await readFile(sentFile.path, "utf8")).toBe("line one\nline two\n");
      }

      // 3. A data: URI or an oversized prompt is rejected before anything is created or sent.
      const deliveredBefore = prompts.length;
      const dataUri = `see ![][image1]\n\n[image1]: <data:image/png;base64,${png.toString("base64")}>`;
      const rejectedCreate = await call("fleet_create_agent", {
        host: "local",
        cwd: workDir,
        isolation: "local",
        provider: "codex/gpt-5.4-mini",
        title: "never created",
        initialPrompt: dataUri,
      });
      expect(rejectedCreate.isError).toBe(true);
      expect(textOf(rejectedCreate)).toMatch(
        /initialPrompt contains a base64 data: URI \(image\/png\).*attachments: \[\{name, mimeType, base64\}\].*fleet_upload_file/,
      );
      const rejectedSend = await call("fleet_send_prompt", { agentId, prompt: dataUri });
      expect(rejectedSend.isError).toBe(true);
      expect(textOf(rejectedSend)).toMatch(/prompt contains a base64 data: URI/);
      const oversized = await call("fleet_send_prompt", { agentId, prompt: "x".repeat(70_000) });
      expect(oversized.isError).toBe(true);
      expect(textOf(oversized)).toMatch(/prompt is 70000 characters; the limit is 65536/);
      expect(prompts.length).toBe(deliveredBefore);
      const roster = await call("fleet_list_agents", { query: "never created" });
      expect(JSON.stringify(roster.structuredContent)).not.toContain("never created");
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
