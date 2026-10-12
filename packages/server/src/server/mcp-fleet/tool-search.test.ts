import { describe, expect, test, vi } from "vitest";
import {
  classifyTool,
  computeLexicalScore,
  CORE_FLEET_TOOL_NAMES,
  META_FLEET_TOOL_NAMES,
  searchCatalogTools,
} from "./tool-search.js";
import type { PaseoToolCatalog, PaseoToolDefinition } from "../agent/tools/types.js";

function createMockTool(name: string, description: string): PaseoToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ content: [] }),
  };
}

describe("classifyTool", () => {
  test("classifies tools into the expected groups", () => {
    expect(classifyTool("ticket_list")).toBe("tickets");
    expect(classifyTool("fleet_move_agent")).toBe("meta");
    expect(classifyTool("fleet_cancel_agent")).toBe("control");
    expect(classifyTool("cancel_agent")).toBe("control");
    expect(classifyTool("history_search")).toBe("history");
    expect(classifyTool("list_models")).toBe("models");
    expect(classifyTool("clarify")).toBe("mission_control");
    expect(classifyTool("create_agent")).toBe("dispatch");
    expect(classifyTool("list_workspaces")).toBe("agents_read");
    expect(classifyTool("something_unknown")).toBe("other");
  });
});

describe("computeLexicalScore", () => {
  test("ranks fleet_move_agent highly for move query", () => {
    const moveScore = computeLexicalScore(
      "fleet_move_agent",
      "Move an agent to another workspace or host",
      "move an agent to another host",
    );
    const cancelScore = computeLexicalScore(
      "fleet_cancel_agent",
      "Abort the agent current run",
      "move an agent to another host",
    );
    expect(moveScore).toBeGreaterThan(cancelScore);
    expect(moveScore).toBeGreaterThan(20);
  });
});

describe("searchCatalogTools", () => {
  const toolsMap = new Map<string, PaseoToolDefinition>([
    ["fleet_list_inventory", createMockTool("fleet_list_inventory", "List inventory (core)")],
    ["fleet_move_agent", createMockTool("fleet_move_agent", "Move an agent to another host")],
    ["fleet_cancel_agent", createMockTool("fleet_cancel_agent", "Cancel an agent session")],
    ["fleet_archive_project", createMockTool("fleet_archive_project", "Archive a project")],
    ["ticket_update", createMockTool("ticket_update", "Update a ticket")],
    ["paseo_tool_search", createMockTool("paseo_tool_search", "Search tools (meta)")],
  ]);

  const mockCatalog: PaseoToolCatalog = {
    tools: toolsMap,
    getTool: (name) => toolsMap.get(name),
    executeTool: async () => ({ content: [] }),
  };

  test("excludes core and meta tools from search results", async () => {
    const results = await searchCatalogTools({
      catalog: mockCatalog,
      query: "all",
      limit: 10,
    });

    const names = results.map((r) => r.name);
    for (const core of CORE_FLEET_TOOL_NAMES) {
      expect(names).not.toContain(core);
    }
    for (const meta of META_FLEET_TOOL_NAMES) {
      expect(names).not.toContain(meta);
    }
  });

  test("lexical fallback finds fleet_move_agent for 'move an agent to another host' with jev disabled", async () => {
    const results = await searchCatalogTools({
      catalog: mockCatalog,
      query: "move an agent to another host",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("fleet_move_agent");
    expect(results[0]?.description).toBe("Move an agent to another host");
    expect(results[0]?.inputSchema).toBeDefined();
  });

  test("uses jev probabilities when available", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answers: {
          tool_group: {
            choice: "meta",
            probabilities: {
              meta: 0.9,
              control: 0.05,
              tickets: 0.05,
            },
          },
        },
      }),
    })) as unknown as typeof fetch;

    const results = await searchCatalogTools({
      catalog: mockCatalog,
      query: "relocate an agent",
      typesafeApiKey: "test-key",
      fetchImpl,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("fleet_move_agent");
  });
});
