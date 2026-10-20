import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { PersistedProjectRecord } from "../workspace-registry.js";
import {
  attachItsaplanProjectSync,
  deriveItsaplanProjectKey,
  ensureItsaplanProjectMapping,
  ensureTodoColumnNoCommanderAutoAssign,
  isEligibleForItsaplanBoard,
  ItsaplanProjectStore,
  resolveItsaplanConfig,
  runItsaplanProjectResync,
  type ItsaplanCentralConfig,
  type ItsaplanProjectSyncDependencies,
} from "./projects.js";
import { ItsaplanClient } from "./client.js";

function startFakeItsaplanServer(apiKey: string) {
  const createdProjects: Array<{ key: string; name: string; description: string }> = [];
  const registeredWebhooks: Array<{
    projectKey: string;
    url: string;
    events: string[];
    secret: string;
  }> = [];
  // Persistent webhook rows keyed by id so GET/PATCH routes can serve and
  // mutate them (event-set drift repair).
  const webhooksById = new Map<
    number,
    { id: number; projectId: number; url: string; events: string[]; isActive: boolean }
  >();
  let nextWebhookId = 1;
  let nextProjectId = 1;
  const projectIdByKey = new Map<string, number>();
  // Mirrors real itsaplan: descriptions default to '' when not supplied.
  const descriptionByKey = new Map<string, string>();
  const columnsByProjectKey = new Map<
    string,
    Array<{
      id: number;
      projectId: number;
      name: string;
      stateType: string;
      autoAssignUserId?: string | null;
    }>
  >();
  const createdAiAgents: Array<{
    projectKey: string;
    name: string;
    username: string;
    kind: string;
    triggerOnMention?: boolean;
  }> = [];
  const agentsByProjectKey: Record<
    string,
    Array<{ id: number; username: string; userId: string; apiKey: string }>
  > = {};
  let nextAgentId = 1;
  const aiAgents = { enabled: false };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers["x-api-key"] !== apiKey) {
        send(401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const handleProjects = (): boolean => {
        if (req.method === "GET" && url.pathname === "/projects") {
          send(
            200,
            [...projectIdByKey].map(([key, id]) => ({
              id,
              key,
              name: `name-${id}`,
              description: descriptionByKey.get(key) ?? "",
            })),
          );
          return true;
        }
        if (req.method === "POST" && url.pathname === "/projects") {
          const key = String(body.key);
          if (projectIdByKey.has(key)) {
            send(409, { error: "duplicate key" });
            return true;
          }
          const created = {
            id: nextProjectId++,
            key,
            name: String(body.name),
            description: typeof body.description === "string" ? body.description : "",
          };
          projectIdByKey.set(key, created.id);
          descriptionByKey.set(key, created.description);
          createdProjects.push({
            key: created.key,
            name: created.name,
            description: created.description,
          });
          send(201, created);
          return true;
        }
        const projectMatch = /^\/projects\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && projectMatch) {
          const projectKey = decodeURIComponent(projectMatch[1]);
          const id = projectIdByKey.get(projectKey);
          if (!id) {
            send(404, { error: "Project not found" });
            return true;
          }
          send(200, {
            project: {
              id,
              key: projectKey,
              name: `name-${id}`,
              description: descriptionByKey.get(projectKey) ?? "",
            },
            columns: columnsByProjectKey.get(projectKey) ?? [],
            labels: [],
          });
          return true;
        }
        return false;
      };

      const handleWebhooks = (): boolean => {
        const webhooksMatch = /^\/projects\/([^/]+)\/webhooks$/.exec(url.pathname);
        if (req.method === "POST" && webhooksMatch) {
          const projectKey = decodeURIComponent(webhooksMatch[1]);
          const webhook = {
            projectKey,
            url: String(body.url),
            events: body.events as string[],
            clientSentSecret: "secret" in body,
          };
          registeredWebhooks.push(webhook);
          const id = nextWebhookId++;
          webhooksById.set(id, {
            id,
            projectId: projectIdByKey.get(projectKey) ?? 0,
            url: webhook.url,
            events: [...webhook.events],
            isActive: true,
          });
          send(201, {
            id,
            projectId: 1,
            url: webhook.url,
            events: webhook.events,
            isActive: true,
            secret: `whsec_generated_${id}`,
          });
          return true;
        }
        if (req.method === "GET" && webhooksMatch) {
          const projectKey = decodeURIComponent(webhooksMatch[1]);
          const projectId = projectIdByKey.get(projectKey);
          send(
            200,
            Array.from(webhooksById.values()).filter((w) => w.projectId === projectId),
          );
          return true;
        }
        const webhookPatchMatch = /^\/webhooks\/(\d+)$/.exec(url.pathname);
        if (req.method === "PATCH" && webhookPatchMatch) {
          const webhook = webhooksById.get(Number(webhookPatchMatch[1]));
          if (!webhook) {
            send(404, { error: "not found" });
            return true;
          }
          Object.assign(webhook, body);
          send(200, webhook);
          return true;
        }
        return false;
      };

      const handleColumns = (): boolean => {
        const columnPatchMatch = /^\/projects\/([^/]+)\/columns\/(\d+)$/.exec(url.pathname);
        if (req.method === "PATCH" && columnPatchMatch) {
          const projectKey = decodeURIComponent(columnPatchMatch[1]);
          const colId = Number(columnPatchMatch[2]);
          const cols = columnsByProjectKey.get(projectKey) ?? [];
          const col = cols.find((c) => c.id === colId);
          if (!col) {
            send(404, { error: "Column not found" });
            return true;
          }
          Object.assign(col, body);
          send(200, col);
          return true;
        }
        return false;
      };
      const handleAiAgents = (): boolean => {
        if (!aiAgents.enabled) {
          return false;
        }
        const agentsMatch = /^\/projects\/([^/]+)\/ai-agents$/.exec(url.pathname);
        if (req.method === "POST" && agentsMatch) {
          const projectKey = decodeURIComponent(agentsMatch[1]);
          const username = String(body.username);
          const existing = agentsByProjectKey[projectKey] ?? [];
          if (existing.some((a) => a.username.toLowerCase() === username.toLowerCase())) {
            send(409, { error: "Username already taken" });
            return true;
          }
          const id = nextAgentId++;
          const agent = {
            id,
            username,
            userId: `user-${username}`,
            apiKey: `itp_agent_${username}_key`,
          };
          existing.push(agent);
          agentsByProjectKey[projectKey] = existing;
          createdAiAgents.push({
            projectKey,
            name: String(body.name),
            username,
            kind: String(body.kind),
            triggerOnMention: Boolean(body.triggerOnMention),
          });
          send(201, {
            agent: {
              id: agent.id,
              projectId: projectIdByKey.get(projectKey) ?? 1,
              userId: agent.userId,
              username: agent.username,
              kind: "external",
            },
            apiKey: agent.apiKey,
          });
          return true;
        }
        if (req.method === "GET" && agentsMatch) {
          const projectKey = decodeURIComponent(agentsMatch[1]);
          const list = agentsByProjectKey[projectKey] ?? [];
          send(
            200,
            list.map((a) => ({
              id: a.id,
              projectId: projectIdByKey.get(projectKey) ?? 1,
              userId: a.userId,
              username: a.username,
              kind: "external",
            })),
          );
          return true;
        }
        const regenMatch = /^\/projects\/([^/]+)\/ai-agents\/(\d+)\/regenerate-key$/.exec(
          url.pathname,
        );
        if (req.method === "POST" && regenMatch) {
          const projectKey = decodeURIComponent(regenMatch[1]);
          const agentId = Number(regenMatch[2]);
          const agent = (agentsByProjectKey[projectKey] ?? []).find((a) => a.id === agentId);
          if (!agent) {
            send(404, { error: "Agent not found" });
            return true;
          }
          agent.apiKey = `itp_agent_regen_${agentId}`;
          send(200, { apiKey: agent.apiKey });
          return true;
        }
        const patchMatch = /^\/projects\/([^/]+)\/ai-agents\/(\d+)$/.exec(url.pathname);
        if (req.method === "PATCH" && patchMatch) {
          const projectKey = decodeURIComponent(patchMatch[1]);
          const agentId = Number(patchMatch[2]);
          const agent = (agentsByProjectKey[projectKey] ?? []).find((a) => a.id === agentId);
          if (!agent) {
            send(404, { error: "Agent not found" });
            return true;
          }
          send(200, {
            id: agent.id,
            projectId: projectIdByKey.get(projectKey) ?? 1,
            userId: agent.userId,
            username: agent.username,
            kind: "external",
            triggerOnMention: body.triggerOnMention,
          });
          return true;
        }
        return false;
      };

      if (handleProjects() || handleWebhooks() || handleColumns() || handleAiAgents()) {
        return;
      }
      send(404, { error: `unhandled ${req.method} ${url.pathname}` });
    });
  });

  return {
    server,
    createdProjects,
    registeredWebhooks,
    webhooksById,
    projectIdByKey,
    descriptionByKey,
    columnsByProjectKey,
    createdAiAgents,
    agentsByProjectKey,
    aiAgents,
  };
}

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
      server.close(() => resolveClosed());
      return closed;
    },
  };
}

function project(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  return {
    projectId: overrides.projectId ?? "proj-1",
    rootPath: "/repo",
    kind: "git",
    displayName: "Repo",
    projectKey: "PROJ",
    customName: null,
    customIconRevision: null,
    description: null,
    baseWorkspaceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("itsaplan project sync", () => {
  let fakeServer: ReturnType<typeof startFakeItsaplanServer>;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let store: ItsaplanProjectStore;
  let paseoHome: string;
  let deps: ItsaplanProjectSyncDependencies;

  beforeEach(async () => {
    fakeServer = startFakeItsaplanServer("itp_test_key");
    handle = await listen(fakeServer.server);
    config = { baseUrl: handle.baseUrl, apiKey: "itp_test_key", webhookSecret: "whsec_test" };
    paseoHome = await mkdtemp(join(tmpdir(), "itsaplan-projects-test-"));
    store = new ItsaplanProjectStore({ paseoHome, logger: createTestLogger() });
    await store.initialize();
    deps = {
      store,
      getConfig: () => config,
      getWebhookUrl: () => "http://127.0.0.1:9999/api/itsaplan/webhook",
      paseoHome,
      logger: createTestLogger(),
    };
  });

  afterEach(async () => {
    await handle.close();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates the itsaplan project, registers its webhook, and writes the mapping", async () => {
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toEqual({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 1,
      // Derived from the display name ("Repo"), never the raw paseo key.
      itsaplanProjectKey: "REPO",
      createdAt: expect.any(String),
      // Read back from itsaplan's response — itsaplan ignores client secrets.
      webhookSecret: "whsec_generated_1",
      webhookId: 1,
      webhookEvents: ["issue.created", "issue.state_changed", "issue.assigned", "comment.created"],
    });
    // Name = friendly display name; description = full cross-host identity.
    expect(fakeServer.createdProjects).toEqual([
      { key: "REPO", name: "Repo", description: "PROJ" },
    ]);
    expect(fakeServer.registeredWebhooks).toEqual([
      {
        projectKey: "REPO",
        url: "http://127.0.0.1:9999/api/itsaplan/webhook",
        events: ["issue.created", "issue.state_changed", "issue.assigned", "comment.created"],
        clientSentSecret: false,
      },
    ]);
  });

  test("is idempotent: a second call makes no further itsaplan API calls", async () => {
    await ensureItsaplanProjectMapping(project(), deps);
    await ensureItsaplanProjectMapping(project(), deps);
    expect(fakeServer.createdProjects).toHaveLength(1);
    expect(fakeServer.registeredWebhooks).toHaveLength(1);
  });

  test("patches issue.created and comment.created onto an existing webhook registered before they existed", async () => {
    // A mapping written before webhookId/webhookEvents was persisted (old registration
    // carrying only the state_changed event): sync must find our webhook by URL,
    // PATCH the missing events, and backfill webhookId/webhookEvents onto the mapping.
    await store.upsert({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 1,
      itsaplanProjectKey: "PROJ",
      createdAt: new Date().toISOString(),
    });
    fakeServer.projectIdByKey.set("PROJ", 1);
    fakeServer.webhooksById.set(1, {
      id: 1,
      projectId: 1,
      url: deps.getWebhookUrl() ?? "",
      events: ["issue.state_changed"],
      isActive: true,
    });
    const updated = await ensureItsaplanProjectMapping(project(), deps);
    expect(fakeServer.webhooksById.get(1)?.events).toEqual([
      "issue.created",
      "issue.state_changed",
      "issue.assigned",
      "comment.created",
    ]);
    expect(updated?.webhookId).toBe(1);
    expect(updated?.webhookEvents).toEqual([
      "issue.created",
      "issue.state_changed",
      "issue.assigned",
      "comment.created",
    ]);
    expect(store.getByPaseoProjectKey("PROJ")?.webhookId).toBe(1);
  });

  test("patches existing webhook when webhookId is already present on mapping but issue.created is missing", async () => {
    await store.upsert({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 1,
      itsaplanProjectKey: "PROJ",
      createdAt: new Date().toISOString(),
      webhookId: 1,
    });
    fakeServer.projectIdByKey.set("PROJ", 1);
    fakeServer.webhooksById.set(1, {
      id: 1,
      projectId: 1,
      url: deps.getWebhookUrl() ?? "",
      events: ["issue.state_changed", "comment.created"],
      isActive: true,
    });
    const updated = await ensureItsaplanProjectMapping(project(), deps);
    expect(fakeServer.webhooksById.get(1)?.events).toEqual([
      "issue.created",
      "issue.state_changed",
      "issue.assigned",
      "comment.created",
    ]);
    expect(updated?.webhookId).toBe(1);
    expect(updated?.webhookEvents).toEqual([
      "issue.created",
      "issue.state_changed",
      "issue.assigned",
      "comment.created",
    ]);
  });

  test("never syncs a project rooted inside paseoHome (Commander reserved home)", async () => {
    const internal = project({
      projectId: "cmd",
      projectKey: "CMD",
      displayName: "commander",
      rootPath: join(paseoHome, "commander"),
    });
    expect(await ensureItsaplanProjectMapping(internal, deps)).toBeNull();
    expect(fakeServer.createdProjects).toHaveLength(0);
    expect(store.getByPaseoProjectKey("CMD")).toBeNull();
  });

  test("never syncs a project rooted in /tmp, verify-runs, or home directories", async () => {
    for (const rootPath of [
      "/tmp",
      "/tmp/notify-test-ws",
      "/private/tmp",
      "/data/.paseo/verify-runs/run-1/repo",
      "/data/.paseo/verify-proofs/proof-1",
      "/data/paseo/.dev/verify/v-123/repo",
      join(paseoHome, "verify-runs", "v-99"),
      "/home/ubuntu",
      "/Users/vaibhav",
    ]) {
      const dummy = project({
        projectId: "dummy",
        projectKey: `DUMMY_${rootPath.replace(/[^A-Za-z0-9]/g, "")}`,
        displayName: "dummy",
        rootPath,
      });
      expect(await ensureItsaplanProjectMapping(dummy, deps)).toBeNull();
      expect(fakeServer.createdProjects).toHaveLength(0);
    }
  });

  test("resync maps every unmapped, unarchived, keyed project exactly once", async () => {
    const projects = [
      project({ projectId: "a", projectKey: "AAA", displayName: "A" }),
      project({ projectId: "b", projectKey: "BBB", displayName: "B" }),
      project({ projectId: "c", projectKey: null, displayName: "No key" }),
      project({
        projectId: "d",
        projectKey: "DDD",
        displayName: "Archived",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];

    const result = await runItsaplanProjectResync(projects, deps);
    expect(result).toEqual({ mapped: 2, skipped: 1, failed: 0 });
    expect(fakeServer.createdProjects.map((p) => p.key).sort()).toEqual(["A", "B"]);
    expect(store.list()).toHaveLength(2);

    // Idempotent re-run: the same sweep creates nothing new.
    await runItsaplanProjectResync(projects, deps);
    expect(fakeServer.createdProjects).toHaveLength(2);
    expect(fakeServer.registeredWebhooks).toHaveLength(2);
  });

  test("a create-key 409 adopts our own crashed earlier attempt instead of failing", async () => {
    // Pre-existing row from an earlier sync that died between create and
    // mapping-write: recognizable as OURS because its description carries
    // this paseo project's full cross-host key.
    fakeServer.projectIdByKey.set("REPO", 7);
    fakeServer.descriptionByKey.set("REPO", "PROJ");
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 7,
      itsaplanProjectKey: "REPO",
    });
    expect(fakeServer.createdProjects).toHaveLength(0);
    expect(store.getByPaseoProjectKey("PROJ")?.itsaplanProjectId).toBe(7);
    // The crashed attempt never registered a webhook, so this one does.
    expect(fakeServer.registeredWebhooks).toHaveLength(1);
  });

  test("a board another host created is adopted without a second webhook", async () => {
    // The same repo on another host created and wired the board first.
    fakeServer.projectIdByKey.set("REPO", 7);
    fakeServer.descriptionByKey.set("REPO", "PROJ");
    fakeServer.webhooksById.set(3, {
      id: 3,
      projectId: 7,
      url: "http://100.123.36.124:6767/api/itsaplan/webhook",
      events: [],
      isActive: true,
    });
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({ itsaplanProjectKey: "REPO", itsaplanProjectId: 7 });
    expect(mapping?.webhookId).toBeUndefined();
    expect(fakeServer.registeredWebhooks).toHaveLength(0);
  });

  test("a host maps a repo to its existing board even when the derived key differs", async () => {
    // The board was created long ago under a key today's derivation no longer
    // produces (AMBIENTAISTA vs AMBIENTAIS); it must still be the one used.
    fakeServer.projectIdByKey.set("REPOLEGACY", 4);
    fakeServer.descriptionByKey.set("REPOLEGACY", "PROJ");
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({ itsaplanProjectKey: "REPOLEGACY", itsaplanProjectId: 4 });
    expect(fakeServer.createdProjects).toHaveLength(0);
  });

  test("a mapping to a later duplicate board moves to the oldest board for the project", async () => {
    fakeServer.projectIdByKey.set("REPOLEGACY", 4);
    fakeServer.descriptionByKey.set("REPOLEGACY", "PROJ");
    fakeServer.projectIdByKey.set("REPO", 40);
    fakeServer.descriptionByKey.set("REPO", "PROJ");
    await store.upsert({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 40,
      itsaplanProjectKey: "REPO",
      createdAt: "2026-10-18T00:00:00.000Z",
    });
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({ itsaplanProjectKey: "REPOLEGACY", itsaplanProjectId: 4 });
    expect(store.getByItsaplanProjectId(40)).toBeNull();
    expect(store.getByPaseoProjectKey("PROJ")?.itsaplanProjectId).toBe(4);
  });

  test("a board deleted in itsaplan is forgotten and never recreated", async () => {
    const first = await ensureItsaplanProjectMapping(project(), deps);
    expect(first?.itsaplanProjectKey).toBe("REPO");
    // Deleted by hand in itsaplan.
    fakeServer.projectIdByKey.delete("REPO");
    fakeServer.descriptionByKey.delete("REPO");

    await runItsaplanProjectResync([{ ...project(), archivedAt: null }], deps);

    expect(store.getByPaseoProjectKey("PROJ")).toBeNull();
    expect(fakeServer.createdProjects).toHaveLength(1);
    const reloaded = new ItsaplanProjectStore({ paseoHome, logger: createTestLogger() });
    await reloaded.initialize();
    expect(reloaded.isBoardDeleted("PROJ")).toBe(true);
    expect(await ensureItsaplanProjectMapping(project(), { ...deps, store: reloaded })).toBeNull();
  });

  test("a same-named project on another host gets a deterministic suffixed key", async () => {
    // Two hosts each have a project called "experiments": itsaplan enforces
    // project_key_unique globally, so the second must NOT share or adopt the
    // first's board — it falls back to EXPERI<hash-of-its-own-key>.
    const first = await ensureItsaplanProjectMapping(
      project({ projectId: "a", projectKey: "host:a/experiments", displayName: "experiments" }),
      deps,
    );
    const second = await ensureItsaplanProjectMapping(
      project({ projectId: "b", projectKey: "host:b/experiments", displayName: "experiments" }),
      deps,
    );
    expect(first?.itsaplanProjectKey).toBe("EXPERIMENT");
    expect(second?.itsaplanProjectKey).toMatch(/^EXPERI[0-9A-F]{4}$/);
    expect(second?.itsaplanProjectKey).not.toBe(first?.itsaplanProjectKey);
    expect(second?.paseoProjectKey).toBe("host:b/experiments");
    expect(fakeServer.createdProjects.map((p) => p.key)).toHaveLength(2);
  });

  test("a foreign manual board squatting the derived key is not adopted either", async () => {
    fakeServer.projectIdByKey.set("REPO", 9);
    fakeServer.descriptionByKey.set("REPO", ""); // created manually, no paseo stamp
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping?.itsaplanProjectKey).toMatch(/^REPO[0-9A-F]{4}$/);
    expect(mapping?.itsaplanProjectId).not.toBe(9);
  });

  test("attachItsaplanProjectSync maps a project on a registry upsert mutation", async () => {
    let listener:
      | ((mutation: {
          kind: "upsert" | "archive" | "remove";
          projectId: string;
          project: PersistedProjectRecord | null;
        }) => void)
      | null = null;
    const unsubscribe = attachItsaplanProjectSync(
      {
        subscribeToMutations: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
      deps,
    );
    listener?.({ kind: "upsert", projectId: "proj-1", project: project() });
    await vi.waitFor(() => {
      expect(store.getByPaseoProjectKey("PROJ")).not.toBeNull();
    });
    unsubscribe();
  });

  test("does nothing when a project has no projectKey", async () => {
    const mapping = await ensureItsaplanProjectMapping(project({ projectKey: null }), deps);
    expect(mapping).toBeNull();
    expect(fakeServer.createdProjects).toHaveLength(0);
  });

  test("does nothing when itsaplan config is absent", async () => {
    const mapping = await ensureItsaplanProjectMapping(project(), {
      ...deps,
      getConfig: () => null,
    });
    expect(mapping).toBeNull();
    expect(fakeServer.createdProjects).toHaveLength(0);
  });

  test("defers mapping while the daemon has no reachable webhook URL yet", async () => {
    const mapping = await ensureItsaplanProjectMapping(project(), {
      ...deps,
      getWebhookUrl: () => null,
    });
    expect(mapping).toBeNull();
    expect(fakeServer.createdProjects).toHaveLength(0);
    expect(store.getByPaseoProjectKey("PROJ")).toBeNull();
  });

  test("uses configured commanderUsername for createAiAgent and for 409 conflict recovery", async () => {
    fakeServer.aiAgents.enabled = true;

    // 1. Creation path: configured username is passed to createAiAgent
    const customUsername = "verify-custom-runner";
    const customConfig: ItsaplanCentralConfig = {
      ...config,
      commanderUsername: customUsername,
    };
    const mapping = await ensureItsaplanProjectMapping(project(), {
      ...deps,
      getConfig: () => customConfig,
    });
    expect(mapping?.commanderUsername).toBe(customUsername);
    expect(fakeServer.createdAiAgents).toContainEqual(
      expect.objectContaining({
        username: customUsername,
        projectKey: "REPO",
      }),
    );

    // 2. Conflict lookup path: 409 on create triggers listAiAgents and finds agent by configured username
    const conflictUsername = "verify-conflict-agent";
    fakeServer.agentsByProjectKey["OTHER"] = [
      {
        id: 99,
        username: conflictUsername,
        userId: `user-${conflictUsername}`,
        apiKey: "initial-key",
      },
      // Default "commander" also present to verify we match configured username, not default
      {
        id: 100,
        username: "commander",
        userId: "user-commander",
        apiKey: "commander-key",
      },
    ];
    const conflictConfig: ItsaplanCentralConfig = {
      ...config,
      commanderUsername: conflictUsername,
    };
    const otherProject = project({
      projectId: "proj-2",
      projectKey: "PROJ-OTHER",
      displayName: "Other",
    });
    const conflictMapping = await ensureItsaplanProjectMapping(otherProject, {
      ...deps,
      getConfig: () => conflictConfig,
    });
    expect(conflictMapping?.commanderUsername).toBe(conflictUsername);
    expect(conflictMapping?.commanderAgentId).toBe(99);
    expect(conflictMapping?.commanderApiKey).toBe("itp_agent_regen_99");
  });
});

describe("deriveItsaplanProjectKey", () => {
  test("always yields a key itsaplan accepts", () => {
    for (const name of [
      "video-understanding",
      "2048-game",
      "paseo",
      "Ambient AI / StackMod",
      "--",
    ]) {
      expect(deriveItsaplanProjectKey(name)).toMatch(/^[A-Z][A-Z0-9]{0,9}$/);
    }
    expect(deriveItsaplanProjectKey("video-understanding")).toBe("VIDEOUNDER");
    expect(deriveItsaplanProjectKey("2048-game")).toBe("P2048GAME");
  });
});

describe("resolveItsaplanConfig", () => {
  const central: ItsaplanCentralConfig = {
    baseUrl: "http://10.7.0.1:3000",
    apiKey: "itp_key",
    webhookSecret: "whsec",
    webBaseUrl: "http://10.7.0.1:3001",
  };

  test("this host's declaration beats the replicated fleet value", () => {
    expect(resolveItsaplanConfig(central, "https://itsaplan.internal:8443")).toMatchObject({
      baseUrl: "http://10.7.0.1:3000",
      webBaseUrl: "https://itsaplan.internal:8443",
    });
  });

  test("keeps the fleet value when this host declares nothing", () => {
    expect(resolveItsaplanConfig(central, undefined)?.webBaseUrl).toBe("http://10.7.0.1:3001");
    expect(resolveItsaplanConfig(central, "   ")?.webBaseUrl).toBe("http://10.7.0.1:3001");
  });

  test("stays null when the bridge is unconfigured, whatever the host declares", () => {
    expect(resolveItsaplanConfig(null, "https://itsaplan.internal:8443")).toBeNull();
  });
});

describe("ensureTodoColumnNoCommanderAutoAssign", () => {
  let fakeServer: ReturnType<typeof startFakeItsaplanServer>;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let client: ItsaplanClient;

  beforeEach(async () => {
    fakeServer = startFakeItsaplanServer("itp_test_key");
    handle = await listen(fakeServer.server);
    config = { baseUrl: handle.baseUrl, apiKey: "itp_test_key", webhookSecret: "whsec_test" };
    client = new ItsaplanClient(config);
    fakeServer.projectIdByKey.set("ENG", 1);
    fakeServer.columnsByProjectKey.set("ENG", [
      { id: 10, projectId: 1, name: "Backlog", stateType: "backlog" },
      {
        id: 11,
        projectId: 1,
        name: "Todo",
        stateType: "unstarted",
        autoAssignUserId: "bot-user-42",
      },
      { id: 12, projectId: 1, name: "In Progress", stateType: "started" },
    ]);
  });

  afterEach(async () => {
    await handle.close();
  });

  test("clears autoAssignUserId on Todo column when set to the commander bot user", async () => {
    await ensureTodoColumnNoCommanderAutoAssign("ENG", "bot-user-42", client, createTestLogger());
    const cols = fakeServer.columnsByProjectKey.get("ENG");
    const todoCol = cols?.find((c) => c.name === "Todo");
    expect(todoCol?.autoAssignUserId).toBeNull();
  });

  test("leaves autoAssignUserId alone when not set to the commander bot user", async () => {
    const cols = fakeServer.columnsByProjectKey.get("ENG")!;
    cols.find((c) => c.name === "Todo")!.autoAssignUserId = "human-vaibhav";
    await ensureTodoColumnNoCommanderAutoAssign("ENG", "bot-user-42", client, createTestLogger());
    expect(cols.find((c) => c.name === "Todo")?.autoAssignUserId).toBe("human-vaibhav");
  });

  test("safely no-ops when no unstarted column exists", async () => {
    fakeServer.columnsByProjectKey.set("ENG", [
      { id: 10, projectId: 1, name: "Backlog", stateType: "backlog" },
    ]);
    await expect(
      ensureTodoColumnNoCommanderAutoAssign("ENG", "bot-user-42", client, createTestLogger()),
    ).resolves.toBeUndefined();
  });
});

describe("isEligibleForItsaplanBoard", () => {
  const home = "/data/.paseo";

  test("rejects temporary directories", () => {
    expect(isEligibleForItsaplanBoard("/tmp", home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/tmp/scratch", home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/private/tmp", home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/private/tmp/sub", home)).toBe(false);
  });

  test("rejects verify runs and proof directories derived from paseoHome or structural markers", () => {
    expect(isEligibleForItsaplanBoard("/data/.paseo/verify-runs/v-1/repo", home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/data/.dev/verify/run/repo", home)).toBe(false);
    expect(isEligibleForItsaplanBoard(join(home, "verify-runs", "v-2"), home)).toBe(false);
    expect(isEligibleForItsaplanBoard(join(home, "verify-proofs", "proof-2"), home)).toBe(false);
  });

  test("rejects home directories and paseoHome", () => {
    expect(isEligibleForItsaplanBoard(home, home)).toBe(false);
    expect(isEligibleForItsaplanBoard(join(home, "commander"), home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/home/ubuntu", home)).toBe(false);
    expect(isEligibleForItsaplanBoard("/Users/vaibhav", home)).toBe(false);
  });

  test("accepts real codebases and experiments", () => {
    expect(isEligibleForItsaplanBoard("/data/paseo", home)).toBe(true);
    expect(isEligibleForItsaplanBoard("/data/experiments", home)).toBe(true);
    expect(isEligibleForItsaplanBoard("/home/ubuntu/experiments", home)).toBe(true);
    expect(isEligibleForItsaplanBoard("/data/projects/flotilla", home)).toBe(true);
  });
});
