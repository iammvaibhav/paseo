import { describe, expect, it } from "vitest";
import { parseWebSearchToolCallDetail } from "./web-search-detail";

describe("parseWebSearchToolCallDetail", () => {
  it("returns null for non-web search details", () => {
    expect(
      parseWebSearchToolCallDetail({
        type: "search",
        query: "import React",
        toolName: "grep",
      }),
    ).toBeNull();
  });

  it("parses canonical search detail with web_search toolName", () => {
    const result = parseWebSearchToolCallDetail({
      type: "search",
      query: "Gemini 3.6 Flash",
      toolName: "web_search",
      content: "Found results",
    });

    expect(result).toEqual({
      query: "Gemini 3.6 Flash",
      content: "Found results",
      webResults: undefined,
      annotations: undefined,
    });
  });

  it("parses unknown detail for web_search call with intent and query", () => {
    const result = parseWebSearchToolCallDetail(
      {
        type: "unknown",
        input: {
          i: "Search Gemini 3.6 Flash vs DeepSeek Flash comparison benchmarks",
          query: '"Gemini 3.6 Flash" "DeepSeek" comparison benchmark Artificial Analysis',
        },
        output: [
          {
            type: "text",
            text: "Here's a concise take on the topic you mentioned.\n\nAnswer...",
          },
        ],
      },
      "web_search",
    );

    expect(result).toEqual({
      query: '"Gemini 3.6 Flash" "DeepSeek" comparison benchmark Artificial Analysis',
      intent: "Search Gemini 3.6 Flash vs DeepSeek Flash comparison benchmarks",
      content: "Here's a concise take on the topic you mentioned.\n\nAnswer...",
    });
  });

  it("parses unknown detail containing webResults array in output", () => {
    const result = parseWebSearchToolCallDetail(
      {
        type: "unknown",
        input: { query: "OpenAI latest news" },
        output: {
          results: [
            {
              title: "OpenAI Announcement",
              url: "https://openai.com/blog/1",
              snippet: "New model release",
            },
          ],
        },
      },
      "web_search",
    );

    expect(result).toEqual({
      query: "OpenAI latest news",
      webResults: [
        {
          title: "OpenAI Announcement",
          url: "https://openai.com/blog/1",
          snippet: "New model release",
        },
      ],
    });
  });
});
