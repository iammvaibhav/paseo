import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  name: "fleet-inline-image-thumbnail",
  tier: "ui",
  hosts: 1,
  video: false,
  description:
    "An image sent to fleet_create_agent as an inline {name, mimeType, base64} attachment shows in the " +
    "agent's first user message as one real thumbnail (desktop and phone width), not a broken-image tile " +
    "above a separate file chip.",
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, "../../..");
const serverRequire = createRequire(path.join(WORKTREE, "packages/server/package.json"));
const importFromServer = (specifier) =>
  import(pathToFileURL(serverRequire.resolve(specifier)).href);

const UI_TIMEOUT_MS = 30_000;
const CLIENT_NAME = "inline-image-thumbnail";
const TOKEN = randomBytes(24).toString("hex");

/**
 * A noisy 320x320 RGBA PNG: noise does not compress, so its base64 (about 545 KB) is larger
 * than one timeline item may carry, like a real screenshot.
 */
function noisyPng(size = 320) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = randomBytes(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) row[1 + x * 4 + 3] = 255; // opaque
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const FILE_NAME = "sidebar-highlight.png";

const state = { agentId: null, workspaceId: null };

async function inspectUserMessage(page) {
  const message = page.getByTestId("user-message").first();
  await message.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await message.scrollIntoViewIfNeeded();
  // Thumbnails load through the host's file RPC after the row renders.
  await page
    .waitForFunction(
      () => {
        const row = document.querySelector('[data-testid="user-message"]');
        const img = row?.querySelector('[data-testid="user-message-uploaded-image"] img');
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  return message.evaluate((row, fileName) => {
    const uploaded = [...row.querySelectorAll('[data-testid="user-message-uploaded-image"] img')];
    return {
      loadedThumbnails: uploaded.filter((img) => img.complete && img.naturalWidth > 0).length,
      unavailableTiles: row.querySelectorAll('[data-testid="user-message-image-unavailable"]')
        .length,
      fileChips: [...row.querySelectorAll("*")].filter(
        (node) => node.children.length === 0 && node.textContent?.trim() === fileName,
      ).length,
    };
  }, FILE_NAME);
}

export const steps = [
  {
    id: "create",
    label: "fleet_create_agent with an inline base64 screenshot attachment",
    narrate: "A remote MCP client creates an agent and attaches a screenshot inline.",
    async run(ctx) {
      const host = ctx.host();
      const { hashSync } = (await importFromServer("bcryptjs")).default;
      const configPath = path.join(host.home, "config.json");
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
      config.daemon = config.daemon ?? {};
      config.daemon.mcp = { ...config.daemon.mcp, enabled: true };
      config.daemon.mcp.remoteClients = [{ name: CLIENT_NAME, tokenHash: hashSync(TOKEN, 4) }];
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2));

      const { Client } = await importFromServer("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await importFromServer(
        "@modelcontextprotocol/sdk/client/streamableHttp.js",
      );
      const mcp = new Client({ name: CLIENT_NAME, version: "1.0.0" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${host.httpUrl}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      const cwd = path.join(host.home, "projects", "inline-image-thumbnail");
      await fsp.mkdir(cwd, { recursive: true });
      const base64 = noisyPng().toString("base64");
      const created = await mcp.callTool(
        {
          name: "fleet_create_agent",
          arguments: {
            host: "local",
            cwd,
            isolation: "local",
            provider: "mock/e2e-fast-stream",
            title: "inline image thumbnail",
            initialPrompt: "Look at the attached screenshot and reply OK.",
            attachments: [{ name: FILE_NAME, mimeType: "image/png", base64 }],
          },
        },
        undefined,
        { timeout: 120_000 },
      );
      const text = created.content?.map((block) => block.text ?? "").join(" ") ?? "";
      ctx.expect(!created.isError, `fleet_create_agent failed: ${text}`);
      state.agentId = created.structuredContent?.agentId;
      ctx.expect(Boolean(state.agentId), "created agent id");
      const agent = await host.client.fetchAgent(state.agentId);
      state.workspaceId = agent?.agent?.workspaceId ?? agent?.workspaceId ?? null;
      ctx.expect(Boolean(state.workspaceId), `agent workspace id: ${JSON.stringify(agent)}`);
      await mcp.close();
      return `agent ${state.agentId}; base64 ${base64.length} chars`;
    },
  },
  {
    id: "desktop",
    label: "Desktop: the first user message shows one loaded thumbnail and no file chip",
    narrate: "On desktop the screenshot renders as one thumbnail.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(
        `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(state.workspaceId)}?open=agent:${encodeURIComponent(state.agentId)}`,
      );
      const seen = await inspectUserMessage(page);
      await ctx.shot("desktop");
      ctx.expect(seen.unavailableTiles === 0, `broken image tiles: ${JSON.stringify(seen)}`);
      ctx.expect(seen.loadedThumbnails === 1, `loaded thumbnails: ${JSON.stringify(seen)}`);
      ctx.expect(seen.fileChips === 0, `separate file chip: ${JSON.stringify(seen)}`);
      return JSON.stringify(seen);
    },
  },
  {
    id: "phone",
    label: "Phone width: the same message shows the thumbnail",
    narrate: "At phone width the screenshot renders as one thumbnail too.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      const seen = await inspectUserMessage(page);
      await ctx.shot("phone");
      ctx.expect(seen.unavailableTiles === 0, `broken image tiles: ${JSON.stringify(seen)}`);
      ctx.expect(seen.loadedThumbnails === 1, `loaded thumbnails: ${JSON.stringify(seen)}`);
      ctx.expect(seen.fileChips === 0, `separate file chip: ${JSON.stringify(seen)}`);
      return JSON.stringify(seen);
    },
  },
];
