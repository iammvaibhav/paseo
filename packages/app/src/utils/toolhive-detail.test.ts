import { describe, expect, it } from "vitest";
import { parseToolHiveToolCallDetail } from "./toolhive-detail";

// Shapes captured from real omp agents calling ToolHive (`xd://mcp__toolhive_*`):
// `content` holds the tool's text plus omp's fenced copy of the structured content,
// `details.rawContent` holds the MCP content as the server sent it.
function mcpOutput(text: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text", text },
      { type: "text", text: "```json\n{}\n```" },
    ],
    details: {
      serverName: "toolhive",
      rawContent: [{ type: "text", text }],
      ...extra,
    },
  };
}

describe("parseToolHiveToolCallDetail", () => {
  it("shows a search's query and the tools it returned, required parameters first", () => {
    const tools = [
      {
        name: "paseo-memory_search",
        description: "One search over everything the fleet remembers.",
        annotations: { title: "Search fleet memory" },
        inputSchema: {
          properties: { limit: { type: "integer" }, query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const model = parseToolHiveToolCallDetail(
      {
        type: "unknown",
        input: { tool_description: "search fleet memory", tool_keywords: ["memory", "search"] },
        output: mcpOutput(JSON.stringify({ tools }), {
          structuredContent: { tools, token_metrics: { savings_percent: 99.1 } },
        }),
      },
      "mcp__toolhive_find_tool",
    );
    expect(model).toEqual({
      op: "find",
      query: "search fleet memory",
      keywords: ["memory", "search"],
      savingsPercent: 99.1,
      result: null,
      tools: [
        {
          key: "0:paseo-memory_search",
          name: { full: "paseo-memory_search", server: "paseo", tool: "memory_search" },
          title: "Search fleet memory",
          description: "One search over everything the fleet remembers.",
          params: [
            { name: "query", required: true, type: "string" },
            { name: "limit", required: false, type: "integer" },
          ],
        },
      ],
    });
  });

  it("parses a Paseo tool's summary header and JSON body", () => {
    const model = parseToolHiveToolCallDetail(
      {
        type: "unknown",
        input: { tool_name: "paseo-fleet_list_agents", parameters: { limit: 2 }, reason: "probe" },
        output: mcpOutput('agents_count=1\nagents_ids=a1\n\n{\n  "agents": [{ "id": "a1" }]\n}'),
      },
      "mcp__toolhive_call_tool",
    );
    expect(model).toEqual({
      op: "call",
      tool: { full: "paseo-fleet_list_agents", server: "paseo", tool: "fleet_list_agents" },
      reason: "probe",
      parameters: { limit: 2 },
      result: {
        header: [
          { key: "agents_count", value: "1" },
          { key: "agents_ids", value: "a1" },
        ],
        value: { agents: [{ id: "a1" }] },
        isJson: true,
        isError: false,
      },
    });
  });

  it("parses JSON nested inside string fields", () => {
    const inner = JSON.stringify({ workflow: { id: "w1", active: true } });
    const model = parseToolHiveToolCallDetail(
      {
        type: "unknown",
        input: { tool_name: "n8n-get_workflow", parameters: { id: "w1" }, reason: "read it" },
        output: mcpOutput(JSON.stringify({ text: inner })),
      },
      "mcp__toolhive_call_tool",
    );
    expect(model?.result?.value).toEqual({ text: { workflow: { id: "w1", active: true } } });
  });

  it("parses each Paseo result a script returned", () => {
    const model = parseToolHiveToolCallDetail(
      {
        type: "unknown",
        input: { reason: "two lookups", script: "return parallel([lambda: a(), lambda: b()])" },
        output: mcpOutput(JSON.stringify(['hits_count=0\n\n{"hits": []}', "plain words"])),
      },
      "mcp__toolhive_execute_tool_script",
    );
    expect(model).toMatchObject({
      op: "script",
      reason: "two lookups",
      script: "return parallel([lambda: a(), lambda: b()])",
      result: { value: [{ hits: [] }, "plain words"], isJson: true },
    });
  });

  it("marks ToolHive failures as errors", () => {
    const model = parseToolHiveToolCallDetail(
      {
        type: "unknown",
        input: { tool_name: "n8n-search_projects", parameters: {}, reason: "find project" },
        output: mcpOutput(
          "Tool execution failed: failed to establish ephemeral MCP connection: unexpected end of JSON input",
          { isError: true },
        ),
      },
      "mcp__toolhive_call_tool",
    );
    expect(model?.result).toMatchObject({ isJson: false, isError: true });
  });

  it("shows the arguments of a call that is still running", () => {
    const model = parseToolHiveToolCallDetail(
      { type: "unknown", input: { tool_description: "slack mentions" }, output: null },
      "mcp__toolhive_find_tool",
    );
    expect(model).toEqual({
      op: "find",
      query: "slack mentions",
      keywords: [],
      tools: [],
      result: null,
    });
  });
});
