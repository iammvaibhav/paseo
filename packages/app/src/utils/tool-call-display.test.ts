import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel } from "./tool-call-display";

describe("tool-call-display", () => {
  it("builds display model from canonical shell detail", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "running",
      error: null,
      detail: {
        type: "shell",
        command: "npm test",
      },
    });

    expect(display).toEqual({
      displayName: "Shell",
      summary: "npm test",
    });
  });

  it("builds display model from canonical read detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      status: "completed",
      error: null,
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts",
      },
      cwd: "/tmp/repo",
    });

    expect(display).toEqual({
      displayName: "Read",
      summary: "src/index.ts",
    });
  });

  it("uses sub-agent detail for task label and description", () => {
    const display = buildToolCallDisplayModel({
      name: "task",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        log: "[Read] README.md",
      },
    });

    expect(display).toEqual({
      displayName: "Explore",
      summary: "Inspect repository structure",
    });
  });

  it("falls back to humanized tool name for unknown tools", () => {
    const display = buildToolCallDisplayModel({
      name: "custom_tool_name",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: null,
        output: null,
      },
    });

    expect(display).toEqual({
      displayName: "Custom Tool Name",
    });
  });

  it("builds display model from worktree setup detail", () => {
    const display = buildToolCallDisplayModel({
      name: "paseo_worktree_setup",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath: "/tmp/repo/.paseo/worktrees/repo/branch",
        branchName: "feature-branch",
        log: "==> [1/1] Running: npm install\n",
        commands: [
          {
            index: 1,
            command: "npm install",
            cwd: "/tmp/repo/.paseo/worktrees/repo/branch",
            log: "",
            status: "running",
            exitCode: null,
          },
        ],
      },
    });

    expect(display).toEqual({
      displayName: "Worktree Setup",
      summary: "feature-branch",
    });
  });

  it("does not derive command summary from unknown raw detail", () => {
    const display = buildToolCallDisplayModel({
      name: "exec_command",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: { command: "npm run test" },
        output: null,
      },
    });

    expect(display).toEqual({
      displayName: "Exec Command",
    });
  });

  it("returns formatted errorText from the same display pipeline", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "failed",
      error: { message: "boom" },
      detail: {
        type: "unknown",
        input: { command: "false" },
        output: null,
      },
    });

    expect(display.errorText).toBe('{\n  "message": "boom"\n}');
  });

  it("shows terminal interaction with only the fixed label when no command is available", () => {
    const display = buildToolCallDisplayModel({
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        icon: "square_terminal",
      },
    });

    expect(display).toEqual({
      displayName: "Terminal",
    });
  });

  it("shows terminal interaction command as the summary when available", () => {
    const display = buildToolCallDisplayModel({
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        label: "npm run test",
        icon: "square_terminal",
      },
    });

    expect(display).toEqual({
      displayName: "Terminal",
      summary: "npm run test",
    });
  });

  it("pretty-renders fleet_send_prompt with live agent name and host", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_send_prompt",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "macbook", agentId: "agent-1", prompt: "steer the turn" },
        output: { content: [], details: { success: true } },
      },
      agentNames: { "agent-1": "Docs Smoke" },
    });

    expect(display.displayName).toBe("→ Steered Docs Smoke (macbook)");
  });

  it("falls back to agentId when no live name is known for fleet_send_prompt", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_send_prompt",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "local", agentId: "agent-9", prompt: "hello" },
        output: null,
      },
    });

    expect(display.displayName).toBe("→ Steered agent-9 (local)");
  });

  it("pretty-renders fleet_list_agents with the roster count", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_list_agents",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { limit: 50 },
        output: {
          content: [],
          details: {
            agents: [
              { id: "a", name: "Alpha" },
              { id: "b", name: "Beta" },
            ],
          },
        },
      },
    });

    expect(display.displayName).toBe("Checked fleet roster · 2 agents");
  });

  it("pretty-renders fleet_create_agent with name and host once the id resolves", () => {
    const running = buildToolCallDisplayModel({
      name: "fleet_create_agent",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "work", provider: "anthropic/claude", initialPrompt: "fix it" },
        output: null,
      },
    });
    expect(running.displayName).toBe("Spawned agent on work");

    const done = buildToolCallDisplayModel({
      name: "fleet_create_agent",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "work", provider: "anthropic/claude", initialPrompt: "fix it" },
        output: { content: [], details: { agentId: "agent-7" } },
      },
      agentNames: { "agent-7": "Bug Hunter" },
    });
    expect(done.displayName).toBe("Spawned Bug Hunter on work");
  });

  it("failed fleet dispatches read as failed: truncated error summary + full errorText", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_create_agent",
      status: "failed",
      error: "Provider anthropic is not configured. Configure a provider in Settings → Providers.",
      detail: {
        type: "unknown",
        input: { host: "work", provider: "anthropic/claude", initialPrompt: "fix it" },
        output: null,
      },
    });
    // Identity is kept, the summary line carries the error (truncated at
    // 100 chars), and the full message stays available as errorText.
    expect(display.displayName).toBe("Spawned agent on work");
    expect(display.summary).toBe(
      "Failed: Provider anthropic is not configured. Configure a provider in Settings → Providers.",
    );
    expect(display.errorText).toBe(
      "Provider anthropic is not configured. Configure a provider in Settings → Providers.",
    );
  });

  it("failed fleet dispatches still read as failed when the error is short", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_send_prompt",
      status: "failed",
      error: "schema rejected",
      detail: {
        type: "unknown",
        input: { host: "local", agentId: "agent-1" },
        output: { content: [], details: {} },
      },
    });
    expect(display.displayName).toBe("→ Steered agent-1 (local)");
    expect(display.summary).toBe("Failed: schema rejected");
    expect(display.errorText).toBe("schema rejected");
  });

  it("pretty-renders fleet_search with query and match count", () => {
    const display = buildToolCallDisplayModel({
      name: "fleet_search",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { query: "auth" },
        output: {
          content: [],
          details: { matches: [{ host: "local", name: "Auth Fix" }] },
        },
      },
    });

    expect(display.displayName).toBe('Searched fleet: "auth" · 1 matches');
  });

  it("labels tag_message for verbose mode", () => {
    const display = buildToolCallDisplayModel({
      name: "tag_message",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { agentIds: ["a", "b", "c"] },
        output: { content: [], details: { recorded: true } },
      },
    });

    expect(display.displayName).toBe("Tagged 3 agents");
  });

  it("keeps namespaced fleet tool names pretty", () => {
    const display = buildToolCallDisplayModel({
      name: "mcp__paseo__fleet_send_prompt",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "macbook", agentId: "agent-1", prompt: "hi" },
        output: null,
      },
    });

    expect(display.displayName).toBe("→ Steered agent-1 (macbook)");
  });
});
