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
  ensureItsaplanProjectMapping,
  ItsaplanProjectStore,
  runItsaplanProjectResync,
  type ItsaplanCentralConfig,
  type ItsaplanFleetProjectCandidate,
  type ItsaplanProjectSyncDependencies,
} from "./projects.js";

function startFakeItsaplanServer(apiKey: string) {
  const createdProjects: Array<{ key: string; name: string }> = [];
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
      const webhooksMatch = /^\/projects\/([^/]+)\/webhooks$/.exec(url.pathname);
      if (req.method === "POST" && url.pathname === "/projects") {
        const key = String(body.key);
        // Mirrors real itsaplan: project keys are unique — a duplicate is a 409.
        if (projectIdByKey.has(key)) {
          send(409, { error: "duplicate key" });
          return;
        }
        const created = { id: nextProjectId++, key, name: String(body.name) };
        projectIdByKey.set(key, created.id);
        createdProjects.push({ key: created.key, name: created.name });
        send(201, created);
        return;
      }
      const projectMatch = /^\/projects\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && projectMatch) {
        const projectKey = decodeURIComponent(projectMatch[1]);
        const id = projectIdByKey.get(projectKey);
        if (!id) {
          send(404, { error: "Project not found" });
          return;
        }
        // Live itsaplan answers GET /projects/:key with the nested scaffold.
        send(200, { project: { id, key: projectKey, name: `name-${id}` } });
        return;
      }
      if (req.method === "POST" && webhooksMatch) {
        const projectKey = decodeURIComponent(webhooksMatch[1]);
        const webhook = {
          projectKey,
          url: String(body.url),
          events: body.events as string[],
          // Mirrors real itsaplan: any client-supplied secret is IGNORED and
          // a server-generated one is returned in the response body.
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
        return;
      }
      if (req.method === "GET" && webhooksMatch) {
        const projectKey = decodeURIComponent(webhooksMatch[1]);
        const projectId = projectIdByKey.get(projectKey);
        send(
          200,
          Array.from(webhooksById.values()).filter((w) => w.projectId === projectId),
        );
        return;
      }
      const webhookPatchMatch = /^\/webhooks\/(\d+)$/.exec(url.pathname);
      if (req.method === "PATCH" && webhookPatchMatch) {
        const webhook = webhooksById.get(Number(webhookPatchMatch[1]));
        if (!webhook) {
          send(404, { error: "not found" });
          return;
        }
        Object.assign(webhook, body);
        send(200, webhook);
        return;
      }
      send(404, { error: `unhandled ${req.method} ${url.pathname}` });
    });
  });

  return { server, createdProjects, registeredWebhooks, webhooksById, projectIdByKey };
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
      isDesignatedSyncHost: () => true,
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
      itsaplanProjectKey: "PROJ",
      createdAt: expect.any(String),
      // Read back from itsaplan's response — itsaplan ignores client secrets.
      webhookSecret: "whsec_generated_1",
      webhookId: 1,
    });
    expect(fakeServer.createdProjects).toEqual([{ key: "PROJ", name: "Repo" }]);
    expect(fakeServer.registeredWebhooks).toEqual([
      {
        projectKey: "PROJ",
        url: "http://127.0.0.1:9999/api/itsaplan/webhook",
        events: ["issue.state_changed", "comment.created"],
        clientSentSecret: false,
      },
    ]);
    expect(store.getByPaseoProjectKey("PROJ")).toEqual(mapping);
    expect(store.getByItsaplanProjectId(1)).toEqual(mapping);
  });

  test("is idempotent: a second call makes no further itsaplan API calls", async () => {
    await ensureItsaplanProjectMapping(project(), deps);
    await ensureItsaplanProjectMapping(project(), deps);
    expect(fakeServer.createdProjects).toHaveLength(1);
    expect(fakeServer.registeredWebhooks).toHaveLength(1);
  });

  test("patches comment.created onto an existing webhook registered before it existed", async () => {
    // A mapping written before webhookId was persisted (old registration
    // carrying only the issue event): sync must find our webhook by URL,
    // PATCH the missing event, and backfill webhookId onto the mapping.
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
      "issue.state_changed",
      "comment.created",
    ]);
    expect(updated?.webhookId).toBe(1);
    expect(store.getByPaseoProjectKey("PROJ")?.webhookId).toBe(1);
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

    const result = await runItsaplanProjectResync({ local: projects, fleet: null }, deps);
    expect(result).toEqual({ mapped: 2, skipped: 1, failed: 0 });
    expect(fakeServer.createdProjects.map((p) => p.key).sort()).toEqual(["AAA", "BBB"]);
    expect(store.list()).toHaveLength(2);

    // Idempotent re-run: the same sweep creates nothing new.
    await runItsaplanProjectResync({ local: projects, fleet: null }, deps);
    expect(fakeServer.createdProjects).toHaveLength(2);
    expect(fakeServer.registeredWebhooks).toHaveLength(2);
  });

  test("resync is inert on a non-designated sync host", async () => {
    const result = await runItsaplanProjectResync(
      { local: [project()], fleet: [{ hostName: "macbook", projectKey: "MAC", name: "Mac" }] },
      { ...deps, isDesignatedSyncHost: () => false },
    );
    expect(result).toEqual({ mapped: 0, skipped: 0, failed: 0 });
    expect(fakeServer.createdProjects).toHaveLength(0);
    expect(
      await ensureItsaplanProjectMapping(project(), {
        ...deps,
        isDesignatedSyncHost: () => false,
      }),
    ).toBeNull();
  });

  test("fleet candidates dedupe by projectKey: a repo on two hosts maps once", async () => {
    // paseo checked out on two hosts shares the cross-host remote key.
    const fleet: ItsaplanFleetProjectCandidate[] = [
      { hostName: "local", projectKey: "remote:github.com/iammvaibhav/paseo", name: "paseo" },
      { hostName: "macbook", projectKey: "remote:github.com/iammvaibhav/paseo", name: "paseo-dev" },
      { hostName: "macbook", projectKey: "MAC:/Users/vaibhav", name: "MacBook" },
    ];
    const result = await runItsaplanProjectResync({ local: [], fleet }, deps);
    expect(result).toEqual({ mapped: 2, skipped: 1, failed: 0 });
    expect(fakeServer.createdProjects.map((p) => p.key).sort()).toEqual([
      "MAC:/Users/vaibhav",
      "remote:github.com/iammvaibhav/paseo",
    ]);
  });

  test("a create-key 409 adopts the existing itsaplan project instead of failing", async () => {
    fakeServer.projectIdByKey.set("PROJ", 7); // pre-existing row, store knows nothing
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({
      paseoProjectKey: "PROJ",
      itsaplanProjectId: 7,
      itsaplanProjectKey: "PROJ",
    });
    expect(fakeServer.createdProjects).toHaveLength(0);
    expect(store.getByPaseoProjectKey("PROJ")?.itsaplanProjectId).toBe(7);
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
});
