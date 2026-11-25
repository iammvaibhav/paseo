import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createPaseoToolCatalog } from "../../tools/paseo-tools.js";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import { OpenCodeBridge } from "./bridge.js";
import { createWorkspaceScriptsService } from "../../../session/workspace-scripts/workspace-scripts-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../../../workspace-registry.js";
import { createServiceProxySubsystem } from "../../../service-proxy.js";
import { WorkspaceScriptRuntimeStore } from "../../../workspace-script-runtime-store.js";
import { createTerminalManager } from "../../../../terminal/terminal-manager.js";
import { createTestAgentMessages } from "../../../test-utils/agent-messages.js";

test("bridge preserves tool failure messages and classifies invalid requests as client errors", async () => {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-7045-"));
  const logger = createTestLogger();
  const providerSnapshotManager = new ProviderSnapshotManager({ logger });
  const agentManager = new AgentManager({ logger });
  const agentStorage = new AgentStorage(paseoHome, logger);
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected workspace or agent creation");
  };
  const workspaceScripts = createWorkspaceScriptsService({
    serviceProxy: createServiceProxySubsystem({ logger }),
    scriptRuntimeStore: new WorkspaceScriptRuntimeStore(),
    terminalManager: createTerminalManager(),
    workspaceRegistry: new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "workspaces.json"),
      logger,
    ),
    projectRegistry: new FileBackedProjectRegistry(path.join(paseoHome, "projects.json"), logger),
    workspaceRuntimeStore: {
      get: () => {
        throw new Error("Unexpected git lookup");
      },
    },
    getDaemonTcpPort: null,
    getDaemonTcpHost: null,
    serviceProxyPublicBaseUrl: null,
    resolveScriptHealth: null,
    getGlobalServicePorts: async () => undefined,
    logger,
    emit: () => {},
    publishStatusUpdate: () => {},
    spawnWorkspaceScript: unused,
    assertAutomationAllowed: unused,
  });
  const agentMessages = createTestAgentMessages({ agentManager, agentStorage, logger });
  const catalog = createPaseoToolCatalog({
    workspaceScripts,
    agentManager,
    agentStorage,
    agentMessages: () => agentMessages,
    providerSnapshotManager,
    logger,
  });
  const bridge = new OpenCodeBridge({ paseoHome, logger });
  try {
    await bridge.start();
    bridge.setManifestCatalog(catalog);
    bridge.bindSession({ sessionId: "diagnosis", env: {}, tools: catalog });
    const config = JSON.parse(bridge.decorateServerEnv({}).OPENCODE_CONFIG_CONTENT);
    const { baseUrl, token } = config.plugin[0][1];
    const manifest = await fetch(`${baseUrl}/_internal/opencode/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { tools } = await manifest.json();
    expect(
      tools.find((tool: { name: string }) => tool.name === "create_agent").inputSchema.properties,
    ).toHaveProperty("background");
    const observed = [];
    for (const [tool, body, expected] of [
      [
        "create_agent",
        JSON.stringify({ title: "Probe", provider: "opencode", initialPrompt: "Reply OK" }),
        400,
      ],
      ["create_agent", "{", 400],
      ["nonexistent_tool", "{}", 404],
      ["send_agent_prompt", JSON.stringify({ agentId: "missing", prompt: "Hello" }), 400],
      ["list_workspace_scripts", JSON.stringify({ workspaceId: "wks_typo" }), 500],
      [
        "start_workspace_script",
        JSON.stringify({ workspaceId: "wks_typo", scriptName: "web" }),
        500,
      ],
    ] as const) {
      const response = await fetch(
        `${baseUrl}/_internal/opencode/sessions/diagnosis/tools/${tool}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
        },
      );
      observed.push({
        tool,
        body,
        expected,
        status: response.status,
        payload: await response.json(),
      });
    }

    for (const result of observed) expect.soft(result.status, result.body).toBe(result.expected);
    for (const result of observed.slice(4)) {
      expect.soft(result.payload).toEqual({ error: "Workspace not found: wks_typo" });
    }
    expect.soft(observed[3].payload).toEqual({ error: "Agent not found: missing" });
    expect(observed[0].payload).toMatchObject({
      error: "Invalid tool input",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["provider"],
          message: expect.stringContaining("provider/model"),
        }),
      ]),
    });
  } finally {
    await agentMessages.close();
    await bridge.close();
    await providerSnapshotManager.shutdown();
    await rm(paseoHome, { recursive: true, force: true });
  }
});
