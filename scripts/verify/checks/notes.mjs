const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
const MISSION_CONTROL_LABEL_VALUE = "commander";

export const meta = {
  name: "notes",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "Native notes: features flag on Commander host only, non-host error naming on peer, RPC CRUD (list/get/upsert/delete) with notes.changed push, and Commander MCP note_* tools.",
};

const COMMANDER = "commander";
const PEER = "peer-b";
const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  predicate,
  { timeoutMs = 15000, intervalMs = 150, description = "condition" } = {},
) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

async function callAgentTool(ctx, agentId, name, args) {
  const url = new URL("/mcp/agents", ctx.host(COMMANDER).httpUrl);
  url.searchParams.set("callerAgentId", agentId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(ctx.password ? { authorization: `Bearer ${ctx.password}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  ctx.expect(response.ok, `MCP ${name} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  const dataLine = text.split("\n").findLast((line) => line.startsWith("data:"));
  const message = JSON.parse(dataLine ? dataLine.slice("data:".length) : text);
  ctx.expect(!message.error, `MCP ${name} error: ${JSON.stringify(message.error)}`);
  ctx.expect(
    message.result?.isError !== true,
    `MCP ${name} tool error: ${JSON.stringify(message.result)}`,
  );
  return message.result?.structuredContent ?? {};
}

export const steps = [
  {
    id: "features-flag",
    label: "Commander host advertises features.notes, peer host does not",
    narrate: "Verify the notes capability flag is advertised only on the notes host.",
    async run(ctx) {
      const commanderClient = ctx.host(COMMANDER).client;
      const peerClient = ctx.host(PEER).client;

      const commanderFeatures = commanderClient.getLastServerInfoMessage()?.features ?? {};
      const peerFeatures = peerClient.getLastServerInfoMessage()?.features ?? {};

      ctx.expect(
        commanderFeatures.notes === true,
        `Commander host must advertise features.notes: true, got ${commanderFeatures.notes}`,
      );
      ctx.expect(
        peerFeatures.notes !== true,
        `Peer host must not advertise features.notes: true, got ${peerFeatures.notes}`,
      );

      return "features.notes is true on Commander, false on peer";
    },
  },
  {
    id: "peer-non-host-error",
    label: "Peer host rejects notes.* RPC with Commander host naming error",
    narrate: "Non-notes host must answer with error naming the Commander host.",
    async run(ctx) {
      const peerClient = ctx.host(PEER).client;
      const res = await peerClient.notesRequest("notes.list.request", {});
      ctx.expect(
        res.error === "Notes live on the Commander host (commander)",
        `Expected non-host error naming commander, got: ${res.error}`,
      );
      return `Peer returned expected error: "${res.error}"`;
    },
  },
  {
    id: "rpc-crud-and-push",
    label: "RPC CRUD operations (list, get, upsert, delete) with notes.changed push",
    narrate: "Perform full CRUD lifecycle and verify notes.changed push notifications.",
    async run(ctx) {
      const client = ctx.host(COMMANDER).client;
      const pushes = [];
      const subscription = client.observeEvents(["notes.changed"]);
      subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "notes.changed") {
            pushes.push(message);
          }
        },
      });

      try {
        // 1. Create note
        const createRes = await client.notesRequest("notes.upsert.request", {
          title: "Verification Note",
          body: "# Verification\nTesting native notes stack.",
          tags: ["Verify", "stack"],
        });
        ctx.expect(createRes.error === null, `Create note failed: ${createRes.error}`);
        const note = createRes.note;
        ctx.expect(Boolean(note), "Created note must be returned");
        ctx.expect(
          note.slug === "verification-note",
          `Expected slug 'verification-note', got ${note.slug}`,
        );
        ctx.expect(
          note.title === "Verification Note",
          `Expected title 'Verification Note', got ${note.title}`,
        );
        ctx.expect(
          note.tags.includes("verify") && note.tags.includes("stack"),
          "Tags must be normalized",
        );

        // Verify push received for create
        const createPush = await pollUntil(() => pushes.find((p) => p.noteIds?.includes(note.id)), {
          timeoutMs: 5000,
          description: `notes.changed naming ${note.id} on create`,
        });
        ctx.expect(createPush.revision > 0, "Push revision must be > 0");

        // 2. List notes
        const listRes = await client.notesRequest("notes.list.request", {
          query: "Verification",
        });
        ctx.expect(listRes.error === null, `List notes failed: ${listRes.error}`);
        const found = listRes.notes.find((n) => n.id === note.id);
        ctx.expect(Boolean(found), "Created note must be in list response");
        ctx.expect(found.slug === "verification-note", "Found note slug matches");

        // 3. Get note by slug
        const getRes = await client.notesRequest("notes.get.request", {
          slug: "verification-note",
        });
        ctx.expect(getRes.error === null, `Get note failed: ${getRes.error}`);
        ctx.expect(getRes.note?.id === note.id, "Get note returned correct note");
        ctx.expect(
          getRes.note?.body === "# Verification\nTesting native notes stack.",
          "Body matches",
        );

        // 4. Update note
        const currentPushesCount = pushes.length;
        const updateRes = await client.notesRequest("notes.upsert.request", {
          noteId: note.id,
          body: "# Verification\nUpdated body content.",
        });
        ctx.expect(updateRes.error === null, `Update note failed: ${updateRes.error}`);
        ctx.expect(
          updateRes.note?.body === "# Verification\nUpdated body content.",
          "Updated body matches",
        );

        // Verify push received for update
        const updatePush = await pollUntil(
          () => pushes.slice(currentPushesCount).find((p) => p.noteIds?.includes(note.id)),
          { timeoutMs: 5000, description: `notes.changed naming ${note.id} on update` },
        );
        ctx.expect(updatePush.revision > createPush.revision, "Push revision must increase");

        // 5. Delete note
        const preDeletePushesCount = pushes.length;
        const deleteRes = await client.notesRequest("notes.delete.request", {
          noteId: note.id,
        });
        ctx.expect(deleteRes.error === null, `Delete note failed: ${deleteRes.error}`);

        // Verify push received for delete
        await pollUntil(
          () => pushes.slice(preDeletePushesCount).find((p) => p.noteIds?.includes(note.id)),
          { timeoutMs: 5000, description: `notes.changed naming ${note.id} on delete` },
        );

        // 6. Verify get after delete returns null note
        const getDeletedRes = await client.notesRequest("notes.get.request", {
          noteId: note.id,
        });
        ctx.expect(getDeletedRes.error === null, `Get deleted note error: ${getDeletedRes.error}`);
        ctx.expect(getDeletedRes.note === null, "Deleted note must return null");

        return `CRUD passed: created ${note.id}, listed, retrieved, updated, deleted; ${pushes.length} push events verified`;
      } finally {
        await subscription.release().catch(() => {});
      }
    },
  },
  {
    id: "mcp-tools",
    label: "Commander MCP note_* tools (note_write, note_list, note_read)",
    narrate: "Agent with Commander identity invokes note tools via loopback MCP endpoint.",
    async run(ctx) {
      const client = ctx.host(COMMANDER).client;

      // Create a mock agent with Commander labels
      const agent = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FAST_MODEL,
        cwd: ctx.fixtureRepo,
        title: `Notes MCP Agent [${ctx.stack.runId}]`,
        labels: {
          [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
        },
        initialPrompt: "Notes MCP verification agent",
      });
      ctx.expect(Boolean(agent?.id), `Agent created: ${JSON.stringify(agent)}`);
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);

      // 1. note_write
      const writeResult = await callAgentTool(ctx, agent.id, "note_write", {
        title: "MCP Created Note",
        body: "Note written via MCP note_write tool.",
        tags: ["mcp", "tool"],
      });
      ctx.expect(writeResult.ok === true, `note_write failed: ${JSON.stringify(writeResult)}`);
      ctx.expect(writeResult.created === true, "note_write created should be true");
      ctx.expect(writeResult.slug === "mcp-created-note", `Slug is ${writeResult.slug}`);

      // 2. note_list
      const listResult = await callAgentTool(ctx, agent.id, "note_list", {
        query: "MCP Created",
      });
      ctx.expect(listResult.ok === true, `note_list failed: ${JSON.stringify(listResult)}`);
      ctx.expect(listResult.total >= 1, `note_list total should be >= 1, got ${listResult.total}`);
      const foundToolNote = listResult.notes?.find((n) => n.slug === "mcp-created-note");
      ctx.expect(Boolean(foundToolNote), "Tool-written note must be found in note_list");

      // 3. note_read
      const readResult = await callAgentTool(ctx, agent.id, "note_read", {
        slug: "mcp-created-note",
      });
      ctx.expect(readResult.ok === true, `note_read failed: ${JSON.stringify(readResult)}`);
      ctx.expect(
        readResult.note?.body === "Note written via MCP note_write tool.",
        `note_read body matches: ${readResult.note?.body}`,
      );
      ctx.expect(
        readResult.note?.tags?.includes("mcp") && readResult.note?.tags?.includes("tool"),
        "note_read tags match",
      );

      return `MCP tools verified: wrote note "${writeResult.slug}", listed (${listResult.total} found), read note body`;
    },
  },
];
