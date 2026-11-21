import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import pino from "pino";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";

import { MemoryService } from "../../../memory/service.js";
import { createProviderSnapshotManagerStub } from "../../../test-utils/session-stubs.js";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import { createPaseoToolCatalog } from "../../tools/paseo-tools.js";
import type { PaseoToolCatalog, PaseoToolDefinition, PaseoToolResult } from "../../tools/types.js";
import {
  handleOmpHostToolRuntimeEvent,
  OmpHostToolRouter,
  serializeOmpHostTools,
} from "./host-tools.js";
import type { OmpRpcHostToolResult } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

function createCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name) => toolMap.get(name),
    executeTool: async (name, input, context = {}) => {
      const tool = toolMap.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return await tool.handler(input, context);
    },
  };
}

class OmpHostToolHarness {
  private readonly logger = pino({ level: "silent" });
  private resolveControlledResult: ((result: PaseoToolResult) => void) | null = null;
  private controlledSignal: AbortSignal | null = null;
  private resolveControlledStart: (() => void) | null = null;
  private readonly controlledStart = new Promise<void>((resolve) => {
    this.resolveControlledStart = resolve;
  });
  private readonly router: OmpHostToolRouter;

  private constructor(
    private readonly catalog: PaseoToolCatalog,
    private readonly runtimeSession: Awaited<ReturnType<FakeOmp["startSession"]>>,
  ) {
    this.router = new OmpHostToolRouter({ runtimeSession, catalog, logger: this.logger });
  }

  static async withTools(tools: PaseoToolDefinition[]): Promise<OmpHostToolHarness> {
    const omp = new FakeOmp();
    const runtimeSession = await omp.startSession({ cwd: "/workspace/project" });
    return new OmpHostToolHarness(createCatalog(tools), runtimeSession);
  }

  static async cancellable(): Promise<OmpHostToolHarness> {
    let harness: OmpHostToolHarness;
    const tool: PaseoToolDefinition = {
      name: "wait_for_agent",
      description: "Wait for a Paseo agent.",
      handler: async (_input, context) => {
        harness.controlledSignal = context.signal ?? null;
        harness.resolveControlledStart?.();
        return await new Promise<PaseoToolResult>((resolve) => {
          harness.resolveControlledResult = resolve;
        });
      },
    };
    harness = await OmpHostToolHarness.withTools([tool]);
    return harness;
  }

  async call(input: {
    id: string;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<OmpRpcHostToolResult> {
    const result = this.runtimeSession.nextHostToolResult();
    handleOmpHostToolRuntimeEvent(
      { type: "host_tool_call", ...input },
      this.router,
      this.runtimeSession,
      this.logger,
    );
    return await result;
  }

  startControlledCall(): void {
    handleOmpHostToolRuntimeEvent(
      {
        type: "host_tool_call",
        id: "host-cancel",
        toolCallId: "tool-cancel",
        toolName: "wait_for_agent",
        arguments: { agentId: "child-1" },
      },
      this.router,
      this.runtimeSession,
      this.logger,
    );
  }

  async waitForControlledCall(): Promise<void> {
    await this.controlledStart;
  }

  cancelControlledCall(): void {
    handleOmpHostToolRuntimeEvent(
      { type: "host_tool_cancel", id: "cancel-1", targetId: "host-cancel" },
      this.router,
      this.runtimeSession,
      this.logger,
    );
  }

  completeControlledCall(result: PaseoToolResult): void {
    if (!this.resolveControlledResult) throw new Error("Controlled host tool has not started");
    this.resolveControlledResult(result);
  }

  async waitForIdle(): Promise<void> {
    await this.router.waitForIdle();
  }

  wasControlledCallAborted(): boolean {
    return this.controlledSignal?.aborted === true;
  }

  updates() {
    return this.runtimeSession.hostToolUpdates;
  }

  results() {
    return this.runtimeSession.hostToolResults;
  }

  close(): void {
    this.router.clear();
  }
}

describe("OMP host tools", () => {
  test("keeps the everyday Paseo tools top-level and the rest on demand", () => {
    const catalog = createCatalog([
      {
        name: "report_status",
        title: "Report status",
        description: "Report status.",
        inputSchema: { headline: z.string().describe("Headline.") },
        handler: async () => ({ content: [] }),
      },
      {
        name: "browser_list_tabs",
        description: "List browser tabs.",
        handler: async () => ({ content: [] }),
      },
    ]);

    expect(serializeOmpHostTools(catalog)).toEqual([
      {
        name: "report_status",
        label: "Report status",
        description: "Report status.",
        loadMode: "essential",
        parameters: expect.objectContaining({ type: "object", required: ["headline"] }),
      },
      {
        name: "browser_list_tabs",
        description: "List browser tabs.",
        loadMode: "discoverable",
        parameters: expect.objectContaining({ type: "object" }),
      },
    ]);
  });

  test("routes calls and progress through the typed OMP runtime", async () => {
    const omp = await OmpHostToolHarness.withTools([
      {
        name: "create_agent",
        description: "Create a Paseo agent.",
        handler: async (input, context) => {
          context.sendUpdate?.({ content: [{ type: "text", text: "creating" }] });
          return { content: [], structuredContent: { input, agentId: "child-1" } };
        },
      },
    ]);

    await expect(
      omp.call({
        id: "host-1",
        toolCallId: "tool-1",
        toolName: "create_agent",
        arguments: { initialPrompt: "Inspect the bug" },
      }),
    ).resolves.toEqual({
      type: "host_tool_result",
      id: "host-1",
      result: {
        content: [{ type: "text", text: expect.stringContaining('"agentId": "child-1"') }],
        details: { input: { initialPrompt: "Inspect the bug" }, agentId: "child-1" },
      },
    });
    expect(omp.updates()).toEqual([
      {
        type: "host_tool_update",
        id: "host-1",
        partialResult: { content: [{ type: "text", text: "creating" }] },
      },
    ]);
  });

  test("cancels an in-flight host tool and drops its late result", async () => {
    const omp = await OmpHostToolHarness.cancellable();

    omp.startControlledCall();
    await omp.waitForControlledCall();
    omp.cancelControlledCall();
    omp.completeControlledCall({ content: [{ type: "text", text: "late" }] });
    await omp.waitForIdle();

    expect(omp.wasControlledCallAborted()).toBe(true);
    expect(omp.results()).toEqual([]);
    expect(omp.updates()).toEqual([]);
    omp.close();
  });
});

const MEMORY_CALLER_ID = "agent-memory";

interface FleetMemoryRequest {
  method: string;
  path: string;
  body: unknown;
}

const FLEET_MEMORY_RESPONSES: Record<string, unknown> = {
  "POST /v1/search": { hits: [{ id: "note:memory-tools", title: "Memory tools" }] },
  "GET /v1/doc/note:memory-tools": {
    id: "note:memory-tools",
    text: "Memory tools load top-level.",
  },
  "POST /v1/notes": { id: "note:memory-tools", updated: true },
};

/** Stands in for the fleet-memory service behind `memory.url` and records what reaches it. */
async function startFleetMemory() {
  const requests: FleetMemoryRequest[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const route = `${request.method} ${request.url}`;
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      });
      const body = FLEET_MEMORY_RESPONSES[route];
      response.statusCode = body === undefined ? 404 : 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body ?? { error: `no route ${route}` }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

/** The catalog the daemon builds for an omp agent on a host with fleet-memory configured. */
function createMemoryToolCatalog(
  memoryUrl: string,
  paseoToolPolicy?: ProviderPaseoToolsPolicy,
): PaseoToolCatalog {
  const logger = pino({ level: "silent" });
  return createPaseoToolCatalog({
    agentManager: { getPluginTools: () => [] } as unknown as AgentManager,
    agentStorage: {
      get: async (agentId: string) =>
        agentId === MEMORY_CALLER_ID ? { id: agentId, name: "Memory worker" } : null,
      listAll: async () => [],
    } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    memoryService: new MemoryService({
      paseoHome: "/tmp/paseo-omp-memory-test",
      logger,
      getMemoryUrl: () => memoryUrl,
      hostLabel: () => "dev",
    }),
    hostAlias: "dev",
    callerAgentId: MEMORY_CALLER_ID,
    paseoToolPolicy,
    logger,
  });
}

async function callHostTool(
  omp: OmpHarness,
  toolName: string,
  args: Record<string, unknown>,
): Promise<OmpRpcHostToolResult> {
  const runtime = omp.runtime();
  const result = runtime.nextHostToolResult();
  runtime.emit({
    type: "host_tool_call",
    id: `call-${toolName}`,
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: args,
  });
  return await result;
}

/** An omp session whose host tools come from a memory-enabled catalog, torn down after the test. */
async function startMemorySession(paseoToolPolicy?: ProviderPaseoToolsPolicy) {
  const memory = await startFleetMemory();
  onTestFinished(() => memory.close());
  const omp = new OmpHarness();
  await omp.start({}, createMemoryToolCatalog(memory.url, paseoToolPolicy));
  onTestFinished(() => omp.close());
  return { omp, memory };
}

describe("OMP fleet memory host tools", () => {
  test("a new session gets the memory tools top-level with their schemas", async () => {
    const { omp } = await startMemorySession();

    const registered = omp.registeredHostTools();
    expect(registered).toHaveLength(1);
    const tools = new Map(registered[0]!.map((tool) => [tool.name, tool]));
    expect(tools.get("memory_search")).toMatchObject({
      label: "Search fleet memory",
      loadMode: "essential",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: expect.objectContaining({ type: "string" }),
          kinds: expect.objectContaining({ type: "array" }),
          byAgent: expect.objectContaining({ type: "boolean" }),
        },
      },
    });
    expect(tools.get("memory_get")).toMatchObject({
      label: "Read one memory item",
      loadMode: "essential",
      parameters: { type: "object", required: ["id"] },
    });
    expect(tools.get("memory_write")).toMatchObject({
      label: "Write to fleet memory",
      loadMode: "essential",
      parameters: { type: "object", required: ["title", "body", "kind"] },
    });
    // Only the everyday tools load top-level. The rest of the catalog, including the other
    // fleet-memory tool, stays on demand.
    expect(
      [...tools.values()]
        .filter((tool) => tool.loadMode === "essential")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["fleet_move_agent", "memory_get", "memory_search", "memory_write", "report_status"]);
    expect(tools.get("fleet_playbook")?.loadMode).toBe("discoverable");
  });

  test("memory calls from omp reach fleet-memory as the calling agent", async () => {
    const { omp, memory } = await startMemorySession();

    const search = await callHostTool(omp, "memory_search", {
      query: "memory tools",
      byAgent: true,
      limit: 3,
    });
    const read = await callHostTool(omp, "memory_get", { id: "note:memory-tools" });
    const write = await callHostTool(omp, "memory_write", {
      title: "Memory tools load top-level",
      body: "omp agents call memory_search directly.",
      kind: "decision",
    });

    expect(search).toMatchObject({
      type: "host_tool_result",
      id: "call-memory_search",
      result: { details: { ok: true, hits: [{ id: "note:memory-tools", title: "Memory tools" }] } },
    });
    expect(read).toMatchObject({
      id: "call-memory_get",
      result: { details: { ok: true, text: "Memory tools load top-level." } },
    });
    expect(write).toMatchObject({
      id: "call-memory_write",
      result: { details: { ok: true, id: "note:memory-tools", updated: true } },
    });
    expect([search, read, write].map((result) => result.isError)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(memory.requests).toEqual([
      {
        method: "POST",
        path: "/v1/search",
        body: { query: "memory tools", limit: 3, group_by_agent: true },
      },
      { method: "GET", path: "/v1/doc/note:memory-tools", body: undefined },
      {
        method: "POST",
        path: "/v1/notes",
        body: {
          title: "Memory tools load top-level",
          body: "omp agents call memory_search directly.",
          kind: "decision",
          tags: [],
          about: {},
          source: { agent_id: MEMORY_CALLER_ID, agent_name: "Memory worker", host: "dev" },
        },
      },
    ]);
  });

  test("a memory tool the provider policy disables is neither offered nor callable", async () => {
    const { omp, memory } = await startMemorySession({ disabledTools: ["memory_write"] });

    const names = omp.registeredHostTools()[0]!.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["memory_search", "memory_get"]));
    expect(names).not.toContain("memory_write");
    await expect(
      callHostTool(omp, "memory_write", { title: "Not allowed", body: "No.", kind: "note" }),
    ).resolves.toMatchObject({
      isError: true,
      result: { content: [{ type: "text", text: "Paseo tool not found: memory_write" }] },
    });
    expect(memory.requests).toEqual([]);
  });
});
