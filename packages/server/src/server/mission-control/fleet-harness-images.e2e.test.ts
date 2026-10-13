import path from "node:path";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { hashDaemonPassword } from "../auth.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  createFleetHarness,
  fleetExec,
  spawnWorker,
  waitFor,
} from "../test-utils/fleet-harness.js";

const ContentSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));
const UploadedFileBlockSchema = z.object({
  type: z.literal("uploaded_file"),
  fileName: z.string(),
  path: z.string(),
});

function field(result: { structuredContent?: unknown }, key: string): string {
  return z.object({ [key]: z.string() }).parse(result.structuredContent)[key];
}

function fakePng(bytes: number): Buffer {
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(bytes - 8)]);
}

interface CapturedPrompt {
  agentId: string | undefined;
  prompt: AgentPromptInput;
}

function waitForPrompt(prompts: CapturedPrompt[], marker: string): Promise<CapturedPrompt> {
  return waitFor(
    async () => prompts.find((entry) => JSON.stringify(entry.prompt).includes(marker)) ?? null,
    () => true,
    { label: `a prompt containing "${marker}"` },
  );
}

describe("images and files cross hosts over /mcp/fleet", () => {
  test(
    "an MCP client and the Commander deliver uploaded images and files to an agent on a peer",
    { timeout: 240_000 },
    async () => {
      const prompts: CapturedPrompt[] = [];
      const harness = await createFleetHarness({
        agentClients: createTestAgentClients({
          onStartTurn: (prompt, agentId) => {
            prompts.push({ agentId, prompt });
          },
        }),
      });
      const mcp = new Client({ name: "e2e-cross-host-images", version: "1.0.0" });
      try {
        // Register an MCP client on A (the config is re-read per request).
        const token = "cross-host-images-token";
        const configPath = path.join(harness.daemons.A.paseoHome, "config.json");
        const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        await writeFile(
          configPath,
          JSON.stringify({
            ...config,
            daemon: {
              mcp: {
                enabled: true,
                remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
              },
            },
          }),
        );
        await mcp.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${harness.daemons.A.port}/mcp/fleet`),
            { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
          ),
        );
        const call = (name: string, args: Record<string, unknown>) =>
          mcp.callTool({ name, arguments: args });

        const workspace = await harness.clients.B.createWorkspace({
          source: { kind: "directory", path: harness.daemons.B.paseoHomeRoot },
          title: "B workspace",
        });
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          initialPrompt: "B worker",
          title: "B worker",
          workspaceId: workspace.workspace!.id,
        });
        await call("fleet_wait_agent", { agentId, timeoutSeconds: 30 });

        // Bytes enter A's store over MCP only.
        const shot = fakePng(150 * 1024);
        const uploadedShot = await call("fleet_upload_file", {
          fileName: "shot.png",
          mimeType: "image/png",
          data: shot.toString("base64"),
        });
        const shotId = field(uploadedShot, "fileId");
        const uploadedNotes = await call("fleet_upload_file", {
          fileName: "notes.txt",
          mimeType: "text/plain",
          data: Buffer.from("notes for B").toString("base64"),
        });
        const notesId = field(uploadedNotes, "fileId");

        // 1. MCP client → agent on B: native image + a file copied into B's store.
        const sent = await call("fleet_send_prompt", {
          agentId,
          prompt: "mcp send with files",
          mode: "queue",
          images: [{ fileId: shotId }],
          attachments: [{ type: "uploaded_file", id: notesId }],
        });
        expect(sent.isError, JSON.stringify(sent.content)).toBeFalsy();
        const mcpPrompt = (await waitForPrompt(prompts, "mcp send with files")).prompt;
        const mcpBlocks = Array.isArray(mcpPrompt) ? mcpPrompt : [];
        expect(mcpBlocks).toContainEqual({
          type: "image",
          data: shot.toString("base64"),
          mimeType: "image/png",
        });
        const notesBlock = UploadedFileBlockSchema.parse(
          mcpBlocks.find((block) => block.type === "uploaded_file"),
        );
        expect(notesBlock.path.startsWith(path.join(harness.daemons.B.paseoHome, "uploads"))).toBe(
          true,
        );
        await expect(readFile(notesBlock.path, "utf8")).resolves.toBe("notes for B");

        // 2. An image the agent on B saved comes back over MCP as image content.
        const bShot = fakePng(20 * 1024);
        const bShotPath = path.join(harness.daemons.B.paseoHomeRoot, "b-screenshot.png");
        await writeFile(bShotPath, bShot);
        const read = await call("fleet_read_image", { agentId, path: bShotPath });
        expect(read.isError, JSON.stringify(read.content)).toBeFalsy();
        expect(ContentSchema.parse(read.content)[0]).toEqual({
          type: "image",
          data: bShot.toString("base64"),
          mimeType: "image/png",
        });

        // 3. Commander (gated) send with an image: the proposal's message names a
        // copy on B, so approving delivers a file B's agent can open. Steer never
        // waits for B's previous run (queue would block the approval on it).
        const gated = await fleetExec(harness.clients.A, "fleet_send_prompt", {
          agentId,
          prompt: "gated send with image",
          mode: "steer",
          images: [{ fileId: shotId }],
        });
        const proposalId = z.string().parse(gated.proposalId);
        const approved = await harness.clients.A.missionControlProposalsRespond({
          proposalId,
          action: "approve",
        });
        expect(approved.ok).toBe(true);
        const gatedPrompt = JSON.stringify(
          (await waitForPrompt(prompts, "gated send with image")).prompt,
        );
        const gatedPath = /Path: ([^\\]+)\\n/.exec(gatedPrompt)?.[1];
        expect(gatedPath?.startsWith(path.join(harness.daemons.B.paseoHome, "uploads"))).toBe(true);
        await expect(readFile(gatedPath!)).resolves.toEqual(shot);
      } finally {
        await mcp.close().catch(() => undefined);
        await harness.close();
      }
    },
  );
});
