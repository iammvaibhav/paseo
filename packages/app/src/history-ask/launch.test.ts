import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHistoryAskTitle, launchHistoryAsk } from "./launch";
import { resolveWorkspaceScope } from "./scope";

vi.mock("@/create-agent-preferences/service", () => ({
  createAgentPreferencesService: {
    load: vi.fn(async () => ({
      provider: "claude",
      providerPreferences: {
        claude: { model: "claude-sonnet-4" },
      },
    })),
  },
}));

describe("buildHistoryAskTitle", () => {
  it("prefixes and truncates the question", () => {
    expect(buildHistoryAskTitle("  short  ")).toBe("Ask: short");
    const long = "x".repeat(80);
    const title = buildHistoryAskTitle(long);
    expect(title.startsWith("Ask: ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(5 + 50);
  });
});

describe("launchHistoryAsk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a labeled allow-all agent with brief", async () => {
    const createAgent = vi.fn(async () => ({ id: "agt_1" }));
    const getProvidersSnapshot = vi.fn(async () => ({
      entries: [
        {
          provider: "claude",
          status: "ready" as const,
          enabled: true,
          modes: [
            { id: "default", label: "Default" },
            { id: "bypassPermissions", label: "Bypass" },
          ],
        },
      ],
      generatedAt: new Date().toISOString(),
      requestId: "req_1",
    }));

    const scope = resolveWorkspaceScope({
      serverId: "srv_1",
      workspaceId: "ws_1",
      cwd: "/Users/vaibhav/paseo",
      displayName: "paseo",
      projectId: "prj_1",
    });

    const result = await launchHistoryAsk({
      client: {
        createAgent: createAgent as never,
        getProvidersSnapshot: getProvidersSnapshot as never,
      },
      scope,
      question: "Where did we add webhooks?",
    });

    expect(result).toEqual({ agentId: "agt_1", serverId: "srv_1" });
    expect(createAgent).toHaveBeenCalledTimes(1);
    const call = createAgent.mock.calls.at(0)?.at(0) as
      | {
          config: {
            provider: string;
            cwd: string;
            modeId: string;
            model?: string;
            title: string;
          };
          workspaceId?: string;
          labels: Record<string, string>;
          initialPrompt: string;
          internal?: boolean;
        }
      | undefined;
    expect(call).toBeTruthy();
    if (!call) {
      throw new Error("expected createAgent call");
    }
    expect(call.config.provider).toBe("claude");
    expect(call.config.cwd).toBe("/Users/vaibhav/paseo");
    expect(call.config.modeId).toBe("bypassPermissions");
    expect(call.config.model).toBe("claude-sonnet-4");
    expect(call.config.title).toContain("Ask:");
    expect(call.workspaceId).toBe("ws_1");
    expect(call.labels["paseo.history-ask"]).toBe("1");
    expect(call.labels["paseo.history-ask.scope"]).toBe("workspace");
    expect(call.initialPrompt).toContain("History Ask");
    expect(call.initialPrompt).toContain("Where did we add webhooks?");
    expect(call.internal).toBeUndefined();
  });

  it("rejects empty question", async () => {
    await expect(
      launchHistoryAsk({
        client: {
          createAgent: vi.fn() as never,
          getProvidersSnapshot: vi.fn() as never,
        },
        scope: resolveWorkspaceScope({
          serverId: "srv_1",
          workspaceId: "ws_1",
          cwd: "/repo",
        }),
        question: "  ",
      }),
    ).rejects.toThrow(/question/i);
  });
});
