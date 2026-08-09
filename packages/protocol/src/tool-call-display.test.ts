import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel } from "./tool-call-display.js";

describe("shared tool-call display mapping", () => {
  it("builds summary from canonical detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      status: "running",
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

  it("does not infer summaries from unknown raw detail", () => {
    const display = buildToolCallDisplayModel({
      name: "exec_command",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: { command: "npm test" },
        output: null,
      },
    });

    expect(display).toEqual({
      displayName: "Exec Command",
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

  it("builds display model for worktree setup detail", () => {
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
            log: "==> [1/1] Running: npm install\n",
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

  it("provides errorText for failed calls", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "failed",
      error: { message: "boom" },
      detail: {
        type: "unknown",
        input: null,
        output: null,
      },
    });

    expect(display.errorText).toBe('{\n  "message": "boom"\n}');
  });

  it("labels terminal interaction rows without a summary when no command is available", () => {
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

  it("uses the command as terminal interaction summary when available", () => {
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

  it("humanizes Paseo MCP tool names (Claude Code format)", () => {
    const display = buildToolCallDisplayModel({
      name: "mcp__paseo__create_agent",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    expect(display.displayName).toBe("Spawned subagent");
  });

  it("humanizes Paseo MCP tool names (Codex format)", () => {
    const display = buildToolCallDisplayModel({
      name: "paseo.create_agent",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    expect(display.displayName).toBe("Spawned subagent");
  });

  it("humanizes list_agents Paseo tool", () => {
    const display = buildToolCallDisplayModel({
      name: "mcp__paseo__list_agents",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    expect(display.displayName).toBe("List Agents");
  });

  it("does not override speak tool display name", () => {
    const display = buildToolCallDisplayModel({
      name: "speak",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    expect(display.displayName).toBe("Speak");
  });

  it("labels plan detail rows as Plan", () => {
    const display = buildToolCallDisplayModel({
      name: "plan",
      status: "completed",
      error: null,
      detail: {
        type: "plan",
        text: "### Login Screen\n- Build layout",
      },
    });

    expect(display).toEqual({
      displayName: "Plan",
    });
  });

  it("summarizes eval with the cell title", () => {
    const display = buildToolCallDisplayModel({
      name: "eval",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: { language: "py", code: "print(1)", title: "load config" },
        output: null,
      },
    });
    expect(display).toEqual({ displayName: "Eval", summary: "load config" });
  });

  it("falls back to the first code line when an eval cell has no title", () => {
    const display = buildToolCallDisplayModel({
      name: "eval",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { language: "js", code: "\n\n  await Bun.file('x').text()\n" },
        output: null,
      },
    });
    expect(display.summary).toBe("await Bun.file('x').text()");
  });
  it("builds Web Search display for search detail with web_search toolName", () => {
    const display = buildToolCallDisplayModel({
      name: "web_search",
      status: "completed",
      error: null,
      detail: {
        type: "search",
        query: "Gemini 3.6 Flash",
        toolName: "web_search",
      },
    });
    expect(display).toEqual({ displayName: "Web Search", summary: "Gemini 3.6 Flash" });
  });

  it("builds Web Search display for unknown detail matching web_search", () => {
    const display = buildToolCallDisplayModel({
      name: "web_search",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { i: "Search comparison", query: "Gemini 3.6 Flash vs DeepSeek" },
        output: null,
      },
    });
    expect(display).toEqual({ displayName: "Web Search", summary: "Gemini 3.6 Flash vs DeepSeek" });
  });
  it("resolves host=local to resolved alias for fleet_create_agent and fleet_send_prompt", () => {
    const resolveHost = (h: string) => (h === "local" ? "vaibhav-dev" : h);
    const createDisplay = buildToolCallDisplayModel({
      name: "fleet_create_agent",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "local", provider: "codex/gpt-5.4" },
        output: { details: { agentId: "worker-1" } },
      },
      resolveHost,
    });
    expect(createDisplay.displayName).toBe("Spawned worker-1 on vaibhav-dev");

    const sendDisplay = buildToolCallDisplayModel({
      name: "fleet_send_prompt",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "local", agentId: "worker-1", prompt: "hello" },
        output: null,
      },
      resolveHost,
    });
    expect(sendDisplay.displayName).toBe("→ Steered worker-1 (vaibhav-dev)");
  });

  it("labels create_agent (the subagent spawn form) with the subagent type word", () => {
    const display = buildToolCallDisplayModel({
      name: "create_agent",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { provider: "codex/gpt-5.4", initialPrompt: "fix it" },
        output: { details: { agentId: null } },
      },
    });
    expect(display.displayName).toBe("Spawned subagent");
  });

  it("never doubles the type word when the resolved name already says it", () => {
    const doubledName = buildToolCallDisplayModel({
      name: "create_agent",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { provider: "codex/gpt-5.4" },
        output: { details: { agentId: "child-9" } },
      },
      agentNames: { "child-9": "subagent" },
    });
    expect(doubledName.displayName).toBe("Spawned subagent");

    const fleetDoubled = buildToolCallDisplayModel({
      name: "fleet_create_agent",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { host: "work" },
        output: { details: { agentId: "agent-9" } },
      },
      agentNames: { "agent-9": "agent" },
    });
    expect(fleetDoubled.displayName).toBe("Spawned agent on work");
  });
});
